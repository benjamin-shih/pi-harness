import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AmbientContextSnapshot } from "./ambient-context";

const FOOTER_PREFIX = "Harness visibility:";
const MAX_FOOTER_CHARS = 320;

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
	if (!task) return "task ops: unavailable";
	if (task.state === "blocked") return "task ops: blocked";
	if (task.state === "unavailable") return "task ops: unavailable";
	if (task.state === "not_bound") return "task ops: not bound";
	return "task ops: bound";
}

function activitySummary(task: FinalTaskVisibility | undefined): string | undefined {
	if (!task) return undefined;
	const { reads, writes, commands, errors } = task.activity;
	if (!reads && !writes && !commands && !errors) return undefined;
	return `activity: r${reads}/w${writes}/c${commands}/e${errors}`;
}

function artifactSummary(task: FinalTaskVisibility | undefined): string | undefined {
	if (!task) return undefined;
	const { recordedThisTurn, skippedThisTurn } = task.artifacts;
	if (!recordedThisTurn && !skippedThisTurn) return undefined;
	const recordedLabel = recordedThisTurn === 1 ? "metadata record" : "metadata records";
	const skipped = skippedThisTurn ? `, ${skippedThisTurn} skipped` : "";
	return `artifacts: ${recordedThisTurn} ${recordedLabel}${skipped}`;
}

function bounded(line: string): string {
	return line.length <= MAX_FOOTER_CHARS ? line : `${line.slice(0, MAX_FOOTER_CHARS - 1)}…`;
}

export function formatFinalVisibility(state: FinalVisibilityState | undefined): string | undefined {
	const weight = state?.ambient?.weight;
	if (!state || weight === "trivial") return undefined;
	const execution = laneSummary(state.ambient, "execution");
	const segments = [
		`ambient: ${weight ?? "unknown"}`,
		state.mode ? `mode: ${state.mode}` : undefined,
		execution ? `execution: ${execution}` : undefined,
		taskSummary(state.task),
		activitySummary(state.task),
		artifactSummary(state.task),
		laneIncluded(state.ambient, "memory") ? "approved memory: included" : "approved memory: none included",
		"auto durable memory writes: none",
		"vector memory: off",
	].filter((segment): segment is string => Boolean(segment));
	return bounded(`_${FOOTER_PREFIX} ${segments.join("; ")}._`);
}

export function appendFinalVisibilityToAssistantMessage(message: AssistantMessage, state: FinalVisibilityState | undefined): AssistantMessage {
	if (message.content.some((block) => block.type === "text" && block.text.includes(FOOTER_PREFIX))) return message;
	const footer = formatFinalVisibility(state);
	if (!footer) return message;
	return { ...message, content: [...message.content, { type: "text" as const, text: `\n\n${footer}` }] };
}
