import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	CLEANUP_GUARD_MARKER,
	cleanupGuardMessage,
	diffDelta,
	diffLooksMajor,
	gitChangeSnapshot,
	looksFileMutatingCommand,
	type GitChangeSnapshot,
} from "./harness-commands/cleanup-guard";
import { applyMode, modeDescription, modeInstructions, modeNames } from "./harness-commands/modes";
import {
	cleanupReminder,
	classifyPrompt,
	DISPLAY_MATH_RENDERING_INSTRUCTION,
	isCodingOrFilePrompt,
	MARKDOWN_HEADING_RENDERING_INSTRUCTION,
	promptSuggestsMajorCleanup,
	skillRoutingReminder,
} from "./harness-commands/prompt-guidance";
import { registerSkillsAuditCommand } from "./harness-commands/skills-audit-command";
import { buildDoctor, buildStatus } from "./harness-commands/status";
import { createAgentsTaskLayer } from "./harness-commands/task-layer";
import { buildMemorySpineDiagnostics, formatMemorySpineDiagnostics } from "./session-continuity/diagnostics";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export default function harnessCommands(pi: ExtensionAPI) {
	const taskLayer = createAgentsTaskLayer();
	let activeMode: string | undefined;
	let sawFileMutation = false;
	let currentPromptIsCleanupGuard = false;
	let currentPromptNeedsCleanup = false;
	let currentPromptWasMajor = false;
	let initialChangeSnapshot: GitChangeSnapshot | undefined;
	pi.registerCommand("mode", {
		description: "Switch harness mode: fast, default, deep, readonly, full",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			return modeNames()
				.filter((name) => name.startsWith(p))
				.map((name) => ({ value: name, label: name, description: modeDescription(name) }));
		},
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				const lines = ["## Available harness modes", ...modeNames().map((name) => `- ${name}: ${modeDescription(name)}`)];
				pi.sendMessage({ customType: "harness-mode", content: lines.join("\n"), display: true });
				return;
			}
			if (!modeNames().includes(requested)) {
				ctx.ui.notify(`Unknown mode: ${requested}. Available: ${modeNames().join(", ")}`, "error");
				return;
			}
			await applyMode(requested, pi, ctx);
			activeMode = requested;
		},
	});
	pi.registerCommand("status", {
		description: "Show current harness, model, tool, context, git, audit, memory, and task status",
		handler: async (_args, ctx) => {
			pi.sendMessage({ customType: "harness-status", content: await buildStatus(pi, ctx, taskLayer), display: true });
		},
	});
	pi.registerCommand("doctor", {
		description: "Run a read-only harness health check with memory-spine and AGENTS task diagnostics",
		handler: async (_args, ctx) => {
			pi.sendMessage({ customType: "harness-doctor", content: await buildDoctor(pi, ctx, taskLayer), display: true });
		},
	});
	pi.registerCommand("doct", {
		description: "Alias for /doctor",
		handler: async (_args, ctx) => {
			pi.sendMessage({ customType: "harness-doctor", content: await buildDoctor(pi, ctx, taskLayer), display: true });
		},
	});
	pi.registerCommand("memory", {
		description: "Show memory-spine checkpoint and compaction diagnostics",
		handler: async (_args, ctx) => {
			const content = formatMemorySpineDiagnostics(buildMemorySpineDiagnostics(ctx.sessionManager.getBranch()), { verbose: true });
			pi.sendMessage({ customType: "harness-memory", content, display: true });
		},
	});
	pi.registerCommand("checkpoint", {
		description: "Create a visible session checkpoint with current harness status",
		handler: async (args, ctx) => {
			const label = args.trim() || new Date().toISOString().replace(/[:.]/g, "-");
			const leafId = ctx.sessionManager.getLeafId();
			if (leafId) pi.setLabel(leafId, `checkpoint: ${label}`);
			const content = [`## Checkpoint: ${label}`, await buildStatus(pi, ctx, taskLayer), "", "Next-step note:", args.trim() || "None provided."].join(
				"\n",
			);
			pi.sendMessage({ customType: "harness-checkpoint", content, display: true, details: { label } });
			ctx.ui.notify(`Checkpoint created: ${label}`, "info");
		},
	});
	registerSkillsAuditCommand(pi, PACKAGE_ROOT);
	pi.on("session_start", async (_event, ctx) => {
		await taskLayer.sessionStart(pi, ctx);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const fallbackWeight = classifyPrompt(event.prompt);
		sawFileMutation = false;
		currentPromptIsCleanupGuard = event.prompt.includes(CLEANUP_GUARD_MARKER);
		currentPromptNeedsCleanup = isCodingOrFilePrompt(event.prompt);
		initialChangeSnapshot = currentPromptNeedsCleanup ? await gitChangeSnapshot(pi, ctx.cwd) : undefined;
		const taskContext = await taskLayer.beforeAgentStart(pi, event.prompt, fallbackWeight, ctx);
		const weight = taskLayer.currentPromptWeight();
		currentPromptWasMajor = promptSuggestsMajorCleanup(event.prompt, weight);
		const additions: string[] = [DISPLAY_MATH_RENDERING_INSTRUCTION, MARKDOWN_HEADING_RENDERING_INSTRUCTION];
		const activeModeInstructions = modeInstructions(activeMode);
		if (activeModeInstructions) additions.push(activeModeInstructions);
		const reminder = skillRoutingReminder(weight);
		if (reminder) additions.push(reminder);
		const cleanup = cleanupReminder(event.prompt, weight);
		if (cleanup) additions.push(cleanup);
		if (taskContext) additions.push(taskContext);
		if (!additions.length) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` };
	});
	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			sawFileMutation = true;
			return;
		}
		if (event.toolName === "bash" && looksFileMutatingCommand(String((event.input as { command?: unknown }).command ?? ""))) {
			sawFileMutation = true;
		}
	});
	pi.on("tool_result", async (event, ctx) => {
		await taskLayer.toolResult(pi, event, ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		await taskLayer.agentEnd(pi, ctx);
		if (currentPromptIsCleanupGuard || !sawFileMutation || !currentPromptNeedsCleanup) return;
		const currentSnapshot = await gitChangeSnapshot(pi, ctx.cwd);
		if (!currentSnapshot || currentSnapshot.signature === initialChangeSnapshot?.signature) return;
		const changedStats = diffDelta(initialChangeSnapshot?.stats, currentSnapshot.stats);
		if (!currentPromptWasMajor && !diffLooksMajor(changedStats)) return;
		pi.sendUserMessage(cleanupGuardMessage(changedStats, currentPromptWasMajor), { deliverAs: "followUp" });
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		await taskLayer.sessionShutdown(pi, ctx);
	});
}
