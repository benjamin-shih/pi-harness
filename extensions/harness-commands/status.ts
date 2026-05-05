import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ambientDoctorSection, type AmbientContextSnapshot } from "../shared/ambient-context";
import { countTrackedPorcelain, gitOutput } from "../shared/git-summary";
import { buildMemoryStats, formatMemoryReviewHintLines, formatMemoryStatsLines, type MemoryStatsResult } from "../shared/memory-context";
import { formatStatusView } from "../shared/status-view";
import { buildMemorySpineDiagnostics, formatMemorySpineDiagnostics, type MemorySpineDiagnostics } from "../session-continuity/diagnostics";

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
	memory: MemorySpineDiagnostics;
	memoryApi: MemoryStatsResult;
};

type DoctorFacts = HarnessFacts & { audit: HarnessAuditResult };

type StatusTaskLayer = {
	statusLines(): string[];
	doctorSection(): string;
	health(): "ok" | "warning";
	ambientScope?(): { taskId?: string; projectRoot?: string };
};

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function gitSummary(pi: ExtensionAPI, cwd: string): Promise<GitSummary> {
	const root = await gitOutput(pi, cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 5_000 });
	const branch = await gitOutput(pi, cwd, ["branch", "--show-current"], { timeoutMs: 5_000 });
	const status = await gitOutput(pi, cwd, ["status", "--porcelain=v1", "--untracked-files=no"], { timeoutMs: 5_000, preserveLeading: true });
	if (status === undefined) return { branch: undefined, root, summary: "not a git repo" };
	if (!status) return { branch, root, summary: "tracked clean (untracked not scanned)" };

	const { staged, unstaged } = countTrackedPorcelain(status);
	return { branch, root, summary: `${staged} staged, ${unstaged} unstaged tracked (untracked not scanned)` };
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
		memory: buildMemorySpineDiagnostics(branch),
		memoryApi,
	};
}

async function buildDoctorFacts(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer): Promise<DoctorFacts> {
	const [facts, audit] = await Promise.all([buildHarnessFacts(pi, ctx, taskLayer), runHarnessAudit(pi)]);
	return { ...facts, audit };
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

function doctorRecommendations(facts: DoctorFacts, taskLayer: StatusTaskLayer): string[] {
	const recommendations: string[] = [];
	if (!facts.audit.ok) recommendations.push("Run `npm run harness:audit` in the harness package; the slash-command audit call failed.");
	else if (facts.audit.audit.issues?.length) recommendations.push("Fix harness audit issues before adding more harness features.");
	if (facts.memory.health === "warning") recommendations.push("Inspect `/memory`; latest memory-spine diagnostics indicate compaction fallback/default behavior.");
	if (facts.memory.health === "unknown") recommendations.push("No memory-spine entries yet; run one normal agent turn and check `/memory` again.");
	if (facts.memoryApi.available && facts.memoryApi.counts.candidate > 0) recommendations.push("Ask to review memory candidates when ready; candidate previews are read-only and promotion/forgetting remains explicit.");
	if (taskLayer.health() === "warning") recommendations.push("Inspect AGENTS task binding state; pi could not bind or refresh the active task cleanly.");
	return recommendations.length ? recommendations : ["None; harness checks are green."];
}

function doctorHealth(facts: DoctorFacts, taskLayer: StatusTaskLayer): "ok" | "warning" {
	return !facts.audit.ok || facts.audit.audit.issues?.length || facts.memory.health === "warning" || taskLayer.health() === "warning" ? "warning" : "ok";
}

const WRITE_SEMANTICS_DOCTOR_SECTION = [
	"## Write semantics",
	"- durable memory mutations: explicit user request only; approved scoped memory may be read for nontrivial turns",
	"- task operational writes: automatic while bound via `.agents/tasks` leases, heartbeats, checkpoints, and status updates",
	"- task artifacts: metadata-only and policy-filtered; raw prompts, transcripts, and file contents are not copied",
].join("\n");

export async function buildStatus(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer, ambientContext?: AmbientContextSnapshot): Promise<string> {
	const facts = await buildHarnessFacts(pi, ctx, taskLayer);
	return ["## Harness status", formatStatusView(facts, taskLayer, ambientContext)].join("\n");
}

export async function buildDoctor(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer, ambientContext?: AmbientContextSnapshot): Promise<string> {
	const facts = await buildDoctorFacts(pi, ctx, taskLayer);
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
