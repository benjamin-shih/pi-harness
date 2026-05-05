import type { CompactionEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { COMPACTION_DIAGNOSTIC_TYPE, CONTINUITY_VERSION } from "./constants";
import { extractContinuityCheckpoints } from "./checkpoints";
import type { CompactionDiagnosticReason, ContinuityCheckpoint, ContinuityCompactionDiagnostic, PromptSizing } from "./types";

type CompactionDetails = {
	source?: unknown;
	fallbackReason?: unknown;
	error?: unknown;
	promptSizing?: unknown;
};

export type MemoryCompactionSnapshot = {
	timestamp: string;
	tokensBefore: number;
	fromHook?: boolean;
	source?: string;
	fallbackReason?: CompactionDiagnosticReason;
	error?: string;
	promptSizing?: PromptSizing;
};

export type MemorySpineDiagnostics = {
	health: "ok" | "warning" | "unknown";
	status: string;
	checkpointCount: number;
	latestCheckpoint?: ContinuityCheckpoint;
	diagnosticCount: number;
	latestDiagnostic?: ContinuityCompactionDiagnostic;
	compactionCount: number;
	harnessCompactionCount: number;
	latestCompaction?: MemoryCompactionSnapshot;
	latestHarnessCompaction?: MemoryCompactionSnapshot;
	fallbackCount: number;
	defaultCompactionCount: number;
};

function isPromptSizing(value: unknown): value is PromptSizing {
	const sizing = value as PromptSizing;
	return Boolean(sizing) && typeof sizing.promptChars === "number" && typeof sizing.tokensBefore === "number";
}

function isDiagnostic(value: unknown): value is ContinuityCompactionDiagnostic {
	const diagnostic = value as ContinuityCompactionDiagnostic;
	return (
		Boolean(diagnostic) &&
		diagnostic.version === CONTINUITY_VERSION &&
		typeof diagnostic.timestamp === "string" &&
		typeof diagnostic.reason === "string" &&
		typeof diagnostic.cwd === "string" &&
		typeof diagnostic.fallbackReturned === "boolean"
	);
}

function isCompactionEntry(entry: SessionEntry): entry is CompactionEntry<CompactionDetails> {
	return entry.type === "compaction";
}

function diagnosticTimestamp(diagnostic: ContinuityCompactionDiagnostic | undefined): number {
	return diagnostic ? Date.parse(diagnostic.timestamp) || 0 : 0;
}

function compactionTimestamp(compaction: MemoryCompactionSnapshot | undefined): number {
	return compaction ? Date.parse(compaction.timestamp) || 0 : 0;
}

function toReason(value: unknown): CompactionDiagnosticReason | undefined {
	return typeof value === "string" && ["no_model", "no_api_key", "aborted", "empty_summary", "exception", "default_compaction"].includes(value)
		? (value as CompactionDiagnosticReason)
		: undefined;
}

function toCompactionSnapshot(entry: CompactionEntry<CompactionDetails>): MemoryCompactionSnapshot {
	const details = entry.details ?? {};
	const fallbackReason = toReason(details.fallbackReason);
	return {
		timestamp: entry.timestamp,
		tokensBefore: entry.tokensBefore,
		...(typeof entry.fromHook === "boolean" ? { fromHook: entry.fromHook } : {}),
		...(typeof details.source === "string" ? { source: details.source } : {}),
		...(fallbackReason ? { fallbackReason } : {}),
		...(typeof details.error === "string" ? { error: details.error } : {}),
		...(isPromptSizing(details.promptSizing) ? { promptSizing: details.promptSizing } : {}),
	};
}

export function extractContinuityCompactionDiagnostics(entries: SessionEntry[]): ContinuityCompactionDiagnostic[] {
	return entries
		.filter((entry): entry is SessionEntry & { type: "custom"; customType: string; data?: unknown } => entry.type === "custom")
		.filter((entry) => entry.customType === COMPACTION_DIAGNOSTIC_TYPE && isDiagnostic(entry.data))
		.map((entry) => entry.data as ContinuityCompactionDiagnostic);
}

export function extractMemoryCompactions(entries: SessionEntry[]): MemoryCompactionSnapshot[] {
	return entries.filter(isCompactionEntry).map(toCompactionSnapshot);
}

function isHarnessCompaction(compaction: MemoryCompactionSnapshot): boolean {
	return compaction.source === "ben-pi-harness/session-continuity";
}

function memoryHealth(args: {
	checkpointCount: number;
	latestDiagnostic?: ContinuityCompactionDiagnostic;
	latestHarnessCompaction?: MemoryCompactionSnapshot;
}): MemorySpineDiagnostics["health"] {
	if (!args.checkpointCount && !args.latestDiagnostic && !args.latestHarnessCompaction) return "unknown";
	const latestDiagnosticTime = diagnosticTimestamp(args.latestDiagnostic);
	const latestHarnessCompactionTime = compactionTimestamp(args.latestHarnessCompaction);
	if (args.latestHarnessCompaction && latestHarnessCompactionTime >= latestDiagnosticTime) return args.latestHarnessCompaction.fallbackReason ? "warning" : "ok";
	if (!args.latestDiagnostic) return "ok";
	if (args.latestDiagnostic.fallbackReturned || args.latestDiagnostic.reason === "default_compaction") return "warning";
	if (["no_model", "no_api_key", "empty_summary", "exception"].includes(args.latestDiagnostic.reason)) return "warning";
	return "ok";
}

function memoryStatus(diagnostics: Pick<MemorySpineDiagnostics, "health" | "latestDiagnostic" | "latestHarnessCompaction" | "checkpointCount">): string {
	if (diagnostics.health === "unknown") return "no memory-spine entries recorded yet";
	if (diagnostics.health === "warning") {
		const reason = diagnostics.latestDiagnostic?.reason ?? diagnostics.latestHarnessCompaction?.fallbackReason ?? "unknown";
		return `attention needed: latest memory-spine compaction reason is ${reason}`;
	}
	if (diagnostics.latestHarnessCompaction) return "ok: latest harness compaction used model summary";
	return `ok: ${diagnostics.checkpointCount} checkpoint(s) recorded`;
}

export function buildMemorySpineDiagnostics(entries: SessionEntry[]): MemorySpineDiagnostics {
	const checkpoints = extractContinuityCheckpoints(entries);
	const compactionDiagnostics = extractContinuityCompactionDiagnostics(entries);
	const compactions = extractMemoryCompactions(entries);
	const harnessCompactions = compactions.filter(isHarnessCompaction);
	const latestDiagnostic = compactionDiagnostics[compactionDiagnostics.length - 1];
	const latestHarnessCompaction = harnessCompactions[harnessCompactions.length - 1];
	const health = memoryHealth({ checkpointCount: checkpoints.length, latestDiagnostic, latestHarnessCompaction });
	const diagnostics: MemorySpineDiagnostics = {
		health,
		status: "",
		checkpointCount: checkpoints.length,
		...(checkpoints.length ? { latestCheckpoint: checkpoints[checkpoints.length - 1] } : {}),
		diagnosticCount: compactionDiagnostics.length,
		...(latestDiagnostic ? { latestDiagnostic } : {}),
		compactionCount: compactions.length,
		harnessCompactionCount: harnessCompactions.length,
		...(compactions.length ? { latestCompaction: compactions[compactions.length - 1] } : {}),
		...(latestHarnessCompaction ? { latestHarnessCompaction } : {}),
		fallbackCount: compactionDiagnostics.filter((diagnostic) => diagnostic.fallbackReturned).length + harnessCompactions.filter((compaction) => Boolean(compaction.fallbackReason)).length,
		defaultCompactionCount: compactionDiagnostics.filter((diagnostic) => diagnostic.reason === "default_compaction").length,
	};
	diagnostics.status = memoryStatus(diagnostics);
	return diagnostics;
}

function compactPrompt(prompt: string | undefined): string | undefined {
	if (!prompt) return undefined;
	return prompt.length <= 160 ? prompt : `${prompt.slice(0, 159)}…`;
}

export function formatMemorySpineDiagnostics(diagnostics: MemorySpineDiagnostics, options: { verbose?: boolean } = {}): string {
	const lines = [
		"## Memory spine",
		`- health: ${diagnostics.health}`,
		`- status: ${diagnostics.status}`,
		`- checkpoints: ${diagnostics.checkpointCount}`,
	];

	if (diagnostics.latestCheckpoint) {
		lines.push(
			`- latest checkpoint: ${diagnostics.latestCheckpoint.timestamp} (${diagnostics.latestCheckpoint.reason})`,
			`- checkpoint activity: read ${diagnostics.latestCheckpoint.filesRead.length}, modified ${diagnostics.latestCheckpoint.filesModified.length}, commands ${diagnostics.latestCheckpoint.commands.length}, errors ${diagnostics.latestCheckpoint.toolErrors.length}`,
		);
		if (options.verbose && diagnostics.latestCheckpoint.prompt) lines.push(`- latest prompt: ${compactPrompt(diagnostics.latestCheckpoint.prompt)}`);
	}

	lines.push(`- compactions: ${diagnostics.compactionCount} total, ${diagnostics.harnessCompactionCount} harness`);
	if (diagnostics.latestHarnessCompaction) {
		const compaction = diagnostics.latestHarnessCompaction;
		lines.push(
			`- latest harness compaction: ${compaction.timestamp}${compaction.fallbackReason ? ` (fallback: ${compaction.fallbackReason})` : " (model summary)"}`,
			`- latest harness compaction budget: prompt ${compaction.promptSizing?.promptChars ?? "unknown"}/${compaction.promptSizing?.promptBudgetChars ?? "unknown"} chars, max summary ${compaction.promptSizing?.maxSummaryTokens ?? "unknown"} tokens`,
		);
		if (options.verbose && compaction.error) lines.push(`- latest compaction error: ${compaction.error}`);
	} else if (diagnostics.latestCompaction) {
		lines.push(`- latest compaction: ${diagnostics.latestCompaction.timestamp} (${diagnostics.latestCompaction.source ?? "pi/default"})`);
	}

	lines.push(`- compaction diagnostics: ${diagnostics.diagnosticCount}`);
	if (diagnostics.latestDiagnostic) {
		lines.push(
			`- latest diagnostic: ${diagnostics.latestDiagnostic.timestamp} (${diagnostics.latestDiagnostic.reason}, fallback returned: ${diagnostics.latestDiagnostic.fallbackReturned ? "yes" : "no"})`,
			`- fallback/default counts: ${diagnostics.fallbackCount} fallback, ${diagnostics.defaultCompactionCount} default-compaction`,
		);
		if (options.verbose && diagnostics.latestDiagnostic.error) lines.push(`- latest diagnostic error: ${diagnostics.latestDiagnostic.error}`);
	}

	return lines.join("\n");
}
