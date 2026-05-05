import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionCompactEvent } from "@mariozechner/pi-coding-agent";
import { COMPACTION_DIAGNOSTIC_TYPE, CONTINUITY_VERSION, MAX_COMPACTION_PROMPT_CHARS, MAX_SUMMARY_TOKENS, MIN_COMPACTION_PROMPT_CHARS, MODEL_PROMPT_CHARS_PER_TOKEN } from "./constants";
import { modelSummary } from "./context";
import { buildDeterministicContinuitySummary } from "./prompts";
import { redactSensitiveText, truncateText } from "./redaction";
import type { CompactionDiagnosticReason, ContinuityCompactionDiagnostic, ContinuityLedger, PromptSizing } from "./types";

export async function gitStatusSummary(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const [branchResult, statusResult] = await Promise.all([
			pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 3_000 }).catch((): undefined => undefined),
			pi.exec("git", ["status", "--short", "--branch", "--untracked-files=no"], { cwd, timeout: 3_000 }).catch((): undefined => undefined),
		]);
		if (!statusResult || statusResult.code !== 0) return undefined;
		const branch = branchResult?.stdout.trim();
		const statusLines = (statusResult.stdout.trim() || "clean").split(/\r?\n/);
		const cappedStatus = statusLines.slice(0, 80).join("\n") + (statusLines.length > 80 ? `\n... ${statusLines.length - 80} more git status lines omitted` : "");
		return redactSensitiveText([branch ? `branch: ${branch}` : undefined, cappedStatus].filter(Boolean).join("\n")).slice(0, 4_000);
	} catch {
		return undefined;
	}
}

export function updateMemoryStatus(ctx: ExtensionContext, checkpoints: number, label = "ready"): void {
	if (!ctx.hasUI) return;
	const text = `memory:${label}:${checkpoints}`;
	const theme = (ctx.ui as { theme?: { fg?: (color: string, value: string) => string } }).theme;
	ctx.ui.setStatus("memory", theme?.fg ? theme.fg("muted", text) : text);
}

export function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

function modelContextWindow(model: ExtensionContext["model"]): number {
	return model && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : 272_000;
}

export function summaryTokenBudget(model: ExtensionContext["model"]): number {
	if (!model) return MAX_SUMMARY_TOKENS;
	const contextWindow = modelContextWindow(model);
	const modelMax = Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : MAX_SUMMARY_TOKENS;
	const contextShare = Math.max(512, Math.floor(contextWindow * 0.2));
	return Math.max(512, Math.min(MAX_SUMMARY_TOKENS, modelMax, contextShare));
}

export function compactionPromptBudgetChars(model: ExtensionContext["model"], maxSummaryTokens: number): number {
	if (!model) return MAX_COMPACTION_PROMPT_CHARS;
	const contextWindow = modelContextWindow(model);
	const reserveTokens = Math.max(1_024, Math.min(4_096, Math.floor(contextWindow * 0.05)));
	const inputTokens = Math.max(512, contextWindow - maxSummaryTokens - reserveTokens);
	return Math.max(MIN_COMPACTION_PROMPT_CHARS, Math.min(MAX_COMPACTION_PROMPT_CHARS, inputTokens * MODEL_PROMPT_CHARS_PER_TOKEN));
}

export function buildPromptSizing(args: {
	prompt: string;
	conversationText: string;
	turnPrefixText?: string;
	previousSummary?: string;
	customInstructions?: string;
	gitStatus?: string;
	preparation: SessionBeforeCompactEvent["preparation"];
	promptBudgetChars: number;
	maxSummaryTokens: number;
}): PromptSizing {
	return {
		promptChars: args.prompt.length,
		conversationChars: args.conversationText.length,
		turnPrefixChars: args.turnPrefixText?.length ?? 0,
		previousSummaryChars: args.previousSummary?.length ?? 0,
		customInstructionsChars: args.customInstructions?.length ?? 0,
		gitStatusChars: args.gitStatus?.length ?? 0,
		messagesToSummarize: args.preparation.messagesToSummarize.length,
		turnPrefixMessages: args.preparation.turnPrefixMessages?.length ?? 0,
		tokensBefore: args.preparation.tokensBefore,
		promptBudgetChars: args.promptBudgetChars,
		maxSummaryTokens: args.maxSummaryTokens,
		isSplitTurn: args.preparation.isSplitTurn,
		firstKeptEntryId: args.preparation.firstKeptEntryId,
	};
}

export function buildCompactionDetails(ledger: ContinuityLedger, promptSizing: PromptSizing, fallbackReason?: CompactionDiagnosticReason, error?: string): Record<string, unknown> {
	return {
		source: "ben-pi-harness/session-continuity",
		version: CONTINUITY_VERSION,
		checkpointCount: ledger.checkpoints.length,
		filesRead: ledger.filesRead,
		filesModified: ledger.filesModified,
		commands: ledger.commands.map((command) => ({ command: command.command, status: command.status })),
		promptSizing,
		...(fallbackReason ? { fallbackReason } : {}),
		...(error ? { error: truncateText(error, 500) } : {}),
	};
}

export function appendCompactionDiagnostic(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason: CompactionDiagnosticReason,
	options: { promptSizing?: PromptSizing; error?: string; fallbackReturned?: boolean; compactionEntry?: SessionCompactEvent["compactionEntry"]; fromExtension?: boolean } = {},
): void {
	const diagnostic: ContinuityCompactionDiagnostic = {
		version: CONTINUITY_VERSION,
		timestamp: new Date().toISOString(),
		reason,
		cwd: ctx.cwd,
		...(modelSummary(ctx) ? { model: modelSummary(ctx) } : {}),
		thinking: pi.getThinkingLevel(),
		fallbackReturned: options.fallbackReturned ?? false,
		...(options.promptSizing ? { promptSizing: options.promptSizing } : {}),
		...(options.error ? { error: truncateText(options.error, 500) } : {}),
		...(options.compactionEntry ? { compactionId: options.compactionEntry.id } : {}),
		...(options.fromExtension !== undefined ? { fromExtension: options.fromExtension } : {}),
	};
	pi.appendEntry(COMPACTION_DIAGNOSTIC_TYPE, diagnostic);
}

export function fallbackCompaction(args: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	event: SessionBeforeCompactEvent;
	ledger: ContinuityLedger;
	promptSizing: PromptSizing;
	gitStatus?: string;
	reason: CompactionDiagnosticReason;
	error?: string;
}) {
	appendCompactionDiagnostic(args.pi, args.ctx, args.reason, {
		promptSizing: args.promptSizing,
		error: args.error,
		fallbackReturned: true,
	});
	updateMemoryStatus(args.ctx, args.ledger.checkpoints.length, "fallback");
	return {
		compaction: {
			summary: buildDeterministicContinuitySummary({
				ledger: args.ledger,
				fileOps: args.event.preparation.fileOps,
				previousSummary: args.event.preparation.previousSummary,
				customInstructions: args.event.customInstructions,
				gitStatus: args.gitStatus,
				reason: args.reason,
				error: args.error,
				promptSizing: args.promptSizing,
			}),
			firstKeptEntryId: args.event.preparation.firstKeptEntryId,
			tokensBefore: args.event.preparation.tokensBefore,
			details: buildCompactionDetails(args.ledger, args.promptSizing, args.reason, args.error),
		},
	};
}
