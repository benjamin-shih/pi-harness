import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createAgentsTaskLayer } from "./harness-commands/task-layer";
import { buildMemorySpineDiagnostics, formatMemorySpineDiagnostics, type MemorySpineDiagnostics } from "./session-continuity/diagnostics";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type TaskWeight = "trivial" | "standard" | "complex";

type ModeDefinition = {
	description: string;
	provider?: string;
	models?: string[];
	thinking: ThinkingLevel;
	tools: "all" | string[];
	instructions?: string;
};

type PathStat = {
	inserted: number;
	deleted: number;
	untracked: boolean;
};

type DiffStats = {
	files: number;
	inserted: number;
	deleted: number;
	untracked: number;
	paths: string[];
	byPath: Record<string, PathStat>;
};

type GitChangeSnapshot = {
	stats: DiffStats;
	signature: string;
};

type HarnessAudit = {
	root: string;
	packageVersion: string;
	metrics?: { runtimeExtensionEntrypoints?: number; extensionLoc?: number; optionalLatexLoc?: number };
	issues?: unknown[];
	warnings?: unknown[];
};

type HarnessAuditResult = { ok: true; audit: HarnessAudit } | { ok: false; error: string };
type AgentsTaskLayer = ReturnType<typeof createAgentsTaskLayer>;

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SKILLS_ROOT = "/Users/benjaminshih/.agents/skills";
const CLEANUP_GUARD_MARKER = "PI_CLEANUP_GUARD";
const MAJOR_CLEANUP_FILE_THRESHOLD = 4;
const MAJOR_CLEANUP_FILE_LINE_FLOOR = 40;
const MAJOR_CLEANUP_LINE_THRESHOLD = 200;
const DISPLAY_MATH_RENDERING_INSTRUCTION = [
	"## Display Math Rendering",
	"When writing display equations in assistant responses, use `\\begin{displaymath}` and `\\end{displaymath}` delimiters instead of `\\[` and `\\]` so the local LaTeX preview renderer activates reliably.",
].join("\n");
const MARKDOWN_HEADING_RENDERING_INSTRUCTION = [
	"## Markdown Heading Rendering",
	"When formatting assistant responses, use only `#` and `##` Markdown headings. For deeper structure, use bold lead-in labels like `**Subsection.**` instead of `###`, `####`, `#####`, or `######`, because the local terminal renderer displays level-3-and-deeper heading markers literally.",
].join("\n");

const MODES: Record<string, ModeDefinition> = {
	fast: {
		description: "Fast iteration: smaller GPT, low thinking, all tools",
		provider: "openai-codex",
		models: ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.5"],
		thinking: "low",
		tools: "all",
		instructions: "You are in FAST MODE. Prefer quick, direct answers and minimal exploration unless correctness clearly requires more.",
	},
	default: {
		description: "Balanced work: latest GPT, high thinking, all tools",
		provider: "openai-codex",
		models: ["gpt-5.5"],
		thinking: "high",
		tools: "all",
	},
	deep: {
		description: "Deep work: latest GPT, xhigh thinking, all tools",
		provider: "openai-codex",
		models: ["gpt-5.5"],
		thinking: "xhigh",
		tools: "all",
		instructions: "You are in DEEP MODE. For nontrivial work, reason carefully, verify claims, and surface uncertainty explicitly.",
	},
	readonly: {
		description: "Review/planning only: latest GPT, high thinking, read-only tools",
		provider: "openai-codex",
		models: ["gpt-5.5"],
		thinking: "high",
		tools: ["read", "grep", "find", "ls"],
		instructions: "You are in READONLY MODE. Do not edit files or run mutating commands. Review, inspect, and propose changes only.",
	},
	full: {
		description: "Full-power mode: latest GPT, xhigh thinking, all tools",
		provider: "openai-codex",
		models: ["gpt-5.5"],
		thinking: "xhigh",
		tools: "all",
		instructions: "You are in FULL MODE. All configured tools may be used, but keep changes scoped and respect safety gates.",
	},
};

function modeNames(): string[] {
	return Object.keys(MODES);
}

