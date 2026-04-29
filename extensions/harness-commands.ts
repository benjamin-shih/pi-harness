import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SKILLS_ROOT = "/Users/benjaminshih/.agents/skills";

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

function contextSummary(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) return "unknown";
	return `${usage.percent.toFixed(1)}% (${usage.tokens}/${usage.contextWindow})`;
}

async function buildStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string> {
	const git = await gitSummary(pi, ctx.cwd);
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
		`- session entries: ${ctx.sessionManager.getBranch().length}`,
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
	let activeMode: string | undefined;

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
		description: "Show current harness, model, tool, context, and git status",
		handler: async (_args, ctx) => {
			pi.sendMessage({ customType: "harness-status", content: await buildStatus(pi, ctx), display: true });
		},
	});

	pi.registerCommand("checkpoint", {
		description: "Create a visible session checkpoint with current harness status",
		handler: async (args, ctx) => {
			const label = args.trim() || new Date().toISOString().replace(/[:.]/g, "-");
			const leafId = ctx.sessionManager.getLeafId();
			if (leafId) pi.setLabel(leafId, `checkpoint: ${label}`);
			const content = [`## Checkpoint: ${label}`, await buildStatus(pi, ctx), "", "Next-step note:", args.trim() || "None provided."].join(
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

	pi.on("before_agent_start", async (event) => {
		const additions: string[] = [];
		if (activeMode && MODES[activeMode]?.instructions) additions.push(MODES[activeMode].instructions!);
		const reminder = skillRoutingReminder(classifyPrompt(event.prompt));
		if (reminder) additions.push(reminder);
		if (!additions.length) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` };
	});
}
