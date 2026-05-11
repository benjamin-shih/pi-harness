import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AmbientContextSnapshot } from "./ambient-context";
import type { RemoteCiGuardResult } from "./remote-ci-guard";
import { remoteCiVisibilitySummary } from "./remote-ci-guard";
import { formatVisibilityBox, type VisibilityBoxOptions, visibilityBoxSentinel } from "./visibility-box";

const FOOTER_TITLE = "Harness visibility";
const FOOTER_SENTINEL = visibilityBoxSentinel(FOOTER_TITLE);

export type FinalVisibilityFormatOptions = VisibilityBoxOptions;

export type FinalTaskVisibility = {
	state: "bound" | "not_bound" | "blocked" | "unavailable";
	activity: { reads: number; writes: number; commands: number; errors: number };
	artifacts: { recordedThisTurn: number; skippedThisTurn: number };
};

export type FinalVisibilityState = {
	ambient?: AmbientContextSnapshot;
	mode?: string;
	task?: FinalTaskVisibility;
	remoteCi?: RemoteCiGuardResult;
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

export function formatFinalVisibility(state: FinalVisibilityState | undefined, options: FinalVisibilityFormatOptions = {}): string | undefined {
	const weight = state?.ambient?.weight;
	if (!state || weight === "trivial") return undefined;
	const execution = laneSummary(state.ambient, "execution");
	const activity = activitySummary(state.task);
	const artifacts = artifactSummary(state.task);
	const rows: Array<[string, string]> = [
		["ambient", [weight ?? "unknown", state.mode ? `mode ${state.mode}` : undefined, `task ${taskSummary(state.task)}`].filter(Boolean).join(" · ")],
	];
	if (execution) rows.push(["exec", displayExecution(execution)]);
	if (activity || artifacts) rows.push(["turn", [activity ? `activity ${activity}` : undefined, artifacts ? `artifacts ${artifacts}` : undefined].filter(Boolean).join(" · ")]);
	const remoteCi = remoteCiVisibilitySummary(state.remoteCi);
	if (remoteCi) rows.push(["ci", remoteCi]);
	rows.push(["memory", [laneIncluded(state.ambient, "memory") ? "approved yes" : "approved no", "durable writes no", "vector off"].join(" · ")]);
	return formatVisibilityBox(FOOTER_TITLE, rows, options);
}

export function appendFinalVisibilityToAssistantMessage(message: AssistantMessage, state: FinalVisibilityState | undefined, options: FinalVisibilityFormatOptions = {}): AssistantMessage {
	if (message.content.some((block) => block.type === "text" && block.text.includes(FOOTER_SENTINEL))) return message;
	const footer = formatFinalVisibility(state, options);
	if (!footer) return message;
	return { ...message, content: [...message.content, { type: "text" as const, text: `\n\n${footer}` }] };
}