function classifyPrompt(prompt: string): TaskWeight {
	const text = prompt.trim();
	const lower = text.toLowerCase();

	if (
		lower.includes("all of them") ||
		lower.includes("end-to-end") ||
		lower.includes("full fledged") ||
		lower.includes("release") ||
		lower.includes("workflow") ||
		lower.includes("ci") ||
		lower.includes("multi-step") ||
		lower.includes("research") ||
		lower.includes("package") ||
		lower.includes("safety gate")
	) {
		return "complex";
	}

	if (text.length < 180 && !/[\n;]/.test(text)) {
		const standardSignals = /\b(implement|configure|refactor|debug|review|test|add|build|fix|setup|set up|create|write|edit|commit|push)\b/i;
		return standardSignals.test(text) ? "standard" : "trivial";
	}

	if (text.length > 700 || text.split("\n").length > 4) return "complex";
	return "standard";
}

function skillRoutingReminder(weight: TaskWeight): string | undefined {
	if (weight === "trivial") return undefined;

	const base = [
		"## Harness Skill Routing Reminder",
		"Classify the user task before substantive work.",
		"If the task is actually trivial, do not perform full skill traversal; answer or complete it immediately.",
		"For nontrivial work, use `/Users/benjaminshih/.agents/skills/SKILLS.md` as the skill graph root.",
		"Treat `Depends on` as hard ordering edges and `Related` as optional discovery only.",
		"Report the selected skills and why before executing substantive steps.",
	];

	if (weight === "complex") {
		base.push(
			"This prompt appears complex. Start from SKILLS.md, load relevant skills in dependency order, then state a concise plan before major execution.",
		);
	} else {
		base.push("This prompt appears standard. Load only the smallest sufficient skill set before substantive execution.");
	}

	return base.join("\n");
}

function isExecutionContinuationPrompt(prompt: string): boolean {
	return /^(?:go ahead(?: and do (?:it|this))?|continue|proceed|do it|do this|yes|yep|ok(?:ay)?)[\s.!]*$/i.test(prompt.trim());
}

function isCodingOrFilePrompt(prompt: string): boolean {
	const lower = prompt.toLowerCase();
	return (
		isExecutionContinuationPrompt(prompt) ||
		/\b(implement|code|coding|edit|modify|change|refactor|fix|debug|add|remove|delete|rename|create|write|update|migrate|replace|fold|cleanup|clean up|test|ci|package|extension|skill|config|repo|file)\b/.test(lower) ||
		/\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|sh|zsh|fish|json|ya?ml|toml|md|tex|css|scss|html)\b/i.test(prompt)
	);
}

function promptSuggestsMajorCleanup(prompt: string, _weight: TaskWeight): boolean {
	const lower = prompt.toLowerCase();
	return /\b(major|large|big|broad|codebase|repo-wide|repository-wide|general review|overhaul|migration|sweep|entire repo|all of them|full rewrite|old slop)\b/.test(lower);
}

function cleanupReminder(prompt: string, weight: TaskWeight): string | undefined {
	if (!isCodingOrFilePrompt(prompt)) return undefined;

	const lines = [
		"## Post-Change Cleanup Gate",
		"For coding or file-modification work, before the final response always inspect the current diff/touched files and remove code made obsolete by this change.",
		"Check for: stale identifiers, old model/version names, unused imports/exports, dead helpers, replaced compatibility shims, stale comments/docs/config, and duplicate logic introduced by the update.",
		"Keep cleanup scoped to the touched area unless the user asked for a broad refactor or the change is clearly major.",
		"Run the narrowest meaningful verification after cleanup and report what was simplified or deliberately left unchanged.",
	];

	if (promptSuggestsMajorCleanup(prompt, weight)) {
		lines.push(
			"For major changes, do a broader pass over the affected subsystem and obvious repo-wide stale references before committing; examples include old provider/model names such as `gpt-5.2`/`gpt5.2`, retired flags, and docs that still describe removed behavior.",
		);
	}

	return lines.join("\n");
}

function allToolNames(pi: ExtensionAPI): string[] {
	return pi.getAllTools().map((tool) => tool.name);
}

