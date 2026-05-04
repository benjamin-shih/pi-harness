import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ambientDoctorSection, ambientStatusLines, type AmbientContextSnapshot } from "../shared/ambient-context";
import { buildMemoryStats, formatMemoryReviewHintLines, formatMemoryStatsLines, type MemoryStatsResult } from "../shared/memory-context";
import { buildMemorySpineDiagnostics, formatMemorySpineDiagnostics, memorySpineStatusLines, type MemorySpineDiagnostics } from "../session-continuity/diagnostics";

type HarnessAudit = {
	packageVersion: string;
	metrics?: { runtimeExtensionEntrypoints?: number; extensionLoc?: number; optionalLatexLoc?: number };
	issues?: unknown[];
	warnings?: unknown[];
};

type HarnessAuditResult = { ok: true; audit: HarnessAudit } | { ok: false; error: string };

type GitSummary = { branch?: string; root?: string; summary: string };

type HarnessFacts = {
	cwd: string;
	model: string;
	thinking: string;
	context: string;
	git: GitSummary;
	activeTools: string[];
	sessionEntries: number;
	audit: HarnessAuditResult;
	memory: MemorySpineDiagnostics;
	memoryApi: MemoryStatsResult;
};

export type StatusTaskLayer = {
	statusLines(): string[];
	doctorSection(): string;
	health(): "ok" | "warning";
	ambientScope?(): { taskId?: string; projectRoot?: string };
};

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", args, { cwd, timeout: 5_000 });
		if (result.code !== 0) return undefined;
		return result.stdout.trim();
	} catch {
		return undefined;
	}
}

async function gitSummary(pi: ExtensionAPI, cwd: string): Promise<GitSummary> {
	const root = await gitOutput(pi, cwd, ["rev-parse", "--show-toplevel"]);
	const branch = await gitOutput(pi, cwd, ["branch", "--show-current"]);
	const status = await gitOutput(pi, cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status === undefined) return { branch: undefined, root, summary: "not a git repo" };
	if (!status) return { branch, root, summary: "clean" };

	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	for (const line of status.split(/\r?\n/)) {
		if (line.startsWith("??")) {
			untracked++;
			continue;
		}
		if (line[0] && line[0] !== " ") staged++;
		if (line[1] && line[1] !== " ") unstaged++;
	}
	return { branch, root, summary: `${staged} staged, ${unstaged} unstaged, ${untracked} untracked` };
}

function contextSummary(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) return "unknown";
	return `${usage.percent.toFixed(1)}% (${usage.tokens}/${usage.contextWindow})`;
}

