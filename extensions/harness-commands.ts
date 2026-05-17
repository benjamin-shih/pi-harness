import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AmbientContextSnapshot } from "./shared/ambient-context";
import { buildAmbientTurn } from "./harness-commands/ambient-turn";
import { registerCheckpointCommand } from "./harness-commands/checkpoint-command";
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
} from "./shared/cleanup-guard";
import { queueFollowUpAfterCurrentAgent } from "./shared/deferred-user-message";
import { appendFinalVisibilityToAssistantMessage, type FinalVisibilityState } from "./shared/final-visibility";
import { checkRemoteCiAfterPush, isGitPushCommand, remoteCiGuardBlock, type RemoteCiGuardResult } from "./shared/remote-ci-guard";
import { htmlArtifactPathFromTool, openHtmlArtifact } from "./shared/html-artifact-open";
import { largeResponseHtmlCompactionReminder } from "./shared/large-response-html";
import { applyMode, modeDescription, modeNames } from "./harness-commands/modes";
import { classifyPrompt, isCodingOrFilePrompt, promptSuggestsMajorCleanup } from "./shared/prompt-guidance";
import { isPiSubagentChild } from "./shared/runtime";
import { registerSkillsAuditCommand } from "./harness-commands/skills-audit-command";
import { registerInboxCommand } from "./harness-commands/inbox-command";
import { registerOrchestrateCommand } from "./harness-commands/orchestrate-command";
import { registerOrchestratorCommand } from "./harness-commands/orchestrator-command";
import { registerTaskCloseCommand } from "./harness-commands/task-close-command";
import { buildDoctor, buildMemoryReport, buildStatus } from "./shared/harness-status";
import { registerControlCenterCommand } from "./shared/control-center-command";
import { registerMemoryAdminCommands } from "./shared/memory-admin-command";
import { registerChooseTopologyCommand, registerRunCardCommand } from "./shared/orchestration-commands";
import type { OrchestrationDecisionState } from "./shared/orchestration-guidance";
import { createAgentsTaskLayer } from "./harness-commands/task-layer";
import { compactToolResultForContext, registerCompactToolOutput } from "./harness-commands/compact-tool-output";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export default function harnessCommands(pi: ExtensionAPI) {
	if (isPiSubagentChild()) return;

	registerCompactToolOutput(pi);
	const taskLayer = createAgentsTaskLayer();
	let activeMode: string | undefined;
	let sawFileMutation = false;
	let currentPromptIsCleanupGuard = false;
	let currentPromptNeedsCleanup = false;
	let currentPromptWasMajor = false;
	let pendingHtmlArtifacts = new Set<string>();
	let htmlArtifactsSeenThisSession = new Set<string>();
	let largeResponseHtmlGuidanceSeenThisSession = false;
	let initialChangeSnapshot: GitChangeSnapshot | undefined;
	let lastAmbientContext: AmbientContextSnapshot | undefined;
	let lastOrchestrationDecision: OrchestrationDecisionState | undefined;
	let finalVisibility: FinalVisibilityState | undefined;
	let sawGitPush = false;
	let remoteCiStatus: RemoteCiGuardResult | undefined;
	const refreshFinalVisibility = () => {
		finalVisibility = lastAmbientContext ? { ambient: lastAmbientContext, mode: activeMode, task: taskLayer.finalVisibility(), remoteCi: remoteCiStatus } : undefined;
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
	registerRunCardCommand(pi, taskLayer, () => lastOrchestrationDecision);
	registerControlCenterCommand(pi, taskLayer);
	registerChooseTopologyCommand(pi, taskLayer);
	registerMemoryAdminCommands(pi, taskLayer);
	registerInboxCommand(pi);
	registerOrchestrateCommand(pi);
	registerOrchestratorCommand(pi);
	registerCheckpointCommand(pi, taskLayer, () => lastAmbientContext);
	registerTaskCloseCommand(pi, taskLayer);
	registerSkillsAuditCommand(pi, PACKAGE_ROOT);
	pi.on("session_start", async (_event, ctx) => {
		await taskLayer.sessionStart(pi, ctx);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		finalVisibility = undefined;
		const fallbackWeight = classifyPrompt(event.prompt);
		sawFileMutation = false;
		sawGitPush = false;
		remoteCiStatus = undefined;
		currentPromptIsCleanupGuard = event.prompt.includes(CLEANUP_GUARD_MARKER);
		currentPromptNeedsCleanup = isCodingOrFilePrompt(event.prompt);
		pendingHtmlArtifacts = new Set<string>();
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
		largeResponseHtmlGuidanceSeenThisSession = largeResponseHtmlGuidanceSeenThisSession || ambient.snapshot.lanes.some((lane) => lane.id === "large_response_html" && lane.status === "included");
		lastOrchestrationDecision = ambient.orchestrationDecision;
		await taskLayer.recordOrchestrationRecommended(pi, ctx, ambient.orchestrationDecision?.decision);
		refreshFinalVisibility();
		return ambient.systemPrompt === event.systemPrompt ? undefined : { systemPrompt: ambient.systemPrompt };
	});
	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			sawFileMutation = true;
			return;
		}
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (looksFileMutatingCommand(command)) sawFileMutation = true;
			if (isGitPushCommand(command)) sawGitPush = true;
		}
	});
	pi.on("tool_result", async (event, ctx) => {
		await taskLayer.toolResult(pi, event, ctx);
		const htmlArtifact = htmlArtifactPathFromTool(event, ctx.cwd, lastOrchestrationDecision);
		if (htmlArtifact) {
			pendingHtmlArtifacts.add(htmlArtifact);
			htmlArtifactsSeenThisSession.add(htmlArtifact);
		}
		refreshFinalVisibility();
		return compactToolResultForContext(event, ctx.cwd);
	});
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant" || event.message.stopReason === "toolUse") return;
		if (sawGitPush && !remoteCiStatus) {
			remoteCiStatus = await checkRemoteCiAfterPush(pi, ctx.cwd);
			refreshFinalVisibility();
		}
		const remoteCiBlock = remoteCiGuardBlock(remoteCiStatus);
		const guardedMessage = remoteCiBlock ? { ...event.message, content: [...event.message.content, { type: "text" as const, text: `\n\n${remoteCiBlock}` }] } : event.message;
		const message = appendFinalVisibilityToAssistantMessage(guardedMessage, finalVisibility);
		return message === event.message ? undefined : { message };
	});
	pi.on("agent_end", async (_event, ctx) => {
		await taskLayer.agentEnd(pi, ctx);
		for (const htmlArtifact of pendingHtmlArtifacts) await openHtmlArtifact(pi, ctx, htmlArtifact);
		pendingHtmlArtifacts.clear();
		if (currentPromptIsCleanupGuard || !sawFileMutation || !currentPromptNeedsCleanup) return;
		const currentSnapshot = await gitChangeSnapshot(pi, ctx.cwd);
		if (!currentSnapshot || currentSnapshot.signature === initialChangeSnapshot?.signature) return;
		const uncommittedStats = diffDelta(initialChangeSnapshot?.stats, currentSnapshot.stats);
		const committedStats = await committedDiffStats(pi, ctx.cwd, initialChangeSnapshot?.head, currentSnapshot.head);
		const changedStats = combineDiffStats(uncommittedStats, committedStats);
		if (!currentPromptWasMajor && !diffLooksMajor(changedStats)) return;
		queueFollowUpAfterCurrentAgent(pi, cleanupGuardMessage(changedStats, currentPromptWasMajor));
	});
	pi.on("session_compact", async () => {
		const reminder = largeResponseHtmlCompactionReminder(htmlArtifactsSeenThisSession, largeResponseHtmlGuidanceSeenThisSession);
		if (!reminder) return;
		pi.sendMessage({ customType: "harness-html-artifact-continuity", content: reminder, display: false }, { deliverAs: "nextTurn" });
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		finalVisibility = undefined;
		htmlArtifactsSeenThisSession = new Set<string>();
		largeResponseHtmlGuidanceSeenThisSession = false;
		await taskLayer.sessionShutdown(pi, ctx);
	});
}
