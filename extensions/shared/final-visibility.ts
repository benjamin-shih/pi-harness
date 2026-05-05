import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AmbientContextSnapshot } from "./ambient-context";

const FOOTER_TITLE = "Harness visibility";
const FOOTER_SENTINEL = "╭─ Harness";
const DEFAULT_TERMINAL_COLUMNS = 72;
const MIN_BOX_WIDTH = 12;
const MAX_BOX_WIDTH = 96;
const LABEL_WIDTH = 8;
const RESET = "\x1b[0m";
const DIM_CYAN = "\x1b[36;2m";
const BOLD_CYAN = "\x1b[36;1m";
const SOFT_GREEN = "\x1b[32m";
const SOFT_AMBER = "\x1b[33m";

export type FinalVisibilityFormatOptions = {
	columns?: number;
	color?: boolean;
};

export type FinalTaskVisibility = {
	state: "bound" | "not_bound" | "blocked" | "unavailable";
	activity: { reads: number; writes: number; commands: number; errors: number };
	artifacts: { recordedThisTurn: number; skippedThisTurn: number };
};

export type FinalVisibilityState = {
	ambient?: AmbientContextSnapshot;
	mode?: string;
	task?: FinalTaskVisibility;
};

function laneIncluded(snapshot: AmbientContextSnapshot | undefined, id: string): boolean {
	return snapshot?.lanes.some((lane) => lane.id === id && lane.status === "included") ?? false;
}

function laneSummary(snapshot: AmbientContextSnapshot | undefined, id: string): string | undefined {
	return snapshot?.lanes.find((lane) => lane.id === id && lane.status === "included")?.publicSummary;
}

function taskSummary(task: FinalTaskVisibility | undefined): string {
	if (!task) return "unavailable";
	if (task.state === "not_bound") return "not bound";
	return task.state;
}

function activitySummary(task: FinalTaskVisibility | undefined): string | undefined {
	if (!task) return undefined;
	const { reads, writes, commands, errors } = task.activity;
	if (!reads && !writes && !commands && !errors) return undefined;
	return `r${reads}/w${writes}/c${commands}/e${errors}`;
}

function artifactSummary(task: FinalTaskVisibility | undefined): string | undefined {
	if (!task) return undefined;
	const { recordedThisTurn, skippedThisTurn } = task.artifacts;
	if (!recordedThisTurn && !skippedThisTurn) return undefined;
	const skipped = skippedThisTurn ? ` +${skippedThisTurn} skipped` : "";
	return `${recordedThisTurn} meta${skipped}`;
}

function displayExecution(summary: string): string {
	return summary.replace(/^profile\s+/, "").replace("; overlays ", " · overlays ");
}

function clip(value: string, width: number): string {
	if (width <= 0) return "";
	return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function terminalColumns(): number {
	const envColumns = Number.parseInt(process.env.COLUMNS ?? "", 10);
	return process.stdout.columns || (Number.isFinite(envColumns) ? envColumns : DEFAULT_TERMINAL_COLUMNS);
}

function boxWidth(columns: number | undefined): number {
	return Math.min(MAX_BOX_WIDTH, Math.max(MIN_BOX_WIDTH, (columns ?? terminalColumns()) - 2));
}

function supportsColor(color: boolean | undefined): boolean {
	return color === true;
}

function paint(value: string, code: string, color: boolean): string {
	return color ? `${code}${value}${RESET}` : value;
}

function boxRow(label: string, value: string, innerWidth: number, color: boolean): string {
	const labelText = label.padEnd(LABEL_WIDTH);
	const valueWidth = Math.max(0, innerWidth - LABEL_WIDTH - 2);
	const valueText = clip(value, valueWidth);
	const padding = " ".repeat(Math.max(0, innerWidth - LABEL_WIDTH - valueText.length - 2));
	return [
		paint("│", DIM_CYAN, color),
		" ",
		paint(labelText, BOLD_CYAN, color),
		" ",
		paint(valueText, label === "memory" ? SOFT_AMBER : SOFT_GREEN, color),
		padding,
		paint("│", DIM_CYAN, color),
	].join("");
}

function box(lines: Array<[string, string]>, options: FinalVisibilityFormatOptions): string {
	const innerWidth = Math.max(0, boxWidth(options.columns) - 2);
	const color = supportsColor(options.color);
	const title = clip(`─ ${FOOTER_TITLE} `, innerWidth);
	const top = `╭${title}${"─".repeat(Math.max(0, innerWidth - title.length))}╮`;
	return [
		paint(top, DIM_CYAN, color),
		...lines.map(([label, value]) => boxRow(label, value, innerWidth, color)),
		paint(`╰${"─".repeat(innerWidth)}╯`, DIM_CYAN, color),
	].join("\n");
}

export function formatFinalVisibility(state: FinalVisibilityState | undefined, options: FinalVisibilityFormatOptions = {}): string | undefined {
	const weight = state?.ambient?.weight;
	if (!state || weight === "trivial") return undefined;
	const execution = laneSummary(state.ambient, "execution");
	const activity = activitySummary(state.task);
	const artifacts = artifactSummary(state.task);
	const lines: Array<[string, string]> = [
		["ambient", [weight ?? "unknown", state.mode ? `mode ${state.mode}` : undefined, `task ${taskSummary(state.task)}`].filter(Boolean).join(" · ")],
	];
	if (execution) lines.push(["exec", displayExecution(execution)]);
	if (activity || artifacts) lines.push(["turn", [activity ? `activity ${activity}` : undefined, artifacts ? `artifacts ${artifacts}` : undefined].filter(Boolean).join(" · ")]);
	lines.push(["memory", [laneIncluded(state.ambient, "memory") ? "approved yes" : "approved no", "durable writes no", "vector off"].join(" · ")]);
	return box(lines, options);
}

export function appendFinalVisibilityToAssistantMessage(message: AssistantMessage, state: FinalVisibilityState | undefined, options: FinalVisibilityFormatOptions = {}): AssistantMessage {
	if (message.content.some((block) => block.type === "text" && block.text.includes(FOOTER_SENTINEL))) return message;
	const footer = formatFinalVisibility(state, options);
	if (!footer) return message;
	return { ...message, content: [...message.content, { type: "text" as const, text: `\n\n${footer}` }] };
}
