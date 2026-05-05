import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { countTrackedPorcelain, gitOutput } from "./git-summary";

export type RepoContextSummary = {
	cwd: string;
	root?: string;
	branch?: string;
	status: "clean" | "dirty" | "not_git" | "unavailable";
	summary: string;
};

function summarizePorcelain(status: string): string {
	if (!status) return "clean (untracked not scanned)";
	const { staged, unstaged } = countTrackedPorcelain(status);
	return `${staged} staged, ${unstaged} unstaged, untracked not scanned`;
}

export async function buildRepoContextSummary(pi: ExtensionAPI, cwd: string): Promise<RepoContextSummary> {
	const root = await gitOutput(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (!root) return { cwd, status: "not_git", summary: "not a git repo" };
	const [branch, porcelain] = await Promise.all([
		gitOutput(pi, cwd, ["branch", "--show-current"]),
		gitOutput(pi, cwd, ["status", "--porcelain=v1", "--untracked-files=no"], { preserveLeading: true }),
	]);
	if (porcelain === undefined) return { cwd, root, branch, status: "unavailable", summary: "git status unavailable" };
	const summary = summarizePorcelain(porcelain);
	return { cwd, root, branch, status: summary.startsWith("clean") ? "clean" : "dirty", summary };
}

export function formatRepoContext(summary: RepoContextSummary): string | undefined {
	if (summary.status === "not_git") return undefined;
	return [
		"## Repo Context",
		`- cwd: ${summary.cwd}`,
		`- git root: ${summary.root ?? "unknown"}`,
		`- git branch: ${summary.branch || "unknown"}`,
		`- git status: ${summary.summary}`,
	].join("\n");
}
