import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

function formatCount(n: number): string {
	if (n < 1_000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}m`;
}

const SEGMENT_BG = "customMessageBg";
const FOOTER_MAUVE = "\x1b[38;2;203;166;247m";
const FOOTER_PINK = "\x1b[38;2;245;194;231m";

type FooterColor = string | ((text: string) => string);
type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	subagentInput: number;
	subagentOutput: number;
	subagentCacheRead: number;
	subagentCacheWrite: number;
	subagentCost: number;
};

type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number | { total?: number };
};

type StatusItem = {
	label: string;
	value: string;
	color: FooterColor;
	labelColor?: FooterColor;
	bg?: string;
};

type StatusRule = {
	matches(key: string, value: string): boolean;
	item(key: string, value: string): StatusItem;
};

function mauve(text: string): string {
	return `${FOOTER_MAUVE}${text}\x1b[39m`;
}

function pink(text: string): string {
	return `${FOOTER_PINK}${text}\x1b[39m`;
}

function applyFooterColor(theme: any, color: FooterColor, text: string): string {
	return typeof color === "function" ? color(text) : theme.fg(color, text);
}

function fgFromBg(theme: any, bgColor: string, text: string): string {
	const bgAnsi = theme.getBgAnsi(bgColor) as string;
	const fgAnsi = bgAnsi.replace("[48;", "[38;");
	return `${fgAnsi}${text}\x1b[39m`;
}

function segment(theme: any, label: string, value: string, color: FooterColor = "text", bgColor = SEGMENT_BG, labelColor: FooterColor = pink): string {
	return (
		fgFromBg(theme, bgColor, "") +
		theme.bg(bgColor, applyFooterColor(theme, labelColor, ` ${label} `) + applyFooterColor(theme, color, ` ${value} `)) +
		fgFromBg(theme, bgColor, "")
	);
}

function fits(width: number, left: string, right: string): boolean {
	const gap = left && right ? 1 : 0;
	return visibleWidth(left) + gap + visibleWidth(right) <= width;
}

function footerLine(width: number, left: string, right: string): string {
	if (width <= 0) return "";
	if (!left) return truncateToWidth(right, width, "");
	if (!right) return truncateToWidth(left, width, "");

	const minGap = 1;
	const rightWidth = visibleWidth(right);
	const maxLeftWidth = width - rightWidth - minGap;
	if (maxLeftWidth <= 0) return truncateToWidth(right, width, "");

	const safeLeft = truncateToWidth(left, maxLeftWidth, "");
	const padding = " ".repeat(Math.max(minGap, width - visibleWidth(safeLeft) - rightWidth));
	return truncateToWidth(safeLeft + padding + right, width, "");
}

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function cleanStatusValue(value: unknown): string {
	return stripAnsi(String(value ?? "")).replace(/\s+/g, " ").trim();
}

function memoryStatusColor(value: string): string {
	if (/\b(?:fallback|default|aborted|error|fail)\b/i.test(value)) return "warning";
	if (/\bcompact\b/i.test(value)) return "warning";
	if (/\b(?:saved|compacted)\b/i.test(value)) return "success";
	return "muted";
}

function compactMemoryValue(value: string): string {
	const clean = value.replace(/^memory:/i, "");
	const match = clean.match(/^([^:]+):?(\d+)?$/);
	if (!match) return truncateToWidth(clean, 12, "…");
	const label = match[1] ?? clean;
	const count = match[2] ?? "";
	const shortLabel: Record<string, string> = {
		ready: "r",
		saved: "s",
		compact: "c",
		compacted: "ok",
		fallback: "fb",
		default: "def",
		aborted: "abort",
	};
	return `${shortLabel[label] ?? truncateToWidth(label, 6, "…")}${count}`;
}

function compactTimerValue(value: string): string {
	return truncateToWidth(value.replace(/^(?:elapsed|last):/i, ""), 8, "…");
}

const STATUS_RULES: StatusRule[] = [
	{
		matches: (key, value) => key === "memory" || value.startsWith("memory:"),
		item: (_key, value) => ({ label: "mem", value: compactMemoryValue(value), color: memoryStatusColor(value) }),
	},
	{
		matches: (key, value) => key === "turn-timer" || /^(?:elapsed|last):/i.test(value),
		item: (_key, value) => ({ label: "time", value: compactTimerValue(value), color: "syntaxNumber", labelColor: "text", bg: "selectedBg" }),
	},
	{
		matches: (key, value) => key === "latex-preview" || value.startsWith("latex:") || value.startsWith("tex:"),
		item: (_key, value) => ({ label: "tex", value: truncateToWidth(value.replace(/^(?:latex|tex):/i, ""), 8, "…"), color: "customMessageLabel" }),
	},
	{
		matches: (key, value) => key === "mode" || value.startsWith("mode:"),
		item: (_key, value) => ({ label: "mode", value: truncateToWidth(value.replace(/^mode:/i, ""), 8, "…"), color: "accent" }),
	},
];

function compactStatusItem(key: string, value: string): StatusItem {
	return STATUS_RULES.find((rule) => rule.matches(key, value))?.item(key, value) ?? { label: truncateToWidth(key, 6, "…"), value: truncateToWidth(value, 10, "…"), color: "muted" };
}

export function compactExtensionStatusItems(statuses: ReadonlyMap<string, unknown> | Iterable<[string, unknown]>): StatusItem[] {
	const entries = statuses instanceof Map ? [...statuses.entries()] : [...statuses];
	const items: StatusItem[] = [];
	for (const [key, rawValue] of entries) {
		const value = cleanStatusValue(rawValue);
		if (value) items.push(compactStatusItem(key, value));
	}
	return items;
}

function emptyUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		subagentInput: 0,
		subagentOutput: 0,
		subagentCacheRead: 0,
		subagentCacheWrite: 0,
		subagentCost: 0,
	};
}

function costValue(cost: UsageLike["cost"]): number {
	if (typeof cost === "number") return cost;
	return cost?.total ?? 0;
}

function addUsage(target: UsageTotals, usage: UsageLike | undefined, source: "parent" | "subagent"): void {
	if (!usage) return;
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const cost = costValue(usage.cost);
	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.cost += cost;
	if (source === "subagent") {
		target.subagentInput += input;
		target.subagentOutput += output;
		target.subagentCacheRead += cacheRead;
		target.subagentCacheWrite += cacheWrite;
		target.subagentCost += cost;
	}
}

function usageHasValues(usage: UsageLike | undefined): boolean {
	return Boolean(usage && ((usage.input ?? 0) || (usage.output ?? 0) || (usage.cacheRead ?? 0) || (usage.cacheWrite ?? 0) || costValue(usage.cost)));
}

function addSubagentDetailsUsage(target: UsageTotals, details: unknown): void {
	const candidate = details as { results?: Array<{ usage?: UsageLike; modelAttempts?: Array<{ usage?: UsageLike }> }> } | undefined;
	if (!Array.isArray(candidate?.results)) return;
	for (const result of candidate.results) {
		if (usageHasValues(result.usage)) {
			addUsage(target, result.usage, "subagent");
			continue;
		}
		for (const attempt of result.modelAttempts ?? []) {
			if (usageHasValues(attempt.usage)) addUsage(target, attempt.usage, "subagent");
		}
	}
}

function subagentDetailsFromEntry(entry: unknown): unknown {
	const e = entry as {
		type?: string;
		customType?: string;
		details?: unknown;
		message?: { role?: string; toolName?: string; customType?: string; details?: unknown };
	};
	if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "subagent") return e.message.details;
	if (e.type === "message" && e.message?.role === "custom" && e.message.customType === "subagent-slash-result") {
		return (e.message.details as { result?: { details?: unknown } } | undefined)?.result?.details;
	}
	if (e.type === "custom_message" && e.customType === "subagent-slash-result") {
		return (e.details as { result?: { details?: unknown } } | undefined)?.result?.details;
	}
	return undefined;
}

export function calculateFooterUsage(entries: readonly unknown[]): UsageTotals {
	const totals = emptyUsageTotals();
	for (const entry of entries) {
		const e = entry as { type?: string; message?: { role?: string; usage?: UsageLike } };
		if (e.type === "message" && e.message?.role === "assistant") addUsage(totals, e.message.usage, "parent");
		addSubagentDetailsUsage(totals, subagentDetailsFromEntry(entry));
	}
	return totals;
}

export function installCatppuccinFooter(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const branchEntries = ctx.sessionManager.getBranch();
					const usage = calculateFooterUsage(branchEntries);
					let compacts = 0;
					for (const entry of branchEntries) {
						if (entry.type === "compaction") compacts++;
					}

					const input = usage.input;
					const output = usage.output;
					const cache = usage.cacheRead + usage.cacheWrite;
					const total = input + output + cache;
					const subagentTotal = usage.subagentInput + usage.subagentOutput + usage.subagentCacheRead + usage.subagentCacheWrite;
					const cost = usage.cost;
					const branch = footerData.getGitBranch();
					const statusItems = compactExtensionStatusItems(footerData.getExtensionStatuses());
					const model = ctx.model?.id ?? "no-model";
					const thinkingLevel = pi.getThinkingLevel();
					const sep = theme.fg("dim", " ");

					const piMark = mauve(" π ");
					const subagentSegment = subagentTotal > 0 ? segment(theme, "sub", formatCount(subagentTotal), "customMessageLabel") : "";
					const fullLeft = [
						piMark,
						segment(theme, "tok", formatCount(total), "text"),
						segment(theme, "in", formatCount(input), "syntaxFunction"),
						segment(theme, "out", formatCount(output), "success"),
						segment(theme, "cache", formatCount(cache), "mdCode"),
						subagentSegment,
						segment(theme, "compact", `${compacts}`, compacts > 0 ? "warning" : "dim"),
						segment(theme, "$", cost.toFixed(3), "syntaxNumber"),
					]
						.filter(Boolean)
						.join(sep);

					const mediumLeft = [
						piMark,
						segment(theme, "tok", formatCount(total), "text"),
						segment(theme, "in", formatCount(input), "syntaxFunction"),
						segment(theme, "out", formatCount(output), "success"),
						subagentSegment,
						segment(theme, "$", cost.toFixed(3), "syntaxNumber"),
						compacts > 0 ? segment(theme, "cmp", `${compacts}`, "warning") : "",
					]
						.filter(Boolean)
						.join(sep);

					const compactLeft = [
						piMark,
						theme.fg("muted", `tok ${formatCount(total)}`),
						theme.fg("dim", `$${cost.toFixed(3)}`),
					].join(sep);

					const statusSegments = statusItems.map((item) => segment(theme, item.label, item.value, item.color, item.bg, item.labelColor)).join(sep);
					const modelSegment = segment(theme, "model", model, mauve);
					const thinkSegment = segment(theme, "think", thinkingLevel, thinkingLevel === "off" ? "dim" : "warning");
					const modelAndThinking = [modelSegment, thinkSegment].join(sep);
					const statusesModelAndThinking = [statusSegments, modelAndThinking].filter(Boolean).join(sep);
					const branchSegment = branch ? segment(theme, "git", ` ${branch}`, "muted") : undefined;
					const fullRight = branchSegment
						? [statusesModelAndThinking, branchSegment].filter(Boolean).join(theme.fg("dim", "  │  "))
						: statusesModelAndThinking;
					const compactRight = theme.fg("muted", `${model} ${thinkingLevel === "off" ? "" : thinkingLevel}`.trim());

					const variants = [
						{ left: fullLeft, right: fullRight },
						{ left: fullLeft, right: statusesModelAndThinking },
						{ left: fullLeft, right: modelAndThinking },
						{ left: mediumLeft, right: fullRight },
						{ left: mediumLeft, right: statusesModelAndThinking },
						{ left: mediumLeft, right: modelAndThinking },
						{ left: compactLeft, right: statusesModelAndThinking },
						{ left: compactLeft, right: modelAndThinking },
						{ left: compactLeft, right: compactRight },
						{ left: piMark, right: modelAndThinking },
						{ left: piMark, right: compactRight },
						{ left: "", right: compactRight },
						{ left: piMark, right: "" },
					];
					const selected = variants.find((variant) => fits(width, variant.left, variant.right)) ?? variants.at(-1)!;
					return [footerLine(width, selected.left, selected.right)];
				},
			};
		});
	});
}
