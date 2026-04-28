import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MARKER = "PI_GIT_FINALIZATION_GUARD";

type GitState = {
	root: string;
	statusText: string;
	dirtyLines: string[];
	branchLine: string;
	head: string;
	hasUpstream: boolean;
	behind: number;
	ahead: number;
};

function parseCount(stdout: string): { behind: number; ahead: number } {
	const [behindText, aheadText] = stdout.trim().split(/\s+/);
	return {
		behind: Number.parseInt(behindText ?? "0", 10) || 0,
		ahead: Number.parseInt(aheadText ?? "0", 10) || 0,
	};
}

async function getGitState(pi: ExtensionAPI): Promise<GitState | undefined> {
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0) return;

	const status = await pi.exec("git", ["status", "--porcelain=v1", "--branch"]);
	if (status.code !== 0) return;

	const head = await pi.exec("git", ["rev-parse", "HEAD"]);
	if (head.code !== 0) return;

	const lines = status.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
	const branchLine = lines.find((line) => line.startsWith("##")) ?? "";
	const dirtyLines = lines.filter((line) => !line.startsWith("##"));

	const upstreamCount = await pi.exec("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
	const counts = upstreamCount.code === 0 ? parseCount(upstreamCount.stdout) : { behind: 0, ahead: 0 };

	return {
		root: root.stdout.trim(),
		statusText: status.stdout.trimEnd(),
		dirtyLines,
		branchLine,
		head: head.stdout.trim(),
		hasUpstream: upstreamCount.code === 0,
		behind: counts.behind,
		ahead: counts.ahead,
	};
}

function stateChanged(before: GitState | undefined, after: GitState): boolean {
	if (!before) return true;
	return (
		before.root !== after.root ||
		before.statusText !== after.statusText ||
		before.head !== after.head ||
		before.hasUpstream !== after.hasUpstream ||
		before.behind !== after.behind ||
		before.ahead !== after.ahead
	);
}

function looksMutatingBash(command: string): boolean {
	return /(^|[;&|()\s])(?:rm|mv|cp|touch|mkdir|rmdir|tee|python|python3|node|npm|pnpm|yarn|make|lualatex|latexmk|git\s+(?:add|commit|push|reset|checkout|switch|merge|rebase|stash|clean))\b/.test(command)
		|| /(^|[^<])>{1,2}\s*[^&]/.test(command)
		|| /\b(?:sed|perl)\s+[^\n]*\s-i\b/.test(command);
}

function needsFinalization(state: GitState, before: GitState | undefined): boolean {
	if (state.dirtyLines.length > 0) return true;
	if (state.ahead > 0) return true;
	if (!state.hasUpstream && before && state.head !== before.head) return true;
	return false;
}

function summarizeState(state: GitState): string {
	const parts: string[] = [];
	if (state.dirtyLines.length > 0) parts.push(`${state.dirtyLines.length} dirty/untracked file(s)`);
	if (state.ahead > 0) parts.push(`${state.ahead} unpushed commit(s)`);
	if (!state.hasUpstream) parts.push("no upstream configured");
	return parts.join(", ") || "git finalization incomplete";
}

export default function (pi: ExtensionAPI) {
	let initialState: GitState | undefined;
	let sawPotentialMutation = false;
	let currentPromptIsGuardBounce = false;

	pi.on("before_agent_start", async (event) => {
		initialState = await getGitState(pi);
		sawPotentialMutation = false;
		currentPromptIsGuardBounce = event.prompt.includes(MARKER);
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			sawPotentialMutation = true;
			return;
		}

		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (looksMutatingBash(command)) sawPotentialMutation = true;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		const currentState = await getGitState(pi);
		if (!currentState) return;

		const modifiedThisPrompt = sawPotentialMutation || stateChanged(initialState, currentState);
		if (!modifiedThisPrompt || !needsFinalization(currentState, initialState)) return;

		if (currentPromptIsGuardBounce) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Git finalization still incomplete: ${summarizeState(currentState)}`, "warning");
			}
			return;
		}

		const message = `${MARKER}: Git finalization is incomplete (${summarizeState(currentState)}). Continue: run the relevant validation, commit, and push before giving the final summary. If finalization is blocked, report the exact blocker and leave the repo state explicit.`;
		pi.sendUserMessage(message, { deliverAs: "followUp", triggerTurn: true });
	});
}
