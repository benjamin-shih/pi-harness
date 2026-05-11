import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

function statusText(result: AgentToolResult<unknown>, theme: Theme, okLabel = "ok"): string {
	return (result as { isError?: boolean }).isError ? theme.fg("error", "✗ failed") : theme.fg("success", `✓ ${okLabel}`);
}

function outputLineCount(result: AgentToolResult<unknown>): number {
	const text = result.content.find((item) => item.type === "text");
	if (!text || text.type !== "text" || !text.text.trim()) return 0;
	return text.text.split("\n").filter((line) => line.trim()).length;
}

export function registerCompactToolOutput(pi: ExtensionAPI): void {
	if (!compactToolOutputEnabled() || typeof pi.registerTool !== "function") return;

	pi.registerTool({
		...getBuiltInTools(process.cwd()).read,
		execute: (toolCallId, params, signal, onUpdate, ctx) => getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", readSummary(args))}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "… reading"), 0, 0);
			const details = result.details as ReadToolDetails | undefined;
			const suffix = details?.truncation?.truncated ? theme.fg("warning", " truncated") : "";
			return new Text(`${statusText(result, theme, "read")}${suffix}`, 0, 0);
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).write,
		execute: (toolCallId, params, signal, onUpdate, ctx) => getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", writeSummary(args))}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "… writing"), 0, 0);
			return new Text(statusText(result, theme, "written"), 0, 0);
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).edit,
		execute: (toolCallId, params, signal, onUpdate, ctx) => getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", editSummary(args))}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "… editing"), 0, 0);
			const details = result.details as EditToolDetails | undefined;
			const diff = details?.diff ? theme.fg("dim", " diff recorded") : "";
			return new Text(`${statusText(result, theme, "edited")}${diff}`, 0, 0);
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).bash,
		execute: (toolCallId, params, signal, onUpdate, ctx) => getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", bashSummary(args))}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "… running"), 0, 0);
			const details = result.details as BashToolDetails | undefined;
			const lines = outputLineCount(result);
			const suffix = `${theme.fg("dim", lines ? ` ${lines} line${lines === 1 ? "" : "s"}` : " no output")}${details?.truncation?.truncated ? theme.fg("warning", " truncated") : ""}`;
			return new Text(`${statusText(result, theme, "done")}${suffix}`, 0, 0);
		},
	});
}
