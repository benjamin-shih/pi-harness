import { complete, type Message } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { isPiSubagentChild } from "../shared/runtime";
import { CHECKPOINT_TYPE, COMPACTION_SYSTEM_PROMPT, MIN_CHECKPOINT_INTERVAL_MS } from "./constants";
import {
	appendCompactionDiagnostic,
	buildCompactionDetails,
	buildPromptSizing,
	compactionPromptBudgetChars,
	fallbackCompaction,
	gitStatusSummary,
	notify,
	summaryTokenBudget,
	updateMemoryStatus,
} from "./compaction";
import {
	buildCheckpoint,
	buildLedger,
	checkpointHash,
	emptyTurnState,
	extractContinuityCheckpoints,
	isMeaningfulTurn,
	recordToolResult,
} from "./checkpoints";
import { buildContinuitySummaryPrompt, extractSummaryText } from "./prompts";
import { formatUnknownError, redactSensitiveText } from "./redaction";
import type { CompactionDiagnosticReason, ContinuityCheckpoint } from "./types";

export { extractContinuityCheckpoints, buildLedger } from "./checkpoints";
export { buildMemorySpineDiagnostics, extractContinuityCompactionDiagnostics, extractMemoryCompactions, formatMemorySpineDiagnostics } from "./diagnostics";
export { buildContinuitySummaryPrompt, buildDeterministicContinuitySummary } from "./prompts";
export { formatUnknownError, redactSensitiveText } from "./redaction";
export type { MemoryCompactionSnapshot, MemorySpineDiagnostics } from "./diagnostics";
export type { ContinuityCheckpoint, ContinuityCommand, ContinuityCompactionDiagnostic } from "./types";

type CompleteFn = typeof complete;

