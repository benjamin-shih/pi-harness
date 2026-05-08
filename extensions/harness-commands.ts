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
import { buildControlCenterState, formatControlCenter, openControlCenterHtml, startControlCenterWeb, stopControlCenterWeb, type ControlCenterOptions } from "./shared/control-center";
import { forgetMemory, promoteMemory, rememberCandidate } from "./shared/memory-admin";
import { buildOrchestrationRouteState, formatRunCard, type OrchestrationRouteState } from "./shared/orchestration-guidance";
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
	let lastOrchestrationRoute: OrchestrationRouteState | undefined;
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
		description: "Show memory diagnostics; use `/memory review`, `/memory review global`, or `/memory help` for explicit admin flow",
		handler: async (args, ctx) => {
			pi.sendMessage({ customType: "harness-memory", content: await buildMemoryReport(pi, ctx, taskLayer, args), display: true });
		},
	});
	pi.registerCommand("run-card", {
		description: "Show the latest orchestration run card, or route provided text without executing it",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const route = prompt ? await buildOrchestrationRouteState(pi, ctx.cwd, prompt) : lastOrchestrationRoute;
			const content = route ? formatRunCard(route) : ["## Run card", "- status: not assembled yet", "- hint: run a nontrivial turn first, or pass prompt text to `/run-card ...`"].join("\n");
			pi.sendMessage({ customType: "harness-run-card", content, display: true });
		},
	});
	const controlCenterOptions = (raw: string): { mode: "card" | "html" | "web" | "web-stop"; options: ControlCenterOptions } => {
		const tokens = raw.trim().split(/\s+/).filter(Boolean);
		let mode: "card" | "html" | "web" | "web-stop" = "card";
		if (tokens[0] === "html") { mode = "html"; tokens.shift(); }
		else if (tokens[0] === "web" && tokens[1] === "stop") { mode = "web-stop"; tokens.splice(0, 2); }
		else if (tokens[0] === "web") { mode = "web"; tokens.shift(); }
		let project = "";
		let projectRoot = "";
		const promptParts: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === "--project" && tokens[i + 1]) { project = tokens[++i]; continue; }
			if (token.startsWith("project:")) { project = token.slice("project:".length); continue; }
			if (token === "--project-root" && tokens[i + 1]) { projectRoot = tokens[++i]; continue; }
			promptParts.push(token);
		}
		const taskScope = taskLayer.ambientScope?.() ?? {};
		const prompt = promptParts.join(" ");
		const fallbackProjectRoot = !project && !projectRoot && !prompt ? taskScope.projectRoot : undefined;
		return { mode, options: { prompt, taskId: taskScope.taskId, project: project || undefined, projectRoot: projectRoot || fallbackProjectRoot || undefined } };
	};
	pi.registerCommand("control-center", {
		description: "Show the read-only local Agent Control Center; use `html`, `web`, or `--project harness`",
		handler: async (args, ctx) => {
			const { mode, options } = controlCenterOptions(args);
			if (mode === "web-stop") {
				const stopped = await stopControlCenterWeb();
				pi.sendMessage({ customType: "harness-control-center", content: ["## Agent Control Center web", `- stopped: ${stopped ? "yes" : "no active server"}`].join("\n"), display: true });
				return;
			}
			if (mode === "web") {
				const result = await startControlCenterWeb(pi, ctx.cwd, options);
				pi.sendMessage({ customType: "harness-control-center", content: ["## Agent Control Center web", `- url: ${result.url}`, `- opened: ${result.opened ? "yes" : "no"}`, ...(result.error ? [`- warning: ${result.error}`] : []), "- mode: read-only local web dashboard with refresh"].join("\n"), display: true });
				return;
			}
			if (mode === "html") {
				const result = await openControlCenterHtml(pi, ctx.cwd, options);
				const content = [
					"## Agent Control Center v0",
					`- html: ${result.path ? result.path : "not generated"}`,
					`- opened: ${result.opened ? "yes" : "no"}`,
					...(result.error ? [`- warning: ${result.error}`] : []),
					"- mode: read-only static dashboard",
				].join("\n");
				pi.sendMessage({ customType: "harness-control-center", content, display: true });
				return;
			}
			pi.sendMessage({ customType: "harness-control-center", content: formatControlCenter(await buildControlCenterState(pi, ctx.cwd, options)), display: true });
		},
	});
	pi.registerCommand("remember", {
		description: "Explicitly create a scoped candidate memory; use --task, --project, or --global",
		handler: async (args, ctx) => {
			pi.sendMessage({ customType: "harness-memory-admin", content: await rememberCandidate(pi, ctx, args, taskLayer.ambientScope?.() ?? {}), display: true });
		},
	});
	pi.registerCommand("promote-memory", {
		description: "Explicitly approve a candidate memory by id",
		handler: async (args, ctx) => {
			pi.sendMessage({ customType: "harness-memory-admin", content: await promoteMemory(pi, ctx, args), display: true });
		},
	});
	pi.registerCommand("forget-memory", {
		description: "Explicitly forget/deprecate a memory by id",
		handler: async (args, ctx) => {
			pi.sendMessage({ customType: "harness-memory-admin", content: await forgetMemory(pi, ctx, args), display: true });
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
		lastOrchestrationRoute = ambient.orchestrationRoute;
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
