import { complete, type Message } from "@mariozechner/pi-ai";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionCompactEvent,
	type SessionEntry,
	type ToolResultEvent,
} from "@mariozechner/pi-coding-agent";

type CompleteFn = typeof complete;

const CHECKPOINT_TYPE = "ben-continuity-checkpoint";
const COMPACTION_DIAGNOSTIC_TYPE = "ben-continuity-compaction-diagnostic";
const CONTINUITY_VERSION = 1;
const MAX_PROMPT_CHARS = 600;
const MAX_ITEMS_PER_CHECKPOINT = 24;
const MAX_LEDGER_CHECKPOINTS = 24;
const MAX_LEDGER_COMMANDS = 40;
const MAX_LEDGER_FILES = 80;
const MAX_SUMMARY_TOKENS = 8192;
const MIN_CHECKPOINT_INTERVAL_MS = 5 * 60_000;
const MAX_COMPACTION_PROMPT_CHARS = 120_000;
const MAX_PREVIOUS_SUMMARY_CHARS = 20_000;
const MAX_TURN_PREFIX_CHARS = 20_000;
const MAX_CONVERSATION_CHARS = 70_000;
const MAX_CUSTOM_INSTRUCTIONS_CHARS = 4_000;
const MAX_GIT_STATUS_CHARS = 4_000;
const MIN_COMPACTION_PROMPT_CHARS = 2_000;
const MODEL_PROMPT_CHARS_PER_TOKEN = 3;

export type ContinuityCommand = {
	command: string;
	status: "ok" | "error" | "unknown";
};

export type ContinuityCheckpoint = {
	version: number;
	reason: "agent_end" | "compact" | "shutdown";
	timestamp: string;
	cwd: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	context?: string;
	prompt?: string;
	filesRead: string[];
	filesModified: string[];
	commands: ContinuityCommand[];
	toolErrors: string[];
};

type TurnState = {
	prompt?: string;
	filesRead: Set<string>;
	filesModified: Set<string>;
	commands: ContinuityCommand[];
	toolErrors: string[];
};

type ContinuityLedger = {
	checkpoints: ContinuityCheckpoint[];
	filesRead: string[];
	filesModified: string[];
	commands: ContinuityCommand[];
	toolErrors: string[];
};

type PromptSizing = {
	promptChars: number;
	conversationChars: number;
	turnPrefixChars: number;
	previousSummaryChars: number;
	customInstructionsChars: number;
	gitStatusChars: number;
	messagesToSummarize: number;
	turnPrefixMessages: number;
	tokensBefore: number;
	promptBudgetChars: number;
	maxSummaryTokens: number;
	isSplitTurn: boolean;
	firstKeptEntryId: string;
};

type CompactionDiagnosticReason = "no_model" | "no_api_key" | "aborted" | "empty_summary" | "exception" | "default_compaction";

export type ContinuityCompactionDiagnostic = {
	version: number;
	timestamp: string;
	reason: CompactionDiagnosticReason;
	cwd: string;
	model?: string;
	thinking?: string;
	error?: string;
	fallbackReturned: boolean;
	promptSizing?: PromptSizing;
	compactionId?: string;
	fromExtension?: boolean;
};

function emptyTurnState(): TurnState {
	return {
		filesRead: new Set(),
		filesModified: new Set(),
		commands: [],
		toolErrors: [],
	};
}

function uniqueSorted(values: Iterable<string>, maxItems = MAX_ITEMS_PER_CHECKPOINT): string[] {
	return [...new Set([...values].filter(Boolean))].sort((a, b) => a.localeCompare(b)).slice(0, maxItems);
}

function pushUnique<T>(items: T[], item: T, maxItems: number): void {
	if (!items.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) items.push(item);
	if (items.length > maxItems) items.splice(0, items.length - maxItems);
}

