export type ExecutionProfile = "software" | "devops" | "research_ai_ml" | "empirical_data" | "documentation" | "general_execution";
export type ExecutionOverlay = "math_latex" | "release_changelog" | "python_uv" | "plotting" | "security_privacy" | "repo_cleanup" | "package_hygiene" | "subagent_orchestration";

export type ExecutionRoute = {
	profile: ExecutionProfile;
	overlays: ExecutionOverlay[];
	summary: string;
	guidance: string;
};

const PROFILE_GUIDANCE: Record<ExecutionProfile, string> = {
	software: "Role: senior software architect/engineering lead. Optimize for maintainability, modularity, tests, simple ownership boundaries, and removing bloat/deprecations as you work.",
	devops: "Role: senior DevOps/platform engineer. Optimize for deterministic validation, rollback paths, secret hygiene, least-risk operational changes, and clear tool tradeoffs.",
	research_ai_ml: "Role: senior AI/ML researcher. Ground claims in sources or experiments, compare baselines, check methodology, cite literature when used, and state uncertainty/limitations.",
	empirical_data: "Role: senior empirical/data researcher. Guard against leakage, define metrics carefully, keep analyses reproducible, run robustness checks, and avoid overclaiming.",
	documentation: "Role: senior technical editor/educator. Model the reader, structure explanations clearly, keep terminology consistent, and source-ground factual claims.",
	general_execution: "Role: senior operator. Execute deliberately with evidence, verification, clean rollback history, and concise reporting.",
};

const OVERLAY_GUIDANCE: Record<ExecutionOverlay, string> = {
	math_latex: "Math/LaTeX overlay: preserve notation, make derivations explicit, use relevant LaTeX/figure/compilation skills, and compile or render-check when editing TeX artifacts.",
	release_changelog: "Release overlay: handle versioning, changelog/release notes, tags/publishing checks, compatibility notes, and CI/release verification.",
	python_uv: "Python/UV overlay: prefer project-local UV workflows, avoid ad-hoc global installs, and verify with the narrowest relevant Python tests/scripts before broader checks.",
	plotting: "Plotting overlay: make figures reproducible, document-ready, labeled, and style-consistent; regenerate outputs from source scripts when possible.",
	security_privacy: "Security/privacy overlay: protect secrets, avoid sensitive output, audit credential-bearing paths carefully, and stop before irreversible or unsafe operations.",
	repo_cleanup: "Cleanup overlay: remove dead/stale code touched by the change, keep abstractions minimal, and run focused regression checks after simplification.",
	package_hygiene: "Package hygiene overlay: respect lockfiles/package managers, avoid unnecessary dependency churn, and validate install/build impacts.",
	subagent_orchestration: "Subagent overlay: use scout/planner/oracle/reviewer roles when they improve quality; keep the main agent accountable and prevent stray artifacts.",
};

const PROFILE_PATTERNS: Array<[ExecutionProfile, RegExp]> = [
	["research_ai_ml", /\b(?:ai|ml|machine learning|deep learning|neural|llm|transformer|paper|literature|baseline|ablation|model eval|benchmark|training|finetun(?:e|ing)|mechanistic interpretability)\b/i],
	["devops", /\b(?:devops|ci\/?cd|deploy(?:ment)?|docker|kubernetes|k8s|terraform|helm|ansible|github actions?|workflow|runner|infra(?:structure)?|secrets?|environment|production|staging|rollback)\b/i],
	["empirical_data", /\b(?:data analysis|dataset|statistics?|statistical|regression|experiment|metrics?|quant|backtest|notebook|pandas|numpy|simulation|robustness|confidence interval)\b/i],
	["software", /\b(?:code|software|implement|refactor|debug|api|tests?|typescript|javascript|python|extension|module|class|function|repo|repository|package|release|changelog|version|build|fix|feature|architecture)\b|\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp)\b/i],
	["documentation", /\b(?:documentation|docs?|readme|guide|tutorial|writeup|study notes?|technical writing|explain|manual|article|report)\b/i],
];

const OVERLAY_PATTERNS: Array<[ExecutionOverlay, RegExp]> = [
	["math_latex", /\b(?:latex|tex|lualatex|tikz|pgfplots|theorem|lemma|proof|derivation|equation|math(?:ematical)?|notation|compile pdf)\b|\.tex\b/i],
	["release_changelog", /\b(?:release|changelog|version|semver|tag|publish|npm publish|release notes?)\b/i],
	["python_uv", /\b(?:python|uv|pyproject|pytest|venv|pip|notebook|pandas|numpy)\b|\.py\b/i],
	["plotting", /\b(?:plot|chart|figure|visuali[sz]ation|matplotlib|seaborn|graph|axis|legend|pgfplots)\b/i],
	["security_privacy", /\b(?:secrets?|credentials?|tokens?|password|api key|private key|auth|oauth|privacy|redact|vulnerab|supply chain|permission)\b/i],
	["repo_cleanup", /\b(?:simplify|cleanup|clean up|remove bloat|dead code|stale|obsolete|deprecat|refactor|monolith|drift)\b/i],
	["package_hygiene", /\b(?:package manager|dependency|dependencies|lockfile|package-lock|pnpm|yarn|npm install|homebrew|brew|system package)\b/i],
	["subagent_orchestration", /\b(?:subagents?|oracle|reviewer|scout|planner|delegate|parallel|orchestrat|team of agents?)\b/i],
];

