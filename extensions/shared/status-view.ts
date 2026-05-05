import type { AmbientContextSnapshot } from "./ambient-context";
import type { MemoryStatsResult } from "./memory-context";
import { formatVisibilityBox, type VisibilityBoxRow } from "./visibility-box";
import type { MemorySpineDiagnostics } from "../session-continuity/diagnostics";

export type StatusViewFacts = {
	cwd: string;
	model: string;
	thinking: string;
	context: string;
	git: { branch?: string; summary: string };
	activeTools: string[];
	sessionEntries: number;
	memory: MemorySpineDiagnostics;
	memoryApi: MemoryStatsResult;
};

export type StatusViewTaskLayer = {
	statusLines(): string[];
	health(): "ok" | "warning";
};

const WRITE_SEMANTICS_STATUS_VALUE = "durable explicit-only · task ops automatic · artifacts metadata-only";

function statusHealth(facts: StatusViewFacts, taskLayer: StatusViewTaskLayer): "ok" | "warning" {
	return facts.memory.health === "warning" || taskLayer.health() === "warning" ? "warning" : "ok";
}

function statusBox(title: string, rows: VisibilityBoxRow[]): string {
	return formatVisibilityBox(title, rows, { labelWidth: 8 });
}

function harnessRows(facts: StatusViewFacts, taskLayer: StatusViewTaskLayer): VisibilityBoxRow[] {
	return [
		["health", statusHealth(facts, taskLayer)],
		["model", `${facts.model} · ${facts.thinking}`],
		["context", facts.context],
		["tools", facts.activeTools.length ? facts.activeTools.join(" ") : "none"],
		["entries", `${facts.sessionEntries} session entries`],
	];
}

function repoRows(facts: StatusViewFacts): VisibilityBoxRow[] {
	return [
		["cwd", facts.cwd],
		["git", `${facts.git.branch ? `${facts.git.branch} · ` : ""}${facts.git.summary}`],
	];
}

function taskStateRows(value: string): VisibilityBoxRow[] {
	if (value === "none") {
		return [
			["state", "not bound this session yet"],
			["hint", "run a nontrivial turn to bind or reuse task context"],
		];
	}
	if (value.startsWith("none")) return [["state", `not bound · ${value.replace(/^none\s*/, "") || "binding skipped"}`]];
	if (value.startsWith("blocked") || value.startsWith("unavailable")) return [["state", value]];
	return [["state", `bound · ${value}`]];
}

function taskRows(taskLayer: StatusViewTaskLayer): VisibilityBoxRow[] {
	// Task layer currently exposes display lines; map only known labels for status rendering.
	const rows = taskLayer.statusLines().flatMap((line): VisibilityBoxRow[] => {
		const [rawLabel, ...rest] = line.replace(/^[-*]\s*/, "").split(":");
		const value = rest.join(":").trim();
		if (!value) return [];
		if (rawLabel === "active task") return taskStateRows(value);
		if (rawLabel === "task project") return [["project", value]];
		if (rawLabel === "task runtime/session") return [["runtime", value]];
		if (rawLabel === "task artifacts") return [["artifact", value]];
		return [[rawLabel.slice(0, 8), value]];
	});
	return rows.length ? rows : [["state", "unknown"]];
}

function executionSummary(snapshot: AmbientContextSnapshot | undefined): string {
	return snapshot?.lanes.find((lane) => lane.id === "execution" && lane.status === "included")?.publicSummary ?? "not active";
}

function ambientRows(snapshot: AmbientContextSnapshot | undefined): VisibilityBoxRow[] {
	if (!snapshot) {
		return [
			["state", "not assembled this session yet"],
			["hint", "appears after the next agent turn"],
		];
	}
	const included = snapshot.lanes.filter((lane) => lane.status === "included").length;
	const skipped = snapshot.lanes.length - included;
	return [
		["weight", snapshot.weight],
		["lanes", `${included} included · ${skipped} skipped`],
		["exec", executionSummary(snapshot)],
		["memory", `personal ${snapshot.personalContext} · advisory ${snapshot.advisorySubagents} · vector ${snapshot.vectorMemory ? "on" : "off"}`],
	];
}

function memoryRows(facts: StatusViewFacts): VisibilityBoxRow[] {
	const stats = facts.memoryApi;
	const unavailableReason = stats.reason === "no scoped project or task" ? "waiting for task/project scope" : (stats.reason ?? "unknown");
	const scoped = stats.available
		? `${stats.scope} · ${stats.counts.candidate} candidate · ${stats.counts.approved} approved · ${stats.counts.deprecated} deprecated · ${stats.skipped} skipped`
		: `unavailable · ${unavailableReason}`;
	const rows: VisibilityBoxRow[] = [
		["spine", `${facts.memory.health} · ${facts.memory.status}`],
		["entries", `${facts.memory.checkpointCount} checkpoints · ${facts.memory.harnessCompactionCount}/${facts.memory.compactionCount} compactions · ${facts.memory.diagnosticCount} diagnostics`],
		["scoped", scoped],
		["write", WRITE_SEMANTICS_STATUS_VALUE],
	];
	if (stats.available && stats.counts.candidate > 0) rows.splice(3, 0, ["review", `${stats.counts.candidate} candidate${stats.counts.candidate === 1 ? "" : "s"} pending`]);
	return rows;
}

export function formatStatusView(facts: StatusViewFacts, taskLayer: StatusViewTaskLayer, ambientContext?: AmbientContextSnapshot): string {
	return [
		statusBox("Harness", harnessRows(facts, taskLayer)),
		"",
		statusBox("Task", taskRows(taskLayer)),
		"",
		statusBox("Ambient", ambientRows(ambientContext)),
		"",
		statusBox("Memory", memoryRows(facts)),
		"",
		statusBox("Repo", repoRows(facts)),
	].join("\n");
}