async function applyMode(name: string, mode: ModeDefinition, pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	if (mode.provider && mode.models) {
		const model = mode.models.map((id) => ctx.modelRegistry.find(mode.provider!, id)).find(Boolean);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) ctx.ui.notify(`Mode ${name}: no API key for ${mode.provider}/${model.id}`, "warning");
		} else {
			ctx.ui.notify(`Mode ${name}: no configured model found (${mode.models.join(", ")})`, "warning");
		}
	}

	pi.setThinkingLevel(mode.thinking);

	if (mode.tools === "all") {
		pi.setActiveTools(allToolNames(pi));
	} else {
		const available = new Set(allToolNames(pi));
		const validTools = mode.tools.filter((tool) => available.has(tool));
		const missingTools = mode.tools.filter((tool) => !available.has(tool));
		if (missingTools.length) ctx.ui.notify(`Mode ${name}: unavailable tools: ${missingTools.join(", ")}`, "warning");
		pi.setActiveTools(validTools);
	}

	ctx.ui.setStatus("mode", ctx.ui.theme.fg("accent", `mode:${name}`));
	ctx.ui.notify(`Mode ${name} activated`, "info");
	return true;
}

async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", args, { cwd, timeout: 5_000 });
		if (result.code !== 0) return undefined;
		return result.stdout.trim();
	} catch {
		return undefined;
	}
}

async function gitSummary(pi: ExtensionAPI, cwd: string): Promise<{ branch?: string; summary: string }> {
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

function emptyDiffStats(): DiffStats {
	return { files: 0, inserted: 0, deleted: 0, untracked: 0, paths: [], byPath: {} };
}

function addFileStat(stats: DiffStats, filePath: string, inserted: number, deleted: number, untracked = false): void {
	const current = stats.byPath[filePath] ?? { inserted: 0, deleted: 0, untracked: false };
	if (!stats.byPath[filePath]) {
		stats.files++;
		stats.paths.push(filePath);
	}
	stats.inserted += inserted;
	stats.deleted += deleted;
	if (untracked && !current.untracked) stats.untracked++;
	current.inserted += inserted;
	current.deleted += deleted;
	current.untracked ||= untracked;
	stats.byPath[filePath] = current;
}

function addNumstat(stats: DiffStats, stdout: string, untracked = false, fallbackPath?: string): void {
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [insertedText, deletedText, ...pathParts] = line.split("\t");
		const filePath = pathParts.join("\t").trim() || fallbackPath;
		if (!filePath) continue;
		addFileStat(stats, filePath, Number.parseInt(insertedText ?? "0", 10) || 0, Number.parseInt(deletedText ?? "0", 10) || 0, untracked);
	}
}

async function untrackedFileNumstat(pi: ExtensionAPI, cwd: string, filePath: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["diff", "--numstat", "--no-index", "--", "/dev/null", filePath], { cwd, timeout: 5_000 });
		return result.stdout;
	} catch {
		return "";
	}
}

async function gitChangeSnapshot(pi: ExtensionAPI, cwd: string): Promise<GitChangeSnapshot | undefined> {
	try {
		const diff = await pi.exec("git", ["diff", "--numstat", "HEAD", "--"], { cwd, timeout: 5_000 });
		if (diff.code !== 0) return undefined;

		const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd, timeout: 5_000 });
		const untrackedFiles = untracked.code === 0 ? untracked.stdout.split(/\r?\n/).filter(Boolean) : [];
		const stats = emptyDiffStats();
		addNumstat(stats, diff.stdout);

		const untrackedNumstats: string[] = [];
		for (const filePath of untrackedFiles.slice(0, 20)) {
			const numstat = await untrackedFileNumstat(pi, cwd, filePath);
			untrackedNumstats.push(numstat || `0\t0\t${filePath}`);
			if (numstat.trim()) addNumstat(stats, numstat, true, filePath);
			else addFileStat(stats, filePath, 0, 0, true);
		}

		return { stats, signature: [diff.stdout, untrackedFiles.join("\n"), untrackedNumstats.join("\n")].join("\0") };
	} catch {
		return undefined;
	}
}

function diffDelta(before: DiffStats | undefined, after: DiffStats): DiffStats {
	if (!before) return after;
	const delta = emptyDiffStats();
	for (const [filePath, current] of Object.entries(after.byPath)) {
		const previous = before.byPath[filePath];
		const inserted = Math.max(0, current.inserted - (previous?.inserted ?? 0));
		const deleted = Math.max(0, current.deleted - (previous?.deleted ?? 0));
		const untracked = current.untracked && !previous?.untracked;
		if (inserted > 0 || deleted > 0 || untracked) addFileStat(delta, filePath, inserted, deleted, untracked);
	}
	return delta;
}