export function createSessionContinuity(deps: { completeFn?: CompleteFn } = {}) {
	const completeFn = deps.completeFn ?? complete;
	return function sessionContinuity(pi: ExtensionAPI) {
		if (isPiSubagentChild()) return;

		let turnState = emptyTurnState();
		let checkpointCount = 0;
		let lastCheckpointHash: string | undefined;
		let lastCheckpointAt = 0;

		function appendCheckpoint(reason: ContinuityCheckpoint["reason"], ctx: ExtensionContext): ContinuityCheckpoint | undefined {
			if (!isMeaningfulTurn(turnState)) return undefined;
			const hasToolActivity = Boolean(turnState.filesRead.size || turnState.filesModified.size || turnState.commands.length || turnState.toolErrors.length);
			const enoughTimePassed = Date.now() - lastCheckpointAt >= MIN_CHECKPOINT_INTERVAL_MS;
			if (reason === "agent_end" && !hasToolActivity && !enoughTimePassed) return undefined;
			const checkpoint = buildCheckpoint(reason, turnState, ctx, pi);
			const hash = checkpointHash(checkpoint);
			if (hash === lastCheckpointHash) return undefined;
			lastCheckpointHash = hash;
			lastCheckpointAt = Date.now();
			pi.appendEntry(CHECKPOINT_TYPE, checkpoint);
			checkpointCount++;
			updateMemoryStatus(ctx, checkpointCount, "saved");
			return checkpoint;
		}

		pi.on("session_start", async (_event, ctx) => {
			const checkpoints = extractContinuityCheckpoints(ctx.sessionManager.getBranch());
			checkpointCount = checkpoints.length;
			lastCheckpointHash = checkpoints.length ? checkpointHash(checkpoints[checkpoints.length - 1]!) : undefined;
			lastCheckpointAt = checkpoints.length ? Date.parse(checkpoints[checkpoints.length - 1]!.timestamp) || 0 : 0;
			turnState = emptyTurnState();
			updateMemoryStatus(ctx, checkpointCount);
		});

		pi.on("before_agent_start", async (event) => {
			turnState = emptyTurnState();
			turnState.prompt = event.prompt;
		});

		pi.on("tool_result", async (event) => {
			recordToolResult(turnState, event);
		});

		pi.on("agent_end", async (_event, ctx) => {
			appendCheckpoint("agent_end", ctx);
			turnState = emptyTurnState();
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			appendCheckpoint("shutdown", ctx);
		});

		pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
			const { preparation, branchEntries, customInstructions, signal } = event;
			const currentCheckpoint = appendCheckpoint("compact", ctx);
			if (currentCheckpoint) turnState = emptyTurnState();
			updateMemoryStatus(ctx, checkpointCount, "compact");
			const maxSummaryTokens = summaryTokenBudget(ctx.model);
			const promptBudgetChars = compactionPromptBudgetChars(ctx.model, maxSummaryTokens);

			const messages = convertToLlm(preparation.messagesToSummarize);
			const turnPrefixMessages = convertToLlm(preparation.turnPrefixMessages ?? []);
			const conversationText = serializeConversation(messages);
			const turnPrefixText = turnPrefixMessages.length ? serializeConversation(turnPrefixMessages) : undefined;
			const checkpointEntries = extractContinuityCheckpoints(branchEntries);
			if (currentCheckpoint) checkpointEntries.push(currentCheckpoint);
			const ledger = buildLedger(checkpointEntries);
			const gitStatus = await gitStatusSummary(pi, ctx.cwd);
			const prompt = buildContinuitySummaryPrompt({
				previousSummary: preparation.previousSummary,
				conversationText,
				turnPrefixText,
				ledger,
				fileOps: preparation.fileOps,
				customInstructions,
				gitStatus,
				maxPromptChars: promptBudgetChars,
			});
			const promptSizing = buildPromptSizing({
				prompt,
				conversationText,
				turnPrefixText,
				previousSummary: preparation.previousSummary,
				customInstructions,
				gitStatus,
				preparation,
				promptBudgetChars,
				maxSummaryTokens,
			});

			const fallback = (reason: CompactionDiagnosticReason, error?: string) => fallbackCompaction({
				pi,
				ctx,
				event,
				ledger,
				promptSizing,
				gitStatus,
				reason,
				error,
			});

			if (!ctx.model) {
				notify(ctx, "Memory spine: no model; using deterministic harness fallback", "warning");
				return fallback("no_model");
			}

			notify(ctx, "Memory spine: generating continuity summary...", "info");
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok || !auth.apiKey) {
				const message = auth.ok ? `No API key for ${ctx.model.provider}` : (auth as { error: string }).error;
				notify(ctx, `Memory spine: ${message}; using deterministic harness fallback`, "warning");
				return fallback("no_api_key", message);
			}

			const summaryMessage: Message = {
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			};

			try {
				const response = await completeFn(
					ctx.model,
					{ systemPrompt: COMPACTION_SYSTEM_PROMPT, messages: [summaryMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: maxSummaryTokens, signal },
				);
				if (response.stopReason === "aborted") {
					appendCompactionDiagnostic(pi, ctx, "aborted", { promptSizing, fallbackReturned: false });
					updateMemoryStatus(ctx, checkpointCount, "aborted");
					return undefined;
				}
				if (response.stopReason === "error") {
					return fallback("exception", response.errorMessage ?? "Model returned stopReason=error during custom compaction");
				}

				const summary = redactSensitiveText(extractSummaryText(response));
				if (!summary) {
					notify(ctx, "Memory spine: empty model summary; using deterministic harness fallback", "warning");
					return fallback("empty_summary");
				}

				updateMemoryStatus(ctx, checkpointCount, "compacted");
				return {
					compaction: {
						summary,
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: buildCompactionDetails(ledger, promptSizing),
					},
				};
			} catch (error) {
				if (signal.aborted) {
					appendCompactionDiagnostic(pi, ctx, "aborted", { promptSizing, fallbackReturned: false });
					updateMemoryStatus(ctx, checkpointCount, "aborted");
					return undefined;
				}
				const message = formatUnknownError(error);
				notify(ctx, `Memory spine failed; using deterministic harness fallback: ${message}`, "warning");
				return fallback("exception", message);
			}
		});

		pi.on("session_compact", async (event: SessionCompactEvent, ctx) => {
			if (event.fromExtension) return;
			appendCompactionDiagnostic(pi, ctx, "default_compaction", {
				fallbackReturned: false,
				compactionEntry: event.compactionEntry,
				fromExtension: event.fromExtension,
			});
			updateMemoryStatus(ctx, checkpointCount, "default");
		});
	};
}

export default createSessionContinuity();
