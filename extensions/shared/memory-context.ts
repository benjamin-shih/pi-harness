import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";

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

export function memoryCandidateReminder(enabled: boolean): string | undefined {
	if (!enabled) return undefined;
	return [
		"## Durable Memory Candidate Discipline",
		"If this turn establishes a durable user preference, repo convention, or future-useful decision, mention at most 3 concise memory candidate bullets in the final response.",
		"Do not create, promote, or modify memory unless the user explicitly asks; candidates are suggestions only.",
	].join("\n");
}

function explicitMemoryAction(prompt: string): "add" | "list" | "promote" | "forget" | "review" | undefined {
	const memoryWord = String.raw`memor(?:y|ies)(?![-_.])`;
	const adminTarget = String.raw`(?:durable\s+${memoryWord}|${memoryWord}\s+(?:record|records|candidate|candidates|entry|entries|id|admin)|(?:all\s+)?${memoryWord}\s+for\s+this\s+(?:project|task|repo|repository)|${memoryWord}\s+mem_[a-z0-9_-]+)`;
	const adminVerbs = "remember|add|create|save|store|record|forget|delete|remove|deprecate|approve|promote|list|show|review|triage|audit";
	const reviewTarget = String.raw`(?:${memoryWord}\s+candidate|${memoryWord}\s+candidates|candidate\s+${memoryWord}|candidate\s+memories|pending\s+${memoryWord}|pending\s+memories|${memoryWord}\s+review\s+queue)`;
	const codeContext = /\b(code|diff|uncommitted|serialization|tests?|files?|helper|function|module|shim|class|implementation|guidance|discovery)\b|\.[a-z0-9]{1,5}\b|\bmemory-[a-z0-9_-]+\b/;
	const negatedAdminRequest = new RegExp(String.raw`\b(?:do not|don't|dont|cannot|can't|cant|never)\s+(?:${adminVerbs})\b|\bnot\s+(?:${adminVerbs})\b`);
	const reviewRequest = new RegExp(String.raw`\b(?:review|triage|audit|show|list)\b[^\n]{0,80}${reviewTarget}`);
	const clauses = prompt.toLowerCase().split(/[.!?\n;]|,\s*(?:but|and)\s+/).map((clause) => clause.trim()).filter(Boolean);
	for (const clause of clauses) {
		if (negatedAdminRequest.test(clause)) continue;
		const near = (verbs: string, target = adminTarget, chars = 80) => new RegExp(String.raw`\b(?:${verbs})\b[^\n]{0,${chars}}${target}|${target}[^\n]{0,${chars}}\b(?:${verbs})\b`).test(clause);
		const looksLikeCode = codeContext.test(clause);
		if (!looksLikeCode && reviewRequest.test(clause)) return "review";
		if (!looksLikeCode && (near("forget|delete|remove|deprecate") || new RegExp(String.raw`\bforget\b[^\n]{0,50}\b(?:this|that)\s+${memoryWord}\s*$`).test(clause))) return "forget";
		if (!looksLikeCode && near("approve|promote")) return "promote";
		if (!looksLikeCode && near("list|show")) return "list";
		const strongRemember = /\bremember\s*[:\-]\s*\S/.test(clause) || /\bremember\b[^\n]{0,120}\b(?:(?:project|repo|repository|task)\s+)?(?:preference|convention|decision)\b/.test(clause);
		const preferenceRemember = /\bremember\b[^\n]{0,80}\b(?:i|we)\s+(?:prefer|like)\b/.test(clause);
		const broadRemember = /\bremember\b[^\n]{0,80}\b(?:i|we)\s+(?:use|want|need)\b/.test(clause) || /^\s*(?:(?:can|could|would)\s+you\s+(?:please\s+)?|please\s+)?remember\s+my\b/.test(clause);
		if (strongRemember || preferenceRemember || (!looksLikeCode && broadRemember)) return "add";
		if (!looksLikeCode && near("add|create|save|store|record")) return "add";
	}
	return undefined;
}

export function memoryAdminGuidance(prompt: string): string | undefined {
	const action = explicitMemoryAction(prompt);
	if (!action) return undefined;
	const lines = [
		"## Explicit Memory Admin Request",
		"The user appears to be asking for memory administration. Use only `.agents` memory scripts; do not write durable memory directly from Pi.",
		"Keep Pi-guided memory scoped to an explicit project or task. Never store credential-like or secret material.",
		"Read freeform title/body/reason text from temporary files, not process argv, and clean those temp files before finishing.",
	];
	if (action === "add") lines.push("For remember/save requests, create a candidate by default with `memory-add.sh`; use approved state only when the user explicitly asks for approved future-context injection.");
	if (action === "list") lines.push("For list/show requests, use `memory-list.sh` with an explicit project/task scope.");
	if (action === "review") lines.push("For candidate review requests, use read-only `memory-review.sh` with an explicit project/task scope; show bounded previews, then ask which memory id to promote or forget before any mutation.");
	if (action === "promote") lines.push("For promote/approve requests, use `memory-promote.sh` only for an explicit memory id or after the user selects one from a scoped list.");
	if (action === "forget") lines.push("For forget/remove requests, use `memory-forget.sh` only for an explicit memory id or after the user selects one from a scoped list.");
	return lines.join("\n");
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

export function formatMemoryReviewHintLines(stats: MemoryStatsResult): string[] {
	if (!stats.available) return [];
	const candidateCount = stats.counts.candidate;
	if (candidateCount <= 0) return [];
	const plural = candidateCount === 1 ? "candidate" : "candidates";
	return [`- memory review: ${candidateCount} ${plural} pending; ask to review memory candidates to inspect bounded previews via read-only memory-review.sh`];
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
		const reason = content ? undefined : (omitted > 0 ? `memory API returned 0 included records; ${omitted} omitted by filter/safety/budget` : "no approved scoped memory");
		return { content, reason, included, omitted };
	} catch {
		return { reason: "memory API unavailable", included: 0, omitted: 0 };
	}
}
