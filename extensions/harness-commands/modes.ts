import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ModeDefinition = {
	description: string;
	provider?: string;
	models?: string[];
	thinking: ThinkingLevel;
	tools: "all" | string[];
	instructions?: string;
};
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
function allToolNames(pi: ExtensionAPI): string[] {
	return pi.getAllTools().map((tool) => tool.name);
}
export function modeNames(): string[] {
	return Object.keys(MODES);
}
export function modeDescription(name: string): string {
	return MODES[name]?.description ?? "";
}
export function modeInstructions(name: string | undefined): string | undefined {
	return name ? MODES[name]?.instructions : undefined;
}
export async function applyMode(name: string, pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	const mode = MODES[name];
	if (!mode) return false;
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
