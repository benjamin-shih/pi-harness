import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AmbientContextSnapshot } from "./ambient-context";

const FOOTER_TITLE = "Harness visibility";
const FOOTER_SENTINEL = `╭─ ${FOOTER_TITLE}`;
const BOX_INNER_WIDTH = 68;
const LABEL_WIDTH = 8;

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
	return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function boxRow(label: string, value: string): string {
	const content = ` ${label.padEnd(LABEL_WIDTH)} ${value}`;
	return `│${clip(content, BOX_INNER_WIDTH).padEnd(BOX_INNER_WIDTH)}│`;
}

function box(lines: Array<[string, string]>): string {
	const title = `─ ${FOOTER_TITLE} `;
	return [
		`╭${title}${"─".repeat(Math.max(0, BOX_INNER_WIDTH - title.length))}╮`,
		...lines.map(([label, value]) => boxRow(label, value)),
		`╰${"─".repeat(BOX_INNER_WIDTH)}╯`,
	].join("\n");
}

export function formatFinalVisibility(state: FinalVisibilityState | undefined): string | undefined {
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
	return box(lines);
}

export function appendFinalVisibilityToAssistantMessage(message: AssistantMessage, state: FinalVisibilityState | undefined): AssistantMessage {
	if (message.content.some((block) => block.type === "text" && block.text.includes(FOOTER_SENTINEL))) return message;
	const footer = formatFinalVisibility(state);
	if (!footer) return message;
	return { ...message, content: [...message.content, { type: "text" as const, text: `\n\n${footer}` }] };
}
