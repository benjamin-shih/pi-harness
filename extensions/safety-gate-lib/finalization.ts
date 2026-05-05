import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const GIT_FINALIZATION_MARKER = "PI_GIT_FINALIZATION_GUARD";

export type GitFinalizationState = {
	root: string;
	statusText: string;
	dirtyLines: string[];
	head: string;
	hasUpstream: boolean;
	behind: number;
	ahead: number;
};

function parseAheadBehind(stdout: string): { behind: number; ahead: number } {
	const [behindText, aheadText] = stdout.trim().split(/\s+/);
	return {
		behind: Number.parseInt(behindText ?? "0", 10) || 0,
		ahead: Number.parseInt(aheadText ?? "0", 10) || 0,
	};
}

export async function getGitFinalizationState(pi: ExtensionAPI, cwd: string): Promise<GitFinalizationState | undefined> {
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 });
	if (root.code !== 0) return undefined;
	const status = await pi.exec("git", ["status", "--porcelain=v1", "--branch"], { cwd, timeout: 5_000 });
	if (status.code !== 0) return undefined;
	const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 });
	if (head.code !== 0) return undefined;
	const lines = status.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
	const dirtyLines = lines.filter((line) => !line.startsWith("##"));
	const upstreamCount = await pi.exec("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"], { cwd, timeout: 5_000 });
	const counts = upstreamCount.code === 0 ? parseAheadBehind(upstreamCount.stdout) : { behind: 0, ahead: 0 };
	return {
		root: root.stdout.trim(),
		statusText: status.stdout.trimEnd(),
		dirtyLines,
		head: head.stdout.trim(),
		hasUpstream: upstreamCount.code === 0,
		behind: counts.behind,
		ahead: counts.ahead,
	};
}

export function gitFinalizationStateChanged(before: GitFinalizationState | undefined, after: GitFinalizationState): boolean {
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

export function needsGitFinalization(state: GitFinalizationState, before: GitFinalizationState | undefined): boolean {
	if (state.dirtyLines.length > 0) return true;
	if (state.ahead > 0) return true;
	if (!state.hasUpstream && before && state.head !== before.head) return true;
	return false;
}

export function summarizeGitFinalizationState(state: GitFinalizationState): string {
	const parts: string[] = [];
	if (state.dirtyLines.length > 0) parts.push(`${state.dirtyLines.length} dirty/untracked file(s)`);
	if (state.ahead > 0) parts.push(`${state.ahead} unpushed commit(s)`);
	if (!state.hasUpstream) parts.push("no upstream configured");
	return parts.join(", ") || "git finalization incomplete";
}
