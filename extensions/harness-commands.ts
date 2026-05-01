import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	CLEANUP_GUARD_MARKER,
	cleanupGuardMessage,
	diffDelta,
	diffLooksMajor,
	gitChangeSnapshot,
	looksFileMutatingCommand,
	type GitChangeSnapshot,
} from "./harness-commands/cleanup-guard";
import { buildDoctor, buildStatus } from "./harness-commands/status";
import { createAgentsTaskLayer } from "./harness-commands/task-layer";
import { skillsRoot } from "./shared/config";
import { buildMemorySpineDiagnostics, formatMemorySpineDiagnostics } from "./session-continuity/diagnostics";

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
		`For nontrivial work, use \`${skillsRoot()}/SKILLS.md\` as the skill graph root.`,
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
			const root = args.trim() || skillsRoot();
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
