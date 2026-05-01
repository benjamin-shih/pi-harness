import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildMemorySpineDiagnostics, formatMemorySpineDiagnostics, type MemorySpineDiagnostics } from "../session-continuity/diagnostics";

type HarnessAudit = {
	packageVersion: string;
	metrics?: { runtimeExtensionEntrypoints?: number; extensionLoc?: number; optionalLatexLoc?: number };
	issues?: unknown[];
	warnings?: unknown[];
};

type HarnessAuditResult = { ok: true; audit: HarnessAudit } | { ok: false; error: string };

type GitSummary = { branch?: string; summary: string };

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
};

export type StatusTaskLayer = {
	statusLines(): string[];
	doctorSection(): string;
	health(): "ok" | "warning";
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
	const branch = await gitOutput(pi, cwd, ["branch", "--show-current"]);
	const status = await gitOutput(pi, cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status === undefined) return { branch: undefined, summary: "not a git repo" };
	if (!status) return { branch, summary: "clean" };

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
	return { branch, summary: `${staged} staged, ${unstaged} unstaged, ${untracked} untracked` };
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

function memoryStatusLines(diagnostics: MemorySpineDiagnostics): string[] {
	return [
		`- memory spine: ${diagnostics.health} (${diagnostics.status})`,
		`- memory entries: ${diagnostics.checkpointCount} checkpoint(s), ${diagnostics.harnessCompactionCount}/${diagnostics.compactionCount} harness compaction(s), ${diagnostics.diagnosticCount} diagnostic(s)`,
	];
}

async function buildHarnessFacts(pi: ExtensionAPI, ctx: ExtensionContext): Promise<HarnessFacts> {
	const git = await gitSummary(pi, ctx.cwd);
	const audit = await runHarnessAudit(pi);
	const branch = ctx.sessionManager.getBranch();
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
	if (taskLayer.health() === "warning") recommendations.push("Inspect AGENTS task binding state; pi could not bind or refresh the active task cleanly.");
	return recommendations.length ? recommendations : ["None; harness checks are green."];
}

function doctorHealth(facts: HarnessFacts, taskLayer: StatusTaskLayer): "ok" | "warning" {
	if (!facts.audit.ok || facts.audit.audit.issues?.length) return "warning";
	if (facts.memory.health === "warning") return "warning";
	if (taskLayer.health() === "warning") return "warning";
	return "ok";
}

export async function buildStatus(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer): Promise<string> {
	const facts = await buildHarnessFacts(pi, ctx);
	return [
		"## Harness status",
		...overviewLines(facts),
		...formatHarnessAuditLines(facts.audit),
		...memoryStatusLines(facts.memory),
		...taskLayer.statusLines(),
	].join("\n");
}

export async function buildDoctor(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: StatusTaskLayer): Promise<string> {
	const facts = await buildHarnessFacts(pi, ctx);
	return [
		"## Harness doctor",
		`- health: ${doctorHealth(facts, taskLayer)}`,
		`- package: ben-pi-harness ${facts.audit.ok ? facts.audit.audit.packageVersion ?? "unknown" : "unknown"}`,
		...overviewLines(facts),
		"",
		"### Harness audit",
		...formatHarnessAuditLines(facts.audit),
		"",
		formatMemorySpineDiagnostics(facts.memory, { verbose: true }),
		"",
		taskLayer.doctorSection(),
		"",
		"### Recommendations",
		...doctorRecommendations(facts, taskLayer).map((recommendation) => `- ${recommendation}`),
	].join("\n");
}
