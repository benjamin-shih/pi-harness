import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AmbientContextSnapshot } from "./shared/ambient-context";
import { buildAmbientTurn } from "./harness-commands/ambient-turn";
import {
	CLEANUP_GUARD_MARKER,
	cleanupGuardMessage,
	combineDiffStats,
	committedDiffStats,
	diffDelta,
	diffLooksMajor,
	gitChangeSnapshot,
	looksFileMutatingCommand,
	type GitChangeSnapshot,
} from "./harness-commands/cleanup-guard";
import { appendFinalVisibilityToAssistantMessage, type FinalVisibilityState } from "./shared/final-visibility";
import { applyMode, modeDescription, modeNames } from "./harness-commands/modes";
import { classifyPrompt, isCodingOrFilePrompt, promptSuggestsMajorCleanup } from "./shared/prompt-guidance";
import { isPiSubagentChild } from "./shared/runtime";
import { registerSkillsAuditCommand } from "./harness-commands/skills-audit-command";
import { buildDoctor, buildMemoryReport, buildStatus } from "./shared/harness-status";
import { createAgentsTaskLayer } from "./harness-commands/task-layer";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export default function harnessCommands(pi: ExtensionAPI) {
	if (isPiSubagentChild()) return;

	const taskLayer = createAgentsTaskLayer();
	let activeMode: string | undefined;
	let sawFileMutation = false;
	let currentPromptIsCleanupGuard = false;
	let currentPromptNeedsCleanup = false;
	let currentPromptWasMajor = false;
	let initialChangeSnapshot: GitChangeSnapshot | undefined;
	let lastAmbientContext: AmbientContextSnapshot | undefined;
	let finalVisibility: FinalVisibilityState | undefined;
	const refreshFinalVisibility = () => {
		finalVisibility = lastAmbientContext ? { ambient: lastAmbientContext, mode: activeMode, task: taskLayer.finalVisibility() } : undefined;
	};
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
	const sendDoctor = async (ctx: ExtensionContext) => {
		pi.sendMessage({ customType: "harness-doctor", content: await buildDoctor(pi, ctx, taskLayer, lastAmbientContext), display: true });
	};
	pi.registerCommand("status", {
		description: "Show a quick bounded harness, model, tool, context, git, memory, and task status",
		handler: async (_args, ctx) => {
			pi.sendMessage({ customType: "harness-status", content: await buildStatus(pi, ctx, taskLayer, lastAmbientContext), display: true });
		},
	});
	pi.registerCommand("doctor", {
		description: "Run a read-only harness health check with memory-spine and AGENTS task diagnostics",
		handler: async (_args, ctx) => sendDoctor(ctx),
	});
	pi.registerCommand("doct", {
		description: "Alias for /doctor",
		handler: async (_args, ctx) => sendDoctor(ctx),
	});
	pi.registerCommand("memory", {
		description: "Show memory-spine and scoped-memory API diagnostics",
		handler: async (_args, ctx) => {
			pi.sendMessage({ customType: "harness-memory", content: await buildMemoryReport(pi, ctx, taskLayer), display: true });
		},
	});
	pi.registerCommand("checkpoint", {
		description: "Create a visible session checkpoint with current harness status",
		handler: async (args, ctx) => {
			const label = args.trim() || new Date().toISOString().replace(/[:.]/g, "-");
			const leafId = ctx.sessionManager.getLeafId();
			if (leafId) pi.setLabel(leafId, `checkpoint: ${label}`);
			const content = [`## Checkpoint: ${label}`, await buildStatus(pi, ctx, taskLayer, lastAmbientContext), "", "Next-step note:", args.trim() || "None provided."].join(
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
		finalVisibility = undefined;
		const fallbackWeight = classifyPrompt(event.prompt);
		sawFileMutation = false;
		currentPromptIsCleanupGuard = event.prompt.includes(CLEANUP_GUARD_MARKER);
		currentPromptNeedsCleanup = isCodingOrFilePrompt(event.prompt);
		initialChangeSnapshot = currentPromptNeedsCleanup ? await gitChangeSnapshot(pi, ctx.cwd) : undefined;
		const taskContext = await taskLayer.beforeAgentStart(pi, event.prompt, fallbackWeight, ctx);
		const weight = taskLayer.currentPromptWeight();
		currentPromptWasMajor = promptSuggestsMajorCleanup(event.prompt, weight);
		const ambient = await buildAmbientTurn(pi, ctx, {
			baseSystemPrompt: event.systemPrompt,
			prompt: event.prompt,
			weight,
			activeMode,
			taskContext,
			taskScope: taskLayer.ambientScope(),
		});
		lastAmbientContext = ambient.snapshot;
		refreshFinalVisibility();
		return ambient.systemPrompt === event.systemPrompt ? undefined : { systemPrompt: ambient.systemPrompt };
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
		refreshFinalVisibility();
	});
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant" || event.message.stopReason === "toolUse") return;
		const message = appendFinalVisibilityToAssistantMessage(event.message, finalVisibility);
		return message === event.message ? undefined : { message };
	});
	pi.on("agent_end", async (_event, ctx) => {
		await taskLayer.agentEnd(pi, ctx);
		if (currentPromptIsCleanupGuard || !sawFileMutation || !currentPromptNeedsCleanup) return;
		const currentSnapshot = await gitChangeSnapshot(pi, ctx.cwd);
		if (!currentSnapshot || currentSnapshot.signature === initialChangeSnapshot?.signature) return;
		const uncommittedStats = diffDelta(initialChangeSnapshot?.stats, currentSnapshot.stats);
		const committedStats = await committedDiffStats(pi, ctx.cwd, initialChangeSnapshot?.head, currentSnapshot.head);
		const changedStats = combineDiffStats(uncommittedStats, committedStats);
		if (!currentPromptWasMajor && !diffLooksMajor(changedStats)) return;
		pi.sendUserMessage(cleanupGuardMessage(changedStats, currentPromptWasMajor), { deliverAs: "followUp" });
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		finalVisibility = undefined;
		await taskLayer.sessionShutdown(pi, ctx);
	});
}
