import { decideAmbientPolicy, type AmbientPolicy } from "./ambient-policy";
import type { TaskWeight } from "../harness-commands/prompt-guidance";

export type AmbientLaneStatus = "included" | "skipped";

export type AmbientContextLane = {
	id: string;
	title: string;
	priority: number;
	content?: string;
	reason?: string;
};

export type AmbientContextLaneSnapshot = {
	id: string;
	title: string;
	status: AmbientLaneStatus;
	chars: number;
	reason?: string;
};

export type AmbientContextSnapshot = {
	version: "v0";
	weight: TaskWeight;
	lanes: AmbientContextLaneSnapshot[];
	policyReasons: string[];
	personalContext: AmbientPolicy["personalContext"];
	advisorySubagents: AmbientPolicy["advisorySubagents"];
	vectorMemory: false;
};

export type AmbientContextAssembly = {
	systemPrompt: string;
	additions: string[];
	receipt?: string;
	snapshot: AmbientContextSnapshot;
};

const RECEIPT_MAX_CHARS = 1_200;

function cleanInline(value: string | undefined): string | undefined {
	const clean = value?.replace(/\s+/g, " ").trim();
	return clean || undefined;
}

function includedContent(lane: AmbientContextLane): string | undefined {
	const content = lane.content?.trim();
	return content ? content : undefined;
}

function laneSnapshot(lane: AmbientContextLane): AmbientContextLaneSnapshot {
	const content = includedContent(lane);
	return {
		id: lane.id,
		title: lane.title,
		status: content ? "included" : "skipped",
		chars: content?.length ?? 0,
		reason: content ? undefined : cleanInline(lane.reason ?? "empty"),
	};
}

function formatLaneReceipt(lane: AmbientContextLaneSnapshot): string {
	if (lane.status === "included") return `  - ${lane.id}: included, ${lane.chars} chars`;
	return `  - ${lane.id}: skipped${lane.reason ? `, ${lane.reason}` : ""}`;
}

function formatAmbientReceipt(snapshot: AmbientContextSnapshot): string {
	const lines = [
		"## Ambient Context Receipt",
		`- version: ${snapshot.version}`,
		`- prompt weight: ${snapshot.weight}`,
		"- lanes:",
		...snapshot.lanes.map(formatLaneReceipt),
		`- policy: ${snapshot.policyReasons.join(", ") || "none"}`,
		`- personal_context: ${snapshot.personalContext}`,
		`- advisory_subagents: ${snapshot.advisorySubagents}`,
		`- vector_memory: ${snapshot.vectorMemory ? "yes" : "no"}`,
	];
	const receipt = lines.join("\n");
	return receipt.length <= RECEIPT_MAX_CHARS ? receipt : `${receipt.slice(0, RECEIPT_MAX_CHARS - 2)}…`;
}

export function assembleAmbientContext(baseSystemPrompt: string, weight: TaskWeight, lanes: AmbientContextLane[], policy = decideAmbientPolicy(weight)): AmbientContextAssembly {
	const ordered = [...lanes].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
	const additions = ordered.map(includedContent).filter((content): content is string => Boolean(content));
	const snapshot: AmbientContextSnapshot = {
		version: "v0",
		weight,
		lanes: ordered.map(laneSnapshot),
		policyReasons: policy.reasons,
		personalContext: policy.personalContext,
		advisorySubagents: policy.advisorySubagents,
		vectorMemory: policy.vectorMemory,
	};
	const receipt = policy.receipt === "compact" ? formatAmbientReceipt(snapshot) : undefined;
	const promptAdditions = receipt ? [...additions, receipt] : additions;
	return {
		systemPrompt: promptAdditions.length ? `${baseSystemPrompt}\n\n${promptAdditions.join("\n\n")}` : baseSystemPrompt,
		additions: promptAdditions,
		receipt,
		snapshot,
	};
}

export function ambientStatusLines(snapshot: AmbientContextSnapshot | undefined): string[] {
	if (!snapshot) return ["- ambient context: not assembled yet"];
	const included = snapshot.lanes.filter((lane) => lane.status === "included").length;
	const skipped = snapshot.lanes.length - included;
	return [
		`- ambient context: ${snapshot.weight}, ${included} included / ${skipped} skipped lane(s)`,
		`- ambient memory/advisory: personal ${snapshot.personalContext}, advisory ${snapshot.advisorySubagents}, vector memory ${snapshot.vectorMemory ? "on" : "off"}`,
	];
}

export function ambientDoctorSection(snapshot: AmbientContextSnapshot | undefined): string {
	if (!snapshot) return ["## Ambient context", "- status: not assembled yet"].join("\n");
	return [
		"## Ambient context",
		`- version: ${snapshot.version}`,
		`- prompt weight: ${snapshot.weight}`,
		"- lanes:",
		...snapshot.lanes.map(formatLaneReceipt),
		`- policy: ${snapshot.policyReasons.join(", ") || "none"}`,
		`- personal context: ${snapshot.personalContext}`,
		`- advisory subagents: ${snapshot.advisorySubagents}`,
		`- vector memory: ${snapshot.vectorMemory ? "enabled" : "disabled"}`,
	].join("\n");
}