export function redactSensitiveText(text: string): string {
	return text
		.replace(/-----BEGIN [^-]*(?:PRIVATE KEY|SECRET)[\s\S]*?-----END [^-]*(?:PRIVATE KEY|SECRET)-----/gi, "[REDACTED_PRIVATE_BLOCK]")
		.replace(/(https?:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, "$1[REDACTED]$2")
		.replace(/(Authorization:\s*Bearer\s+)[^\s'\"]+/gi, "$1[REDACTED]")
		.replace(/\b([A-Za-z0-9_]{0,80}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Za-z0-9_]{0,80}\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s'\"]+)/gi, "$1[REDACTED]")
		.replace(/(--(?:api-key|token|password|secret)\s+)[^\s'\"]+/gi, "$1[REDACTED]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_TOKEN]");
}

function truncateText(text: string, maxChars: number): string {
	const clean = redactSensitiveText(text).replace(/\s+/g, " ").trim();
	return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function truncateMiddle(text: string, maxChars: number, label = "content"): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 200) return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
	const marker = `\n\n[${label} truncated: omitted ${text.length - maxChars} chars to keep custom compaction under model context limits]\n\n`;
	const keep = Math.max(0, maxChars - marker.length);
	const head = Math.floor(keep * 0.35);
	const tail = keep - head;
	return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function compactSerializedConversation(text: string): string {
	const lines = text.split(/\r?\n/);
	const kept: string[] = [];
	let skipping: "thinking" | "tool" | undefined;

	for (const line of lines) {
		const isSectionStart = /^\[[A-Za-z ]+\]:/.test(line);
		if (isSectionStart) skipping = undefined;

		if (line.startsWith("[Assistant thinking]:")) {
			kept.push("[Assistant thinking]: [omitted by memory spine budget]");
			skipping = "thinking";
			continue;
		}
		if (line.startsWith("[Tool result]:")) {
			kept.push("[Tool result]: [omitted by memory spine budget; use file/tool metadata]");
			skipping = "tool";
			continue;
		}
		if (skipping) continue;
		kept.push(line);
	}

	return redactSensitiveText(kept.join("\n"));
}

function contextSummary(ctx: ExtensionContext): string | undefined {
	const usage = ctx.getContextUsage();
	if (!usage) return undefined;
	if (usage.tokens === null || usage.percent === null) return `unknown/${usage.contextWindow}`;
	return `${usage.percent.toFixed(1)}% (${usage.tokens}/${usage.contextWindow})`;
}

function modelSummary(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function pathFromInput(input: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function recordToolResult(state: TurnState, event: ToolResultEvent): void {
	const input = event.input ?? {};

	if (event.toolName === "read") {
		const path = pathFromInput(input, ["path"]);
		if (path) state.filesRead.add(path);
	} else if (event.toolName === "edit" || event.toolName === "write") {
		const path = pathFromInput(input, ["path"]);
		if (path) state.filesModified.add(path);
	} else if (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
		const path = pathFromInput(input, ["path", "cwd"]);
		if (path) state.filesRead.add(path);
	} else if (event.toolName === "bash") {
		const command = pathFromInput(input, ["command"]);
		if (command) {
			state.commands.push({
				command: truncateText(command, 500),
				status: event.isError ? "error" : "ok",
			});
		}
	}

	if (event.isError) {
		const target = pathFromInput(input, ["path", "command", "glob", "query"]);
		state.toolErrors.push(truncateText(`${event.toolName}${target ? `: ${target}` : ""}`, 300));
	}
}

function isMeaningfulTurn(state: TurnState): boolean {
	if (state.filesRead.size || state.filesModified.size || state.commands.length || state.toolErrors.length) return true;
	const prompt = state.prompt?.trim() ?? "";
	if (prompt.length >= 40) return true;
	return /\b(next|plan|goal|continue|implement|build|fix|change|revert|decide|memory|harness|summary|compact|handoff)\b/i.test(prompt);
}

function checkpointHash(checkpoint: ContinuityCheckpoint): string {
	return JSON.stringify({
		reason: checkpoint.reason,
		cwd: checkpoint.cwd,
		prompt: checkpoint.prompt,
		filesRead: checkpoint.filesRead,
		filesModified: checkpoint.filesModified,
		commands: checkpoint.commands,
		toolErrors: checkpoint.toolErrors,
	});
}

function buildCheckpoint(reason: ContinuityCheckpoint["reason"], state: TurnState, ctx: ExtensionContext, pi: ExtensionAPI): ContinuityCheckpoint {
	return {
		version: CONTINUITY_VERSION,
		reason,
		timestamp: new Date().toISOString(),
		cwd: ctx.cwd,
		...(ctx.sessionManager.getSessionFile() ? { sessionFile: ctx.sessionManager.getSessionFile() } : {}),
		...(modelSummary(ctx) ? { model: modelSummary(ctx) } : {}),
		thinking: pi.getThinkingLevel(),
		...(contextSummary(ctx) ? { context: contextSummary(ctx) } : {}),
		...(state.prompt ? { prompt: truncateText(state.prompt, MAX_PROMPT_CHARS) } : {}),
		filesRead: uniqueSorted(state.filesRead),
		filesModified: uniqueSorted(state.filesModified),
		commands: state.commands.slice(-MAX_ITEMS_PER_CHECKPOINT),
		toolErrors: uniqueSorted(state.toolErrors),
	};
}

function isContinuityCheckpoint(value: unknown): value is ContinuityCheckpoint {
	const candidate = value as ContinuityCheckpoint;
	return (
		Boolean(candidate) &&
		candidate.version === CONTINUITY_VERSION &&
		typeof candidate.timestamp === "string" &&
		typeof candidate.cwd === "string" &&
		Array.isArray(candidate.filesRead) &&
		Array.isArray(candidate.filesModified) &&
		Array.isArray(candidate.commands) &&
		Array.isArray(candidate.toolErrors)
	);
}

export function extractContinuityCheckpoints(entries: SessionEntry[]): ContinuityCheckpoint[] {
	return entries
		.filter((entry): entry is SessionEntry & { type: "custom"; customType: string; data?: unknown } => entry.type === "custom")
		.filter((entry) => entry.customType === CHECKPOINT_TYPE && isContinuityCheckpoint(entry.data))
		.map((entry) => entry.data as ContinuityCheckpoint);
}

export function buildLedger(checkpoints: ContinuityCheckpoint[]): ContinuityLedger {
	const recent = checkpoints.slice(-MAX_LEDGER_CHECKPOINTS);
	const filesRead = new Set<string>();
	const filesModified = new Set<string>();
	const commands: ContinuityCommand[] = [];
	const toolErrors = new Set<string>();

	for (const checkpoint of recent) {
		for (const file of checkpoint.filesRead) filesRead.add(file);
		for (const file of checkpoint.filesModified) filesModified.add(file);
		for (const command of checkpoint.commands) pushUnique(commands, command, MAX_LEDGER_COMMANDS);
		for (const error of checkpoint.toolErrors) toolErrors.add(error);
	}

	return {
		checkpoints: recent,
		filesRead: uniqueSorted(filesRead, MAX_LEDGER_FILES),
		filesModified: uniqueSorted(filesModified, MAX_LEDGER_FILES),
		commands,
		toolErrors: uniqueSorted(toolErrors, MAX_LEDGER_COMMANDS),
	};
}

function bulletList(items: string[], empty = "- None recorded."): string {
	if (!items.length) return empty;
	return items.map((item) => `- ${item}`).join("\n");
}

function commandList(commands: ContinuityCommand[]): string {
	if (!commands.length) return "- None recorded.";
	return commands.map((command) => `- ${command.status}: ${command.command}`).join("\n");
}

function checkpointList(checkpoints: ContinuityCheckpoint[]): string {
	if (!checkpoints.length) return "- None recorded.";
	return checkpoints
		.slice(-8)
		.map((checkpoint) => {
			const parts = [checkpoint.timestamp, checkpoint.reason, checkpoint.prompt ? `prompt: ${checkpoint.prompt}` : undefined]
				.filter(Boolean)
				.join(" | ");
			return `- ${parts}`;
		})
		.join("\n");
}

function fileOpsList(fileOps: { readFiles?: string[]; modifiedFiles?: string[] } | undefined, key: "readFiles" | "modifiedFiles"): string {
	return bulletList(uniqueSorted(fileOps?.[key] ?? [], MAX_LEDGER_FILES));
}

export function buildContinuitySummaryPrompt(args: {
	previousSummary?: string;
	conversationText: string;
	turnPrefixText?: string;
	ledger: ContinuityLedger;
	fileOps?: { readFiles?: string[]; modifiedFiles?: string[] };
	customInstructions?: string;
	gitStatus?: string;
	maxPromptChars?: number;
}): string {
	const maxPromptChars = Math.max(MIN_COMPACTION_PROMPT_CHARS, Math.min(args.maxPromptChars ?? MAX_COMPACTION_PROMPT_CHARS, MAX_COMPACTION_PROMPT_CHARS));
	const previous = truncateMiddle(redactSensitiveText(args.previousSummary?.trim() || "None."), MAX_PREVIOUS_SUMMARY_CHARS, "previous summary");
	const conversationText = truncateMiddle(compactSerializedConversation(args.conversationText || "None."), MAX_CONVERSATION_CHARS, "conversation");
	const turnPrefix = truncateMiddle(compactSerializedConversation(args.turnPrefixText?.trim() || "None."), MAX_TURN_PREFIX_CHARS, "turn prefix");
	const customInstructions = truncateMiddle(redactSensitiveText(args.customInstructions?.trim() || "None."), MAX_CUSTOM_INSTRUCTIONS_CHARS, "custom instructions");
	const gitStatus = truncateMiddle(redactSensitiveText(args.gitStatus?.trim() || "Not checked."), MAX_GIT_STATUS_CHARS, "git status");

	const prompt = `You are generating a durable continuity summary for a long-running pi coding-agent session.

Your job is to preserve exactly what a future agent needs to continue after compaction. Be concise, factual, and operational. Do not invent work. Do not include secret values, command output, or credentials. If something is unknown, say unknown.

Use exactly these markdown sections:

## Goal
## Current State
## Constraints / Preferences
## Decisions Made
## Files Read
## Files Modified
## Commands / Verification
## Active Skills / Routing
## Subagents / Intercom State
## Blockers / Open Questions
## Next Exact Actions
## Critical Continuation Notes

Previous continuity summary:
<previous-summary>
${previous}
</previous-summary>

Custom compaction instructions:
<custom-instructions>
${customInstructions}
</custom-instructions>

Current git status summary:
<git-status>
${gitStatus}
</git-status>

Deterministic continuity ledger:
<ledger>
Recent checkpoints:
${checkpointList(args.ledger.checkpoints)}

Files read from checkpoints:
${bulletList(args.ledger.filesRead)}

Files modified from checkpoints:
${bulletList(args.ledger.filesModified)}

Commands recorded from checkpoints:
${commandList(args.ledger.commands)}

Tool errors recorded from checkpoints:
${bulletList(args.ledger.toolErrors)}
</ledger>

Pi file operation tracker:
<file-ops>
Files read:
${fileOpsList(args.fileOps, "readFiles")}

Files modified:
${fileOpsList(args.fileOps, "modifiedFiles")}
</file-ops>

Split-turn prefix, if any:
<turn-prefix>
${turnPrefix}
</turn-prefix>

Conversation being compacted:
<conversation>
${conversationText}
</conversation>`;

	return prompt.length <= maxPromptChars
		? prompt
		: truncateMiddle(prompt, maxPromptChars, "continuity compaction prompt");
}

function extractSummaryText(response: { content?: Array<{ type: string; text?: string }> }): string {
	return (response.content ?? [])
		.filter((content): content is { type: "text"; text: string } => content.type === "text" && typeof content.text === "string")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

async function gitStatusSummary(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const [branchResult, statusResult] = await Promise.all([
			pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 3_000 }).catch(() => undefined),
			pi.exec("git", ["status", "--short", "--branch", "--untracked-files=normal"], { cwd, timeout: 3_000 }).catch(() => undefined),
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

function updateMemoryStatus(ctx: ExtensionContext, checkpoints: number, label = "ready"): void {
	if (!ctx.hasUI) return;
	const text = `memory:${label}:${checkpoints}`;
	const theme = (ctx.ui as { theme?: { fg?: (color: string, value: string) => string } }).theme;
	ctx.ui.setStatus("memory", theme?.fg ? theme.fg("muted", text) : text);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

function modelContextWindow(model: ExtensionContext["model"]): number {
	return model && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : 272_000;
}

function summaryTokenBudget(model: ExtensionContext["model"]): number {
	if (!model) return MAX_SUMMARY_TOKENS;
	const contextWindow = modelContextWindow(model);
	const modelMax = Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : MAX_SUMMARY_TOKENS;
	const contextShare = Math.max(512, Math.floor(contextWindow * 0.2));
	return Math.max(512, Math.min(MAX_SUMMARY_TOKENS, modelMax, contextShare));
}

function compactionPromptBudgetChars(model: ExtensionContext["model"], maxSummaryTokens: number): number {
	if (!model) return MAX_COMPACTION_PROMPT_CHARS;
	const contextWindow = modelContextWindow(model);
	const reserveTokens = Math.max(1_024, Math.min(4_096, Math.floor(contextWindow * 0.05)));
	const inputTokens = Math.max(512, contextWindow - maxSummaryTokens - reserveTokens);
	return Math.max(MIN_COMPACTION_PROMPT_CHARS, Math.min(MAX_COMPACTION_PROMPT_CHARS, inputTokens * MODEL_PROMPT_CHARS_PER_TOKEN));
}

function buildPromptSizing(args: {
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

function buildCompactionDetails(ledger: ContinuityLedger, promptSizing: PromptSizing, fallbackReason?: CompactionDiagnosticReason, error?: string): Record<string, unknown> {
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

export function buildDeterministicContinuitySummary(args: {
	ledger: ContinuityLedger;
	fileOps?: { readFiles?: string[]; modifiedFiles?: string[] };
	previousSummary?: string;
	customInstructions?: string;
	gitStatus?: string;
	reason: CompactionDiagnosticReason;
	error?: string;
	promptSizing?: PromptSizing;
}): string {
	const recentPrompts = args.ledger.checkpoints.map((checkpoint) => checkpoint.prompt).filter((prompt): prompt is string => Boolean(prompt));
	const previous = truncateMiddle(redactSensitiveText(args.previousSummary?.trim() || "None recorded."), 8_000, "previous summary");
	return redactSensitiveText(`## Goal
${recentPrompts.length ? bulletList(recentPrompts.slice(-5)) : "- Unknown from deterministic fallback. Use recent checkpoints and preserved files to continue."}

## Current State
- Memory spine used deterministic fallback during compaction.
- Fallback reason: ${args.reason}.
${args.error ? `- Error: ${truncateText(args.error, 500)}.` : "- Error: None recorded."}
${args.promptSizing ? `- Tokens before compaction: ${args.promptSizing.tokensBefore}.` : "- Tokens before compaction: unknown."}
${args.promptSizing ? `- Prompt chars: ${args.promptSizing.promptChars}.` : "- Prompt chars: unknown."}

## Constraints / Preferences
- Preserve session continuity without command output or secrets.
- Prefer checkpoint/file metadata when model summarization fails.
- Previous summary: ${previous}
- Custom instructions: ${truncateMiddle(redactSensitiveText(args.customInstructions?.trim() || "None."), 2_000, "custom instructions")}

## Decisions Made
- Custom model compaction did not complete; harness fallback summary was returned instead of pi default compaction.

## Files Read
${bulletList(uniqueSorted([...(args.ledger.filesRead ?? []), ...(args.fileOps?.readFiles ?? [])], MAX_LEDGER_FILES))}

## Files Modified
${bulletList(uniqueSorted([...(args.ledger.filesModified ?? []), ...(args.fileOps?.modifiedFiles ?? [])], MAX_LEDGER_FILES))}

## Commands / Verification
${commandList(args.ledger.commands)}

## Active Skills / Routing
- Unknown unless captured in recent checkpoints or previous summary.

## Subagents / Intercom State
- Unknown unless captured in recent checkpoints or previous summary.

## Blockers / Open Questions
- Investigate memory-spine compaction diagnostic reason: ${args.reason}.

## Next Exact Actions
- Inspect recent session entries and files modified above.
- Continue from the latest user request and checkpoint ledger.
- If compaction diagnostics persist, inspect ben-continuity-compaction-diagnostic entries.

## Critical Continuation Notes
- This is a deterministic fallback summary, not an LLM-generated summary.
- Current git status at compaction:
${truncateMiddle(redactSensitiveText(args.gitStatus?.trim() || "Not checked."), 2_000, "git status")}`);
}

function appendCompactionDiagnostic(
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

function fallbackCompaction(args: {
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

export function createSessionContinuity(deps: { completeFn?: CompleteFn } = {}) {
	const completeFn = deps.completeFn ?? complete;
	return function sessionContinuity(pi: ExtensionAPI) {
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
			const message = auth.ok ? `No API key for ${ctx.model.provider}` : auth.error;
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
				{ messages: [summaryMessage] },
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
			const message = error instanceof Error ? error.message : String(error);
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
