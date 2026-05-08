import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ambientDoctorSection, type AmbientContextSnapshot } from "./ambient-context";
import { countTrackedPorcelain, gitOutput } from "./git-summary";
import { buildMemoryReview, buildMemoryStats, formatMemoryAdminHelpLines, formatMemoryReviewHintLines, formatMemoryReviewLines, formatMemoryStatsLines, type MemoryContextScope, type MemoryStatsResult } from "./memory-context";
import { buildPiPackagePolicy, formatPiPackagePolicyLines, piPackagePolicyHealth, type PiPackagePolicyResult } from "./pi-package-policy";
import { buildProjectInstructions, formatProjectInstructionLines, projectInstructionHealth, type ProjectInstructionResult } from "./project-instructions";
import { formatStatusView } from "./status-view";
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
	memoryScope: MemoryContextScope;
};

type DoctorFacts = HarnessFacts & { audit: HarnessAuditResult; piPackagePolicy: PiPackagePolicyResult; projectInstructions: ProjectInstructionResult };

type StatusTaskLayer = {
	statusLines(): string[];
	doctorSection(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string>;
	health(): "ok" | "warning";
	ambientScope?(): { taskId?: string; projectRoot?: string };
	refresh?(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void>;
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
	await taskLayer.refresh?.(pi, ctx);
	const git = await gitSummary(pi, ctx.cwd);
	const branch = ctx.sessionManager.getBranch();
	const taskScope = taskLayer.ambientScope?.() ?? {};
	const memoryScope = { projectRoot: taskScope.projectRoot || git.root, taskId: taskScope.taskId };
	const memoryApi = await buildMemoryStats(pi, ctx.cwd, memoryScope);
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
		memoryScope,
	};
}

async function buildDoctorFacts(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer): Promise<DoctorFacts> {
	const [facts, audit, piPackagePolicy, projectInstructions] = await Promise.all([buildHarnessFacts(pi, ctx, taskLayer), runHarnessAudit(pi), buildPiPackagePolicy(pi, ctx), buildProjectInstructions(pi, ctx)]);
	return { ...facts, audit, piPackagePolicy, projectInstructions };
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

function doctorRecommendations(facts: DoctorFacts, taskLayer: StatusTaskLayer, ambientContext?: AmbientContextSnapshot): string[] {
	const recommendations: string[] = [];
	if (!facts.audit.ok) recommendations.push("Run `npm run harness:audit` in the harness package; the slash-command audit call failed.");
	else if (facts.audit.audit.issues?.length) recommendations.push("Fix harness audit issues before adding more harness features.");
	if (facts.memory.health === "warning") recommendations.push("Inspect `/memory`; latest memory-spine diagnostics indicate compaction fallback/default behavior.");
	if (facts.memory.health === "unknown") recommendations.push("No memory-spine entries yet; run one normal agent turn and check `/memory` again.");
	if (facts.memoryApi.available && facts.memoryApi.counts.candidate > 0) recommendations.push("Ask to review memory candidates when ready; candidate previews are read-only and promotion/forgetting remains explicit.");
	if (piPackagePolicyHealth(facts.piPackagePolicy) === "warning") recommendations.push("Inspect Pi package approvals; configured packages should be exact-pinned and locally approved before use.");
	if (projectInstructionHealth(facts.projectInstructions) === "warning") recommendations.push("Inspect project instruction files; `/doctor` found stale or missing ambient-style guidance.");
	if (taskLayer.health() === "warning") recommendations.push("Inspect AGENTS task binding state; pi could not bind or refresh the active task cleanly.");
	if (ambientContext?.executionRoute?.health === "degraded") recommendations.push("Inspect the shared `.agents` execution-route API; the last ambient route check degraded safely.");
	return recommendations.length ? recommendations : ["None; harness checks are green."];
}

function doctorHealth(facts: DoctorFacts, taskLayer: StatusTaskLayer, ambientContext?: AmbientContextSnapshot): "ok" | "warning" {
	const hasWarning = !facts.audit.ok
		|| Boolean(facts.audit.audit.issues?.length)
		|| facts.memory.health === "warning"
		|| piPackagePolicyHealth(facts.piPackagePolicy) === "warning"
		|| projectInstructionHealth(facts.projectInstructions) === "warning"
		|| taskLayer.health() === "warning"
		|| ambientContext?.executionRoute?.health === "degraded";
	return hasWarning ? "warning" : "ok";
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

export async function buildMemoryReport(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer, args = ""): Promise<string> {
	const facts = await buildHarnessFacts(pi, ctx, taskLayer);
	const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const command = tokens[0] ?? "";
	const requestedGlobal = tokens.includes("global") || tokens.includes("--include-global");
	if (command === "review" || command === "candidates" || (command === "list" && requestedGlobal)) {
		const reviewScope = requestedGlobal ? { includeGlobal: true } : facts.memoryScope;
		const review = await buildMemoryReview(pi, ctx.cwd, reviewScope);
		return [
			`## Memory candidate review${requestedGlobal ? " (global)" : ""}`,
			...formatMemoryReviewLines(review),
			"",
			WRITE_SEMANTICS_DOCTOR_SECTION,
		].join("\n");
	}
	if (command === "help" || command === "admin" || command === "commands") return formatMemoryAdminHelpLines(facts.memoryScope).join("\n");
	if (command) return ["## Memory command", `- unknown subcommand: ${tokens.join(" ")}`, "- available: `/memory`, `/memory review`, `/memory review global`, `/memory help`"].join("\n");
	return [
		formatMemorySpineDiagnostics(facts.memory, { verbose: true }),
		"",
		"## Scoped memory API",
		...formatMemoryStatsLines(facts.memoryApi),
		...formatMemoryReviewHintLines(facts.memoryApi),
		"",
		...formatMemoryAdminHelpLines(facts.memoryScope),
		"",
		WRITE_SEMANTICS_DOCTOR_SECTION,
	].join("\n");
}

export async function buildDoctor(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer, ambientContext?: AmbientContextSnapshot): Promise<string> {
	const facts = await buildDoctorFacts(pi, ctx, taskLayer);
	return [
		"## Harness doctor",
		`- health: ${doctorHealth(facts, taskLayer, ambientContext)}`,
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
		"## Pi package approvals",
		...formatPiPackagePolicyLines(facts.piPackagePolicy),
		"",
		"## Project instructions",
		...formatProjectInstructionLines(facts.projectInstructions),
		"",
		await taskLayer.doctorSection(pi, ctx),
		"",
		ambientDoctorSection(ambientContext),
		"",
		"## Recommendations",
		...doctorRecommendations(facts, taskLayer, ambientContext).map((recommendation) => `- ${recommendation}`),
	].join("\n");
}
