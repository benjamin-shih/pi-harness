import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_TYPE, CONTINUITY_VERSION, MAX_ITEMS_PER_CHECKPOINT, MAX_LEDGER_CHECKPOINTS, MAX_LEDGER_COMMANDS, MAX_LEDGER_FILES, MAX_PROMPT_CHARS } from "./constants";
import { contextSummary, modelSummary } from "./context";
import { truncateText } from "./redaction";
import type { ContinuityCheckpoint, ContinuityCommand, ContinuityLedger, TurnState } from "./types";

export function emptyTurnState(): TurnState {
	return {
		filesRead: new Set(),
		filesModified: new Set(),
		commands: [],
		toolErrors: [],
	};
}

export function uniqueSorted(values: Iterable<string>, maxItems = MAX_ITEMS_PER_CHECKPOINT): string[] {
	return [...new Set([...values].filter(Boolean))].sort((a, b) => a.localeCompare(b)).slice(0, maxItems);
}

function pushUnique<T>(items: T[], item: T, maxItems: number): void {
	if (!items.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) items.push(item);
	if (items.length > maxItems) items.splice(0, items.length - maxItems);
}

function pathFromInput(input: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

export function recordToolResult(state: TurnState, event: ToolResultEvent): void {
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

export function isMeaningfulTurn(state: TurnState): boolean {
	if (state.filesRead.size || state.filesModified.size || state.commands.length || state.toolErrors.length) return true;

	const prompt = state.prompt?.trim() ?? "";
	if (prompt.length >= 40) return true;
	return /\b(next|plan|goal|continue|implement|build|fix|change|revert|decide|memory|harness|summary|compact|handoff)\b/i.test(prompt);
}

export function checkpointHash(checkpoint: ContinuityCheckpoint): string {
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

export function buildCheckpoint(reason: ContinuityCheckpoint["reason"], state: TurnState, ctx: ExtensionContext, pi: ExtensionAPI): ContinuityCheckpoint {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const model = modelSummary(ctx);
	const context = contextSummary(ctx);
	return {
		version: CONTINUITY_VERSION,
		reason,
		timestamp: new Date().toISOString(),
		cwd: ctx.cwd,
		...(sessionFile ? { sessionFile } : {}),
		...(model ? { model } : {}),
		thinking: pi.getThinkingLevel(),
		...(context ? { context } : {}),
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
