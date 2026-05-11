import { skillsRoot } from "./config";
export type TaskWeight = "trivial" | "standard" | "complex";
export const DISPLAY_MATH_RENDERING_INSTRUCTION = [
	"## Display Math Rendering",
	"When writing display equations in assistant responses, use `\\begin{displaymath}` and `\\end{displaymath}` delimiters instead of `\\[` and `\\]` so the local LaTeX preview renderer activates reliably.",
].join("\n");
export const MARKDOWN_HEADING_RENDERING_INSTRUCTION = [
	"## Markdown Heading Rendering",
	"When formatting assistant responses, use only `#` and `##` Markdown headings. For deeper structure, use bold lead-in labels like `**Subsection.**` instead of `###`, `####`, `#####`, or `######`, because the local terminal renderer displays level-3-and-deeper heading markers literally.",
].join("\n");
export function classifyPrompt(prompt: string): TaskWeight {
	const text = prompt.trim();
	const lower = text.toLowerCase();
	if (
		lower.includes("all of them") ||
		lower.includes("end-to-end") ||
		lower.includes("full fledged") ||
		/\b(?:release|workflow|ci|multi-step|research|package|safety gate)\b/.test(lower)
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
export function skillRoutingReminder(weight: TaskWeight): string | undefined {
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
export function isCodingOrFilePrompt(prompt: string): boolean {
	const lower = prompt.toLowerCase();
	return (
		isExecutionContinuationPrompt(prompt) ||
		/\b(implement|code|coding|edit|modify|change|refactor|fix|debug|add|remove|delete|rename|create|write|update|migrate|replace|fold|cleanup|clean up|test|ci|package|extension|skill|config|repo|file)\b/.test(lower) ||
		/\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|sh|zsh|fish|json|ya?ml|toml|md|tex|css|scss|html)\b/i.test(prompt)
	);
}
export function promptSuggestsMajorCleanup(prompt: string, _weight: TaskWeight): boolean {
	const lower = prompt.toLowerCase();
	return /\b(major|large|big|broad|codebase|repo-wide|repository-wide|general review|overhaul|migration|sweep|entire repo|all of them|full rewrite|old slop)\b/.test(lower);
}
export function gitPushReminder(prompt: string, weight: TaskWeight): string | undefined {
	if (weight === "trivial" || !isCodingOrFilePrompt(prompt)) return undefined;
	return [
		"## Git Push Default",
		"When pushing committed work for the current branch, use `git push` so Git uses the configured upstream/tracking branch.",
		"Do not use `git push origin main` by default. Use an explicit remote/refspec only when the user asks for it or no upstream exists and you have confirmed the correct target.",
	].join("\n");
}

export function cleanupReminder(prompt: string, weight: TaskWeight): string | undefined {
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
