import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { agentsScriptPath } from "./config";

export type MemoryContextScope = {
	projectRoot?: string;
	taskId?: string;
};

export type MemoryContextResult = {
	content?: string;
	reason?: string;
	included: number;
	omitted: number;
};

export type MemoryStatsResult = {
	available: boolean;
	reason?: string;
	counts: { candidate: number; approved: number; deprecated: number };
	skipped: number;
	scope: "project" | "task" | "none";
};

type MemoryPayload = {
	memory_api_version?: number;
	context?: string;
	included?: unknown[];
	omitted?: unknown[];
};

type MemoryStatsPayload = {
	memory_api_version?: number;
	counts_by_state?: Partial<Record<"candidate" | "approved" | "deprecated", number>>;
	skipped?: number;
};

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function memoryCandidateReminder(enabled: boolean): string | undefined {
	if (!enabled) return undefined;
	return [
		"## Durable Memory Candidate Discipline",
		"If this turn establishes a durable user preference, repo convention, or future-useful decision, mention at most 3 concise memory candidate bullets in the final response.",
		"Do not create, promote, or modify memory unless the user explicitly asks; candidates are suggestions only.",
	].join("\n");
}

function emptyStats(available: boolean, reason: string, scope: MemoryStatsResult["scope"] = "none"): MemoryStatsResult {
	return { available, reason, counts: { candidate: 0, approved: 0, deprecated: 0 }, skipped: 0, scope };
}

export async function buildMemoryStats(pi: ExtensionAPI, cwd: string, scope: MemoryContextScope): Promise<MemoryStatsResult> {
	const scopedBy = scope.projectRoot ? "project" : (scope.taskId ? "task" : "none");
	if (!scope.projectRoot && !scope.taskId) return emptyStats(false, "no scoped project or task", scopedBy);
	try {
		const args = [agentsScriptPath("memory-stats.sh"), "--cwd", cwd, "--json"];
		if (scope.projectRoot) args.push("--project-root", scope.projectRoot);
		if (scope.taskId) args.push("--task-id", scope.taskId);
		const result = await pi.exec("bash", args, { cwd, timeout: 5_000 });
		if (result.code !== 0) return emptyStats(false, "memory API unavailable", scopedBy);
		const payload = parseJson<MemoryStatsPayload>(result.stdout);
		if (payload?.memory_api_version !== 1) return emptyStats(false, "memory API unavailable", scopedBy);
		const counts = payload.counts_by_state ?? {};
		return {
			available: true,
			counts: {
				candidate: counts.candidate ?? 0,
				approved: counts.approved ?? 0,
				deprecated: counts.deprecated ?? 0,
			},
			skipped: payload.skipped ?? 0,
			scope: scopedBy,
		};
	} catch {
		return emptyStats(false, "memory API unavailable", scopedBy);
	}
}

export function formatMemoryStatsLines(stats: MemoryStatsResult): string[] {
	if (!stats.available) return [`- scoped memory API: unavailable (${stats.reason})`];
	const { candidate, approved, deprecated } = stats.counts;
	return [`- scoped memory API: ok (${stats.scope}; ${candidate} candidate, ${approved} approved, ${deprecated} deprecated; ${stats.skipped} skipped)`];
}

export async function buildMemoryContext(pi: ExtensionAPI, cwd: string, scope: MemoryContextScope): Promise<MemoryContextResult> {
	if (!scope.projectRoot) return { reason: "no scoped project root", included: 0, omitted: 0 };
	try {
		const args = [
			agentsScriptPath("memory-context.sh"),
			"--project-root", scope.projectRoot,
			"--cwd", cwd,
			"--max-records", "5",
			"--max-chars", "2000",
			"--json",
		];
		if (scope.taskId) args.push("--task-id", scope.taskId);
		const result = await pi.exec("bash", args, { cwd, timeout: 5_000 });
		if (result.code !== 0) return { reason: "memory API unavailable", included: 0, omitted: 0 };
		const payload = parseJson<MemoryPayload>(result.stdout);
		if (payload?.memory_api_version !== 1) return { reason: "memory API unavailable", included: 0, omitted: 0 };
		const content = payload.context?.trim() || undefined;
		const included = Array.isArray(payload.included) ? payload.included.length : 0;
		const omitted = Array.isArray(payload.omitted) ? payload.omitted.length : 0;
		return { content, reason: content ? undefined : "no approved scoped memory", included, omitted };
	} catch {
		return { reason: "memory API unavailable", included: 0, omitted: 0 };
	}
}
