import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join, parse } from "node:path";
import type { AgentToolResult, BashToolDetails, BashToolInput, EditToolDetails, EditToolInput, ExtensionAPI, ReadToolDetails, ReadToolInput, Theme, WriteToolInput } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type JsonObject = Record<string, unknown>;
type SettingValue = boolean | "on" | "off" | "compact" | "summary" | "minimal" | "default";

const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};
}

function getBuiltInTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

function readJson(path: string): JsonObject {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
	} catch {
		return {};
	}
}

function mergeSettings(base: JsonObject, override: JsonObject): JsonObject {
	const result: JsonObject = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
			result[key] = mergeSettings(result[key] as JsonObject, value as JsonObject);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function nearestProjectSettings(cwd: string): JsonObject {
	let current = cwd;
	const root = parse(cwd).root;
	while (true) {
		const settings = join(current, ".pi", "settings.json");
		if (existsSync(settings)) return readJson(settings);
		if (current === root) return {};
		current = dirname(current);
	}
}

function compactSettingValue(settings: JsonObject): SettingValue | undefined {
	const harness = settings.harness;
	if (harness && typeof harness === "object" && !Array.isArray(harness) && "compactToolOutput" in harness) return (harness as JsonObject).compactToolOutput as SettingValue;
	if ("compactToolOutput" in settings) return settings.compactToolOutput as SettingValue;
	return undefined;
}

export function compactToolOutputEnabled(cwd = process.cwd()): boolean {
	const env = process.env.BEN_PI_COMPACT_TOOL_OUTPUT?.trim().toLowerCase();
	if (env) return ["1", "true", "yes", "on", "compact", "summary", "minimal"].includes(env);
	const global = readJson(join(homedir(), ".pi", "agent", "settings.json"));
	const merged = mergeSettings(global, nearestProjectSettings(cwd));
	const value = compactSettingValue(merged);
	return value === true || value === "on" || value === "compact" || value === "summary" || value === "minimal";
}

const MAX_SUMMARY_CHARS = 140;
const MAX_INLINE_BASH_RESULT_CHARS = 8_000;
const MAX_INLINE_BASH_RESULT_LINES = 120;
const MAX_COMPACTED_TAIL_CHARS = 4_000;
const COMPACTED_OUTPUT_DIR = "ben-pi-harness-tool-output";
const COMPACTED_OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000;

function shortenHome(text: string): string {
	const home = homedir();
	return home ? text.split(home).join("~") : text;
}

function compactText(value: string, maxChars = MAX_SUMMARY_CHARS): string {
	const collapsed = shortenHome(value).replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxChars) return collapsed || "…";
	return `${collapsed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function shortenPath(path: string | undefined): string {
	if (!path) return "…";
	return compactText(path, MAX_SUMMARY_CHARS);
}

function lineCount(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

function textSizeSummary(text: string): string {
	const lines = lineCount(text);
	return `${lines} line${lines === 1 ? "" : "s"}`;
}

function readSummary(args: ReadToolInput): string {
	const parts = [shortenPath(args.path)];
	if (typeof args.offset === "number") parts.push(`offset ${args.offset}`);
	if (typeof args.limit === "number") parts.push(`limit ${args.limit}`);
	return parts.join(" · ");
}

function writeSummary(args: WriteToolInput): string {
	return `${shortenPath(args.path)} · ${textSizeSummary(args.content)}`;
}

function editSummary(args: EditToolInput): string {
	const edits = args.edits?.length ?? 0;
	return `${shortenPath(args.path)} · ${edits} replacement${edits === 1 ? "" : "s"}`;
}

function bashSummary(args: BashToolInput): string {
	const raw = args.command || "";
	const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const first = compactText(lines[0] || "…", MAX_SUMMARY_CHARS);
	return lines.length > 1 ? `${first} · +${lines.length - 1} lines` : first;
}

function firstTextContent(result: AgentToolResult<unknown>): string {
	const text = result.content.find((item) => item.type === "text");
	return text?.type === "text" ? text.text : "";
}

function statusText(theme: Theme, isError: boolean, okLabel = "ok", errorLabel = "failed"): string {
	return isError ? theme.fg("error", `✗ ${errorLabel}`) : theme.fg("success", `✓ ${okLabel}`);
}

function bashStatusLabel(result: AgentToolResult<unknown>, isError: boolean): string {
	if (!isError) return "exit 0";
	const text = firstTextContent(result);
	const exitCode = text.match(/Command exited with code (\d+)/)?.[1];
	if (exitCode) return `exit ${exitCode}`;
	if (/Command timed out/i.test(text)) return "timed out";
	if (/Command aborted/i.test(text)) return "aborted";
	return "failed";
}

function outputLineCount(result: AgentToolResult<unknown>): number {
	const text = firstTextContent(result);
	if (!text.trim()) return 0;
	return text.split("\n").filter((line) => line.trim()).length;
}

type ToolResultEventLike = {
	toolName: string;
	input?: unknown;
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

function textContentFromEvent(event: ToolResultEventLike): string {
	return (event.content ?? []).filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}

function shouldCompactBashResult(text: string): boolean {
	if (text.length > MAX_INLINE_BASH_RESULT_CHARS) return true;
	return text.split("\n").filter((line) => line.trim()).length > MAX_INLINE_BASH_RESULT_LINES;
}

function compactTail(text: string): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	let chars = 0;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = shortenHome(lines[index]);
		chars += line.length + 1;
		if (chars > MAX_COMPACTED_TAIL_CHARS && kept.length > 0) break;
		kept.push(line);
	}
	const tail = kept.reverse().join("\n").trimEnd();
	if (tail.length <= MAX_COMPACTED_TAIL_CHARS) return tail;
	return `…${tail.slice(-(MAX_COMPACTED_TAIL_CHARS - 1))}`;
}

function cleanupCompactedOutputDir(dir: string): void {
	const cutoff = Date.now() - COMPACTED_OUTPUT_RETENTION_MS;
	try {
		for (const entry of readdirSync(dir)) {
			if (!entry.startsWith("bash-output-") || !entry.endsWith(".log")) continue;
			const path = join(dir, entry);
			if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
		}
	} catch {
		// Best-effort temp-file hygiene must never block the tool result path.
	}
}

function compactedOutputPath(): string {
	const dir = join(tmpdir(), COMPACTED_OUTPUT_DIR);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	cleanupCompactedOutputDir(dir);
	return join(dir, `bash-output-${Date.now()}-${randomUUID().slice(0, 8)}.log`);
}

function summarizeOriginal(text: string): string {
	const lines = lineCount(text);
	return `${lines} line${lines === 1 ? "" : "s"}, ${text.length} chars`;
}

function bashInputSummary(input: unknown): string {
	const command = input && typeof input === "object" && "command" in input ? String((input as { command?: unknown }).command ?? "") : "";
	return bashSummary({ command });
}

function detailsRecord(details: unknown): Record<string, unknown> {
	return details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : {};
}

function isBuiltInTruncated(details: Record<string, unknown>): boolean {
	const truncation = details.truncation;
	return Boolean(truncation && typeof truncation === "object" && !Array.isArray(truncation) && (truncation as Record<string, unknown>).truncated === true);
}

function builtInFullOutputPath(details: Record<string, unknown>): string | undefined {
	return typeof details.fullOutputPath === "string" && details.fullOutputPath ? details.fullOutputPath : undefined;
}

function compactedBashContent(event: ToolResultEventLike, text: string, outputFile: string, fullOutputPath: string | undefined, truncated: boolean): string {
	const resultLike: AgentToolResult<unknown> = { content: event.content ?? [], details: event.details } as AgentToolResult<unknown>;
	const status = bashStatusLabel(resultLike, event.isError === true);
	const tail = compactTail(text);
	const outputPointer = fullOutputPath
		? `- complete output saved by bash tool at: ${shortenPath(fullOutputPath)}`
		: truncated
			? `- truncated visible output saved to: ${outputFile}`
			: `- captured full output saved to: ${outputFile}`;
	return [
		"[ben-pi-harness] bash output compacted to reduce context.",
		`- command: ${bashInputSummary(event.input)}`,
		`- status: ${status}`,
		`- visible output: ${summarizeOriginal(text)}${truncated ? " (already truncated by bash tool)" : ""}`,
		outputPointer,
		"- to inspect if needed: read the saved file with offset/limit or rerun a narrower command",
		"",
		"Tail of visible output:",
		tail || "(no non-empty output)",
	].join("\n");
}

export function compactToolResultForContext(event: ToolResultEventLike, cwd = process.cwd()): { content: Array<{ type: "text"; text: string }>; details?: unknown } | undefined {
	if (!compactToolOutputEnabled(cwd)) return undefined;
	if (event.toolName !== "bash") return undefined;
	const text = textContentFromEvent(event);
	if (!text || !shouldCompactBashResult(text)) return undefined;
	const details = detailsRecord(event.details);
	const truncated = isBuiltInTruncated(details);
	const fullOutputPath = builtInFullOutputPath(details);
	const outputFile = fullOutputPath ?? compactedOutputPath();
	if (!fullOutputPath) writeFileSync(outputFile, text, { encoding: "utf8", mode: 0o600 });
	return {
		content: [{ type: "text", text: compactedBashContent(event, text, outputFile, fullOutputPath, truncated) }],
		details: {
			...details,
			harnessCompaction: { outputFile, fullOutputPath, originalChars: text.length, originalLines: lineCount(text), truncated },
		},
	};
}

export function registerCompactToolOutput(pi: ExtensionAPI): void {
	if (!compactToolOutputEnabled() || typeof pi.registerTool !== "function") return;

	pi.registerTool({
		...getBuiltInTools(process.cwd()).read,
		execute: (toolCallId, params, signal, onUpdate, ctx) => getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", readSummary(args))}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "… reading"), 0, 0);
			const details = result.details as ReadToolDetails | undefined;
			const suffix = details?.truncation?.truncated ? theme.fg("warning", " truncated") : "";
			return new Text(`${statusText(theme, context.isError, "read")}${suffix}`, 0, 0);
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).write,
		execute: (toolCallId, params, signal, onUpdate, ctx) => getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", writeSummary(args))}`, 0, 0);
		},
		renderResult(_result, { isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "… writing"), 0, 0);
			return new Text(statusText(theme, context.isError, "written"), 0, 0);
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).edit,
		execute: (toolCallId, params, signal, onUpdate, ctx) => getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", editSummary(args))}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "… editing"), 0, 0);
			const details = result.details as EditToolDetails | undefined;
			const diff = details?.diff ? theme.fg("dim", " diff recorded") : "";
			return new Text(`${statusText(theme, context.isError, "edited", "edited")}${diff}`, 0, 0);
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).bash,
		execute: (toolCallId, params, signal, onUpdate, ctx) => getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", bashSummary(args))}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "… running"), 0, 0);
			const details = result.details as BashToolDetails | undefined;
			const lines = outputLineCount(result);
			const suffix = `${theme.fg("dim", lines ? ` ${lines} line${lines === 1 ? "" : "s"}` : " no output")}${details?.truncation?.truncated ? theme.fg("warning", " truncated") : ""}`;
			return new Text(`${statusText(theme, context.isError, "exit 0", bashStatusLabel(result, context.isError))}${suffix}`, 0, 0);
		},
	});
}
