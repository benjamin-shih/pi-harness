import { complete, type Message } from "@mariozechner/pi-ai";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	type ToolResultEvent,
} from "@mariozechner/pi-coding-agent";

const CHECKPOINT_TYPE = "ben-continuity-checkpoint";
const CONTINUITY_VERSION = 1;
const MAX_PROMPT_CHARS = 600;
const MAX_ITEMS_PER_CHECKPOINT = 24;
const MAX_LEDGER_CHECKPOINTS = 24;
const MAX_LEDGER_COMMANDS = 40;
const MAX_LEDGER_FILES = 80;
const MAX_SUMMARY_TOKENS = 8192;
const MIN_CHECKPOINT_INTERVAL_MS = 5 * 60_000;

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
		.replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s'\"]+)/gi, "$1[REDACTED]")
		.replace(/(--(?:api-key|token|password|secret)\s+)[^\s'\"]+/gi, "$1[REDACTED]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_TOKEN]");
}

function truncateText(text: string, maxChars: number): string {
	const clean = redactSensitiveText(text).replace(/\s+/g, " ").trim();
	return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
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
}): string {
	const previous = redactSensitiveText(args.previousSummary?.trim() || "None.");
	const conversationText = redactSensitiveText(args.conversationText || "None.");
	const turnPrefix = redactSensitiveText(args.turnPrefixText?.trim() || "None.");
	const customInstructions = redactSensitiveText(args.customInstructions?.trim() || "None.");
	const gitStatus = redactSensitiveText(args.gitStatus?.trim() || "Not checked.");

	return `You are generating a durable continuity summary for a long-running pi coding-agent session.

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

export default function sessionContinuity(pi: ExtensionAPI) {
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
		if (!ctx.model) return undefined;

		const currentCheckpoint = appendCheckpoint("compact", ctx);
		updateMemoryStatus(ctx, checkpointCount, "compact");
		ctx.ui.notify("Memory spine: generating continuity summary...", "info");

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(auth.ok ? `Memory spine: no API key for ${ctx.model.provider}; using default compaction` : auth.error, "warning");
			updateMemoryStatus(ctx, checkpointCount, "fallback");
			return undefined;
		}

		const { preparation, branchEntries, customInstructions, signal } = event;
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
		});

		const summaryMessage: Message = {
			role: "user",
			content: [{ type: "text", text: prompt }],
			timestamp: Date.now(),
		};

		try {
			const response = await complete(
				ctx.model,
				{ messages: [summaryMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: MAX_SUMMARY_TOKENS, signal },
			);
			if (response.stopReason === "aborted") return undefined;

			const summary = redactSensitiveText(extractSummaryText(response));
			if (!summary) {
				ctx.ui.notify("Memory spine: empty summary; using default compaction", "warning");
				updateMemoryStatus(ctx, checkpointCount, "fallback");
				return undefined;
			}

			updateMemoryStatus(ctx, checkpointCount, "compacted");
			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {
						source: "ben-pi-harness/session-continuity",
						version: CONTINUITY_VERSION,
						checkpointCount: ledger.checkpoints.length,
						filesRead: ledger.filesRead,
						filesModified: ledger.filesModified,
						commands: ledger.commands.map((command) => ({ command: command.command, status: command.status })),
					},
				},
			};
		} catch (error) {
			if (!signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Memory spine failed; using default compaction: ${message}`, "warning");
				updateMemoryStatus(ctx, checkpointCount, "fallback");
			}
			return undefined;
		}
	});
}