const EXECUTION_INTENT_PATTERNS = [
	/^\s*(?:go ahead|do it|do this|ship it|execute|one[- ]shot it)\s*[.!]*\s*$/i,
	/\bgo ahead\b[^\n]{0,80}\b(?:implement|execute|ship|do|make|apply|run|commit|push|simplify|cleanup|clean up|refactor|write|author|continue|complete|finish|prepare)\b/i,
	/\bgo ahead\b[^\n]{0,80}\b(?:with|from)\b[^\n]{0,80}\b(?:plan|implementation|work|task|changes|latest checkpoint|checkpoint)\b/i,
	/^\s*(?:please\s+)?(?:execute|ship|one[- ]shot|implement)\b[^\n]{0,80}\b(?:this|it|the plan|the current task|end[- ]to[- ]end|to completion)\b/i,
	/\btake (?:this|it) (?:through|to) (?:completion|the finish line)\b/i,
];

const DISCUSSION_PREFIX = /^\s*(?:how|what|why|can|could|should|would|do you think|explain|discuss)\b/i;
const DISCUSSION_TERMS = /\b(?:discuss|discussion|discussing|talk through|talk about|explain)\b/i;
const STRONG_EXECUTION_AUTHORIZATION = /\b(?:go ahead|execute|ship|do it|do this|implement|one[- ]shot|commit|push)\b/i;

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

export function hasExecutionIntent(prompt: string): boolean {
	const text = prompt.trim();
	if (DISCUSSION_PREFIX.test(text)) return false;
	if (DISCUSSION_TERMS.test(text) && !STRONG_EXECUTION_AUTHORIZATION.test(text)) return false;
	return EXECUTION_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyExecutionProfile(prompt: string): ExecutionProfile {
	return PROFILE_PATTERNS.find(([, pattern]) => pattern.test(prompt))?.[0] ?? "general_execution";
}

export function classifyExecutionOverlays(prompt: string): ExecutionOverlay[] {
	return unique(OVERLAY_PATTERNS.filter(([, pattern]) => pattern.test(prompt)).map(([overlay]) => overlay));
}

function formatOverlays(overlays: ExecutionOverlay[]): string {
	return overlays.length ? overlays.join(", ") : "none";
}

export function formatExecutionRouteSummary(route: Pick<ExecutionRoute, "profile" | "overlays">): string {
	return `profile ${route.profile}; overlays ${formatOverlays(route.overlays)}`;
}

export function buildExecutionGuidance(prompt: string): ExecutionRoute | undefined {
	if (!hasExecutionIntent(prompt)) return undefined;
	const profile = classifyExecutionProfile(prompt);
	const overlays = classifyExecutionOverlays(prompt);
	const summary = formatExecutionRouteSummary({ profile, overlays });
	const lines = [
		"## Ambient Execution Protocol",
		"Execution intent was detected. Treat this as authorization to execute the current task, not merely discuss it.",
		`Primary profile: ${profile}. Capability overlays: ${formatOverlays(overlays)}.`,
		"If this is a continuation prompt, infer the concrete domain from the conversation and correct the route before executing.",
		PROFILE_GUIDANCE[profile],
		...overlays.map((overlay) => OVERLAY_GUIDANCE[overlay]),
		"Universal execution contract:",
		"- Restate scope, assumptions, and done condition before major work; inspect repo/task state first.",
		"- Load the smallest relevant skill set and use profile-appropriate subagents for scout/planning/oracle/review when they improve quality.",
		"- Implement in coherent slices; verify narrowly after each slice; simplify touched code before finalizing.",
		"- Automatically commit and push task-relevant verified changes. For larger tasks, make incremental coherent commits so history stays revertable.",
		"- Never stage unrelated dirty files, secrets, or generated junk; stop and report if safe isolation is impossible.",
		"- Before final push, run the repo's full local verification when available, then watch remote CI/checks when practical.",
		"- Final report: role/profile, changed files/behavior, commits, verification/CI, subagents used, residual risks, and unrelated repo state.",
	];
	return { profile, overlays, summary, guidance: lines.join("\n") };
}
