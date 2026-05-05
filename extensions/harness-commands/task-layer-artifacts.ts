import { homedir } from "node:os";
import path from "node:path";
import type { ToolResultEvent } from "@mariozechner/pi-coding-agent";
import type { TaskLayerState } from "./task-layer-types";

type VerificationRule = {
	pattern: RegExp;
	label: string;
};

const VERIFICATION_RULES: VerificationRule[] = [
	{ pattern: /\bnpm\s+run\s+verify\b/, label: "npm verify" },
	{ pattern: /\bnpm\s+run\s+harness:audit\b/, label: "harness audit" },
	{ pattern: /\bnpm\s+run\s+skills:audit\b/, label: "skills audit" },
	{ pattern: /\bmake\s+verify-(?:ci|local)\b/, label: "agents verify" },
	{ pattern: /\bpython3?\s+-m\s+unittest\b/, label: "python unittest" },
	{ pattern: /\bgit\s+diff\s+--check\b/, label: "git diff check" },
];

function shellUnquote(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

export function normalizeCandidatePath(candidate: string): string {
	let value = shellUnquote(candidate.trim()).replace(/\\([\\\s;&|])/g, "$1");
	if (value === "${HOME}") value = homedir();
	else if (value.startsWith("${HOME}/")) value = path.join(homedir(), value.slice(8));
	return value;
}

export function pathFromTool(event: ToolResultEvent, fallbackCwd: string): string | undefined {
	const input = event.input ?? {};
	for (const key of ["path", "cwd"] as const) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return normalizeCandidatePath(value);
	}
	if (event.toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const cdMatch = command.match(/(?:^|[;&|])\s*cd\s+(?:--\s+)?((?:"[^"]+")|(?:'[^']+')|(?:\\.|[^\s;&|])+)/);
		if (cdMatch?.[1]) return normalizeCandidatePath(cdMatch[1]);
	}
	return fallbackCwd;
}

export function activityFromTool(state: TaskLayerState, event: ToolResultEvent): void {
	if (event.toolName === "read" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") state.activity.reads++;
	else if (event.toolName === "edit" || event.toolName === "write") state.activity.writes++;
	else if (event.toolName === "bash") state.activity.commands++;
	if (event.isError) state.activity.errors++;
	state.meaningfulActivity ||= Boolean(state.activity.reads || state.activity.writes || state.activity.commands || state.activity.errors);
}

export function pathArtifactFromTool(event: ToolResultEvent): { title: string; path: string } | undefined {
	if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
	if (event.isError) return undefined;
	const candidate = event.input?.path;
	if (typeof candidate !== "string" || !candidate.trim()) return undefined;
	return { title: event.toolName === "edit" ? "Edited path" : "Wrote path", path: normalizeCandidatePath(candidate) };
}

function verificationLabel(command: string): string | undefined {
	const normalized = command.replace(/\s+/g, " ").trim();
	return VERIFICATION_RULES.find((rule) => rule.pattern.test(normalized))?.label;
}

export function verificationArtifactFromTool(event: ToolResultEvent): { title: string; summary: string } | undefined {
	if (event.toolName !== "bash") return undefined;
	const command = typeof event.input?.command === "string" ? event.input.command : "";
	const label = verificationLabel(command);
	if (!label) return undefined;
	const status = event.isError ? "failed" : "completed";
	return { title: `${label} ${status}`, summary: `Verification command ${status}.` };
}
