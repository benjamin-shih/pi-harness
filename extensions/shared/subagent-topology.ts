import type { TaskWeight } from "./prompt-guidance";

const DETAILED_TASK_PATTERN = /\b(?:complex|detailed|risky|risk|architecture|architectural|multi-step|high-stakes|migration|release|research|audit|security|deployment|post-implementation|implementation review|independent scout|scout|planner|oracle|reviewer)\b/i;

export function shouldIncludeSubagentTopologyGuidance(prompt: string, weight: TaskWeight): boolean {
	if (weight === "trivial") return false;
	return weight === "complex" || DETAILED_TASK_PATTERN.test(prompt);
}

export function buildSubagentTopologyReminder(prompt: string, weight: TaskWeight): string | undefined {
	if (!shouldIncludeSubagentTopologyGuidance(prompt, weight)) return undefined;
	return [
		"## Subagent Topology Reminder",
		"For detailed work, default to a small, relevant subagent topology when it materially improves quality or speed.",
		"Good triggers: complex/risky changes, architecture decisions, independent scouts, research lanes, and post-implementation review.",
		"Suggested topology: scout/researcher for independent context or source recon; planner for ambiguous multi-step decomposition; oracle for architecture, risk, profile/overlay fit, and decision consistency; reviewer for blocker-only post-implementation review.",
		"Use worker only for explicitly bounded implementation handoffs when safe. Keep the main agent accountable for synthesis, verification, commits, cleanup, and preventing stray artifacts such as progress.md.",
		"Ask subagents to adopt the same relevant profile and capability overlays for their lane.",
	].join("\n");
}