async function runHarnessAudit(pi: ExtensionAPI): Promise<HarnessAuditResult> {
	try {
		const script = join(PACKAGE_ROOT, "scripts", "harness-audit.mjs");
		const result = await pi.exec("node", [script, "--json"], { cwd: PACKAGE_ROOT, timeout: 5_000 });
		if (result.code !== 0) return { ok: false, error: result.stderr || result.stdout || `exit ${result.code}` };
		return { ok: true, audit: JSON.parse(result.stdout) as HarnessAudit };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function formatHarnessAuditLines(result: HarnessAuditResult): string[] {
	if (result.ok === false) return [`- harness audit: unavailable (${result.error})`];
	const { audit } = result;
	return [
		`- harness audit: ${audit.issues?.length ? "issues" : "ok"} (${audit.issues?.length ?? 0} issue(s), ${audit.warnings?.length ?? 0} warning(s))`,
		`- runtime extensions: ${audit.metrics?.runtimeExtensionEntrypoints ?? "unknown"}`,
		`- core extension LOC: ${audit.metrics?.extensionLoc ?? "unknown"}`,
		`- optional LaTeX LOC: ${audit.metrics?.optionalLatexLoc ?? "unknown"}`,
	];
}

async function buildHarnessFacts(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer): Promise<HarnessFacts> {
	const git = await gitSummary(pi, ctx.cwd);
	const audit = await runHarnessAudit(pi);
	const branch = ctx.sessionManager.getBranch();
	const taskScope = taskLayer.ambientScope?.() ?? {};
	const memoryApi = await buildMemoryStats(pi, ctx.cwd, { projectRoot: taskScope.projectRoot || git.root, taskId: taskScope.taskId });
	return {
		cwd: ctx.cwd,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
		thinking: pi.getThinkingLevel(),
		context: contextSummary(ctx),
		git,
		activeTools: pi.getActiveTools(),
		sessionEntries: branch.length,
		audit,
		memory: buildMemorySpineDiagnostics(branch),
		memoryApi,
	};
}

function overviewLines(facts: HarnessFacts): string[] {
	return [
		`- cwd: ${facts.cwd}`,
		`- model: ${facts.model}`,
		`- thinking: ${facts.thinking}`,
		`- context: ${facts.context}`,
		`- git: ${facts.git.branch ? `${facts.git.branch}, ` : ""}${facts.git.summary}`,
		`- active tools: ${facts.activeTools.length ? facts.activeTools.join(", ") : "none"}`,
		`- session entries: ${facts.sessionEntries}`,
	];
}

function doctorRecommendations(facts: HarnessFacts, taskLayer: StatusTaskLayer): string[] {
	const recommendations: string[] = [];
	if (!facts.audit.ok) recommendations.push("Run `npm run harness:audit` in the harness package; the slash-command audit call failed.");
	else if (facts.audit.audit.issues?.length) recommendations.push("Fix harness audit issues before adding more harness features.");
	if (facts.memory.health === "warning") recommendations.push("Inspect `/memory`; latest memory-spine diagnostics indicate compaction fallback/default behavior.");
	if (facts.memory.health === "unknown") recommendations.push("No memory-spine entries yet; run one normal agent turn and check `/memory` again.");
	if (facts.memoryApi.available && facts.memoryApi.counts.candidate > 0) recommendations.push("Ask to review memory candidates when ready; candidate previews are read-only and promotion/forgetting remains explicit.");
	if (taskLayer.health() === "warning") recommendations.push("Inspect AGENTS task binding state; pi could not bind or refresh the active task cleanly.");
	return recommendations.length ? recommendations : ["None; harness checks are green."];
}

function doctorHealth(facts: HarnessFacts, taskLayer: StatusTaskLayer): "ok" | "warning" {
	return !facts.audit.ok || facts.audit.audit.issues?.length || facts.memory.health === "warning" || taskLayer.health() === "warning" ? "warning" : "ok";
}

const WRITE_SEMANTICS_STATUS_LINES = ["- write semantics: durable memory mutations explicit-only; task operational writes automatic when bound; artifacts metadata-only/policy-filtered"];

const WRITE_SEMANTICS_DOCTOR_SECTION = [
	"## Write semantics",
	"- durable memory mutations: explicit user request only; approved scoped memory may be read for nontrivial turns",
	"- task operational writes: automatic while bound via `.agents/tasks` leases, heartbeats, checkpoints, and status updates",
	"- task artifacts: metadata-only and policy-filtered; raw prompts, transcripts, and file contents are not copied",
].join("\n");

export async function buildStatus(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer, ambientContext?: AmbientContextSnapshot): Promise<string> {
	const facts = await buildHarnessFacts(pi, ctx, taskLayer);
	return [
		"## Harness status",
		...overviewLines(facts),
		...formatHarnessAuditLines(facts.audit),
		...memorySpineStatusLines(facts.memory),
		...formatMemoryStatsLines(facts.memoryApi),
		...formatMemoryReviewHintLines(facts.memoryApi),
		...WRITE_SEMANTICS_STATUS_LINES,
		...taskLayer.statusLines(),
		...ambientStatusLines(ambientContext),
	].join("\n");
}

export async function buildDoctor(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer, ambientContext?: AmbientContextSnapshot): Promise<string> {
	const facts = await buildHarnessFacts(pi, ctx, taskLayer);
	return [
		"## Harness doctor",
		`- health: ${doctorHealth(facts, taskLayer)}`,
		`- package: ben-pi-harness ${facts.audit.ok ? facts.audit.audit.packageVersion ?? "unknown" : "unknown"}`,
		...overviewLines(facts),
		"",
		"## Harness audit",
		...formatHarnessAuditLines(facts.audit),
		"",
		formatMemorySpineDiagnostics(facts.memory, { verbose: true }),
		"",
		"## Scoped memory API",
		...formatMemoryStatsLines(facts.memoryApi),
		...formatMemoryReviewHintLines(facts.memoryApi),
		"",
		WRITE_SEMANTICS_DOCTOR_SECTION,
		"",
		taskLayer.doctorSection(),
		"",
		ambientDoctorSection(ambientContext),
		"",
		"## Recommendations",
		...doctorRecommendations(facts, taskLayer).map((recommendation) => `- ${recommendation}`),
	].join("\n");
}