function diffLooksMajor(stats: DiffStats | undefined): boolean {
	if (!stats) return false;
	const changedLines = stats.inserted + stats.deleted;
	const structuralPathTouched = stats.paths.some((filePath) => /(?:^|\/)(extensions|packages|scripts|src|lib|app|core)\//.test(filePath));
	return (
		(stats.files >= MAJOR_CLEANUP_FILE_THRESHOLD && changedLines >= MAJOR_CLEANUP_FILE_LINE_FLOOR) ||
		changedLines >= MAJOR_CLEANUP_LINE_THRESHOLD ||
		(structuralPathTouched && changedLines >= 80)
	);
}

function formatDiffStats(stats: DiffStats | undefined): string {
	if (!stats) return "git diff stats unavailable";
	const untracked = stats.untracked ? `, ${stats.untracked} untracked` : "";
	return `${stats.files} file(s), +${stats.inserted}/-${stats.deleted}${untracked}`;
}

function looksFileMutatingCommand(command: string): boolean {
	return /(^|[;&|()\s])(?:rm|mv|cp|touch|mkdir|rmdir|tee|python|python3|node|npm|pnpm|yarn|make|git\s+(?:add|commit|reset|checkout|switch|merge|rebase|stash|clean))\b/.test(command)
		|| /(^|[^<])>{1,2}\s*[^&]/.test(command)
		|| /\b(?:sed|perl)\s+[^\n]*\s-i\b/.test(command);
}

function cleanupGuardMessage(stats: DiffStats | undefined, promptWasMajor: boolean): string {
	const reason = promptWasMajor ? "major-change prompt" : `large/structural diff (${formatDiffStats(stats)})`;
	return [
		`${CLEANUP_GUARD_MARKER}: Major code/file change detected (${reason}).`,
		"Before finalizing, run a cleanup/simplify pass:",
		"- inspect the current git diff and touched files",
		"- remove code, docs, comments, config, helpers, imports, and compatibility shims made obsolete by this change",
		"- scan affected subsystems and obvious repo-wide references for stale names or versions, including old model IDs like `gpt-5.2`/`gpt5.2` when relevant",
		"- simplify only where behavior is preserved; do not broaden into unrelated rewrites",
		"- run the relevant verification again, then commit/push or report the blocker",
	].join("\n");
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
	if (!result.ok) return [`- harness audit: unavailable (${result.error})`];
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

async function buildStatus(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: AgentsTaskLayer): Promise<string> {
	const git = await gitSummary(pi, ctx.cwd);
	const audit = await runHarnessAudit(pi);
	const branch = ctx.sessionManager.getBranch();
	const memory = buildMemorySpineDiagnostics(branch);
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
	const tools = pi.getActiveTools();
	return [
		"## Harness status",
		`- cwd: ${ctx.cwd}`,
		`- model: ${model}`,
		`- thinking: ${pi.getThinkingLevel()}`,
		`- context: ${contextSummary(ctx)}`,
		`- git: ${git.branch ? `${git.branch}, ` : ""}${git.summary}`,
		`- active tools: ${tools.length ? tools.join(", ") : "none"}`,
		`- session entries: ${branch.length}`,
		...formatHarnessAuditLines(audit),
		...memoryStatusLines(memory),
		...taskLayer.statusLines(),
	].join("\n");
}

function doctorRecommendations(audit: HarnessAuditResult, memory: MemorySpineDiagnostics, taskLayer: AgentsTaskLayer): string[] {
	const recommendations: string[] = [];
	if (!audit.ok) recommendations.push("Run `npm run harness:audit` in the harness package; the slash-command audit call failed.");
	else if (audit.audit.issues?.length) recommendations.push("Fix harness audit issues before adding more harness features.");
	if (memory.health === "warning") recommendations.push("Inspect `/memory`; latest memory-spine diagnostics indicate compaction fallback/default behavior.");
	if (memory.health === "unknown") recommendations.push("No memory-spine entries yet; run one normal agent turn and check `/memory` again.");
	if (taskLayer.health() === "warning") recommendations.push("Inspect AGENTS task binding state; pi could not bind or refresh the active task cleanly.");
	return recommendations.length ? recommendations : ["None; harness checks are green."];
}

function doctorHealth(audit: HarnessAuditResult, memory: MemorySpineDiagnostics, taskLayer: AgentsTaskLayer): "ok" | "warning" {
	if (!audit.ok || (audit.ok && Boolean(audit.audit.issues?.length))) return "warning";
	if (memory.health === "warning") return "warning";
	if (taskLayer.health() === "warning") return "warning";
	return "ok";
}

async function buildDoctor(pi: ExtensionAPI, ctx: ExtensionContext, taskLayer: AgentsTaskLayer): Promise<string> {
	const git = await gitSummary(pi, ctx.cwd);
	const audit = await runHarnessAudit(pi);
	const branch = ctx.sessionManager.getBranch();
	const memory = buildMemorySpineDiagnostics(branch);
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
	const tools = pi.getActiveTools();
	return [
		"## Harness doctor",
		`- health: ${doctorHealth(audit, memory, taskLayer)}`,
		`- package: ben-pi-harness ${audit.ok ? audit.audit.packageVersion ?? "unknown" : "unknown"}`,
		`- cwd: ${ctx.cwd}`,
		`- model: ${model}`,
		`- thinking: ${pi.getThinkingLevel()}`,
		`- context: ${contextSummary(ctx)}`,
		`- git: ${git.branch ? `${git.branch}, ` : ""}${git.summary}`,
		`- active tools: ${tools.length ? tools.join(", ") : "none"}`,
		`- session entries: ${branch.length}`,
		"",
		"### Harness audit",
		...formatHarnessAuditLines(audit),
		"",
		formatMemorySpineDiagnostics(memory, { verbose: true }),
		"",
		taskLayer.doctorSection(),
		"",
		"### Recommendations",
		...doctorRecommendations(audit, memory, taskLayer).map((recommendation) => `- ${recommendation}`),
	].join("\n");
}

function formatAudit(stdout: string): string {
	try {
		const data = JSON.parse(stdout) as {
			root: string;
			issues: string[];
			warnings: string[];
			metrics: { skillCount: number; skillLinks: number; descriptionChars: number };
		};
		return [
			"## Skills audit",
			`- root: ${data.root}`,
			`- skills: ${data.metrics.skillCount}`,
			`- skill links: ${data.metrics.skillLinks}`,
			`- description chars: ${data.metrics.descriptionChars} (~${Math.ceil(data.metrics.descriptionChars / 4)} tokens)`,
			`- issues: ${data.issues.length}`,
			`- warnings: ${data.warnings.length}`,
			...(data.issues.length ? ["", "### Issues", ...data.issues.map((issue) => `- ${issue}`)] : []),
			...(data.warnings.length ? ["", "### Warnings", ...data.warnings.map((warning) => `- ${warning}`)] : []),
		].join("\n");
	} catch {
		return stdout.trim() || "skills audit produced no output";
	}
}

export default function harnessCommands(pi: ExtensionAPI) {
	const taskLayer = createAgentsTaskLayer();
	let activeMode: string | undefined;
	let sawFileMutation = false;
	let currentPromptIsCleanupGuard = false;
	let currentPromptNeedsCleanup = false;
	let currentPromptWasMajor = false;
	let initialChangeSnapshot: GitChangeSnapshot | undefined;

	pi.registerCommand("mode", {
		description: "Switch harness mode: fast, default, deep, readonly, full",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			return modeNames()
				.filter((name) => name.startsWith(p))
				.map((name) => ({ value: name, label: name, description: MODES[name].description }));
		},
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				const lines = ["## Available harness modes", ...modeNames().map((name) => `- ${name}: ${MODES[name].description}`)];
				pi.sendMessage({ customType: "harness-mode", content: lines.join("\n"), display: true });
				return;
			}

			const mode = MODES[requested];
			if (!mode) {
				ctx.ui.notify(`Unknown mode: ${requested}. Available: ${modeNames().join(", ")}`, "error");
				return;
			}

			await applyMode(requested, mode, pi, ctx);
			activeMode = requested;
		},
	});

	pi.registerCommand("status", {
		description: "Show current harness, model, tool, context, git, audit, memory, and task status",
		handler: async (_args, ctx) => {
			pi.sendMessage({ customType: "harness-status", content: await buildStatus(pi, ctx, taskLayer), display: true });
		},
	});

	pi.registerCommand("doctor", {
		description: "Run a read-only harness health check with memory-spine and AGENTS task diagnostics",
		handler: async (_args, ctx) => {
			pi.sendMessage({ customType: "harness-doctor", content: await buildDoctor(pi, ctx, taskLayer), display: true });
		},
	});

	pi.registerCommand("doct", {
		description: "Alias for /doctor",
		handler: async (_args, ctx) => {
			pi.sendMessage({ customType: "harness-doctor", content: await buildDoctor(pi, ctx, taskLayer), display: true });
		},
	});

	pi.registerCommand("memory", {
		description: "Show memory-spine checkpoint and compaction diagnostics",
		handler: async (_args, ctx) => {
			const content = formatMemorySpineDiagnostics(buildMemorySpineDiagnostics(ctx.sessionManager.getBranch()), { verbose: true });
			pi.sendMessage({ customType: "harness-memory", content, display: true });
		},
	});

	pi.registerCommand("checkpoint", {
		description: "Create a visible session checkpoint with current harness status",
		handler: async (args, ctx) => {
			const label = args.trim() || new Date().toISOString().replace(/[:.]/g, "-");
			const leafId = ctx.sessionManager.getLeafId();
			if (leafId) pi.setLabel(leafId, `checkpoint: ${label}`);
			const content = [`## Checkpoint: ${label}`, await buildStatus(pi, ctx, taskLayer), "", "Next-step note:", args.trim() || "None provided."].join(
				"\n",
			);
			pi.sendMessage({ customType: "harness-checkpoint", content, display: true, details: { label } });
			ctx.ui.notify(`Checkpoint created: ${label}`, "info");
		},
	});

	pi.registerCommand("skills-audit", {
		description: "Audit the shared .agents skill graph for schema, registry, link, and bloat issues",
		handler: async (args, ctx) => {
			const root = args.trim() || DEFAULT_SKILLS_ROOT;
			const script = join(PACKAGE_ROOT, "scripts", "skills-audit.mjs");
			const result = await pi.exec("node", [script, "--root", root, "--json"], { cwd: PACKAGE_ROOT, timeout: 15_000 });
			const content = result.code === 0 ? formatAudit(result.stdout) : `## Skills audit failed\n\n${result.stderr || result.stdout}`;
			pi.sendMessage({ customType: "skills-audit", content, display: true, details: { root, exitCode: result.code } });
			ctx.ui.notify(result.code === 0 ? "Skills audit completed" : "Skills audit failed", result.code === 0 ? "info" : "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await taskLayer.sessionStart(pi, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const weight = classifyPrompt(event.prompt);
		sawFileMutation = false;
		currentPromptIsCleanupGuard = event.prompt.includes(CLEANUP_GUARD_MARKER);
		currentPromptNeedsCleanup = isCodingOrFilePrompt(event.prompt);
		currentPromptWasMajor = promptSuggestsMajorCleanup(event.prompt, weight);
		initialChangeSnapshot = currentPromptNeedsCleanup ? await gitChangeSnapshot(pi, ctx.cwd) : undefined;

		const taskContext = await taskLayer.beforeAgentStart(pi, event.prompt, weight, ctx);
		const additions: string[] = [DISPLAY_MATH_RENDERING_INSTRUCTION, MARKDOWN_HEADING_RENDERING_INSTRUCTION];
		if (activeMode && MODES[activeMode]?.instructions) additions.push(MODES[activeMode].instructions!);
		const reminder = skillRoutingReminder(weight);
		if (reminder) additions.push(reminder);
		const cleanup = cleanupReminder(event.prompt, weight);
		if (cleanup) additions.push(cleanup);
		if (taskContext) additions.push(taskContext);
		if (!additions.length) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` };
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			sawFileMutation = true;
			return;
		}
		if (event.toolName === "bash" && looksFileMutatingCommand(String((event.input as { command?: unknown }).command ?? ""))) {
			sawFileMutation = true;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		await taskLayer.toolResult(pi, event, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await taskLayer.agentEnd(pi, ctx);
		if (currentPromptIsCleanupGuard || !sawFileMutation || !currentPromptNeedsCleanup) return;
		const currentSnapshot = await gitChangeSnapshot(pi, ctx.cwd);
		if (!currentSnapshot || currentSnapshot.signature === initialChangeSnapshot?.signature) return;
		const changedStats = diffDelta(initialChangeSnapshot?.stats, currentSnapshot.stats);
		if (!currentPromptWasMajor && !diffLooksMajor(changedStats)) return;
		pi.sendUserMessage(cleanupGuardMessage(changedStats, currentPromptWasMajor), { deliverAs: "followUp" });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await taskLayer.sessionShutdown(pi, ctx);
	});
}
