import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RUN_DISCOVERY_ATTEMPTS = 8;
const RUN_DISCOVERY_DELAY_MS = 3_000;
const GH_COMMAND_TIMEOUT_MS = 30_000;
const GH_WATCH_TIMEOUT_MS = 12 * 60 * 1_000;

export type RemoteCiGuardState = "passed" | "failed" | "pending" | "skipped" | "unavailable";

export type RemoteCiGuardResult = {
	state: RemoteCiGuardState;
	summary: string;
	headSha?: string;
	runId?: string;
	conclusion?: string;
};

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

type GhRun = {
	databaseId?: number | string;
	status?: string;
	conclusion?: string;
	headSha?: string;
	name?: string;
	workflowName?: string;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function result(state: RemoteCiGuardState, summary: string, extras: Partial<RemoteCiGuardResult> = {}): RemoteCiGuardResult {
	return { state, summary: oneLine(summary), ...extras };
}

async function exec(pi: ExtensionAPI, cwd: string, cmd: string, args: string[], timeout = GH_COMMAND_TIMEOUT_MS): Promise<ExecResult> {
	return pi.exec(cmd, args, { cwd, timeout });
}

function parseRuns(stdout: string, headSha: string): GhRun[] {
	try {
		const parsed = JSON.parse(stdout) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((run): run is GhRun => Boolean(run && typeof run === "object" && String((run as GhRun).headSha ?? headSha) === headSha));
	} catch {
		return [];
	}
}

async function currentHead(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const head = await exec(pi, cwd, "git", ["rev-parse", "HEAD"], 5_000);
	return head.code === 0 ? head.stdout.trim() || undefined : undefined;
}

async function hasGithubRemote(pi: ExtensionAPI, cwd: string): Promise<boolean | undefined> {
	const remotes = await exec(pi, cwd, "git", ["remote", "-v"], 5_000);
	if (remotes.code !== 0) return undefined;
	return /github\.com[:/]/i.test(remotes.stdout);
}

async function latestRuns(pi: ExtensionAPI, cwd: string, headSha: string): Promise<GhRun[]> {
	const listed = await exec(pi, cwd, "gh", ["run", "list", "--commit", headSha, "--limit", "20", "--json", "databaseId,status,conclusion,headSha,name,workflowName"]);
	if (listed.code !== 0) return [];
	return parseRuns(listed.stdout, headSha);
}

function runId(run: GhRun | undefined): string | undefined {
	const id = run?.databaseId;
	return id === undefined || id === null || id === "" ? undefined : String(id);
}

function completedState(runs: GhRun[], headSha: string): RemoteCiGuardResult | undefined {
	const failed = runs.find((run) => run.status === "completed" && String(run.conclusion || "unknown") !== "success");
	if (failed) {
		const id = runId(failed);
		const conclusion = String(failed.conclusion || "unknown");
		return result("failed", `remote CI concluded ${conclusion}${id ? ` for run ${id}` : ""}`, { headSha, runId: id, conclusion });
	}
	if (runs.some((run) => run.status !== "completed")) return undefined;
	const passed = runs.find((run) => run.status === "completed" && run.conclusion === "success");
	if (!passed) return undefined;
	const id = runId(passed);
	return result("passed", `remote CI passed${id ? ` for run ${id}` : ""}`, { headSha, runId: id, conclusion: "success" });
}

export function isGitPushCommand(command: string): boolean {
	return /(^|[;&|()\s])git\s+(?:-[^\s]+\s+)*push\b/.test(command);
}

export async function checkRemoteCiAfterPush(pi: ExtensionAPI, cwd: string): Promise<RemoteCiGuardResult> {
	const headSha = await currentHead(pi, cwd);
	if (!headSha) return result("skipped", "remote CI skipped: not a git repository");

	const githubRemote = await hasGithubRemote(pi, cwd);
	if (githubRemote === false) return result("skipped", "remote CI skipped: no GitHub remote", { headSha });
	if (githubRemote === undefined) return result("unavailable", "remote CI unavailable: could not inspect git remotes", { headSha });

	let runs: GhRun[] = [];
	for (let attempt = 0; attempt < RUN_DISCOVERY_ATTEMPTS; attempt++) {
		runs = await latestRuns(pi, cwd, headSha);
		if (runs.length > 0) break;
		if (attempt + 1 < RUN_DISCOVERY_ATTEMPTS) await sleep(RUN_DISCOVERY_DELAY_MS);
	}
	if (runs.length === 0) return result("pending", "remote CI pending: no GitHub Actions run found for pushed HEAD yet", { headSha });

	const completed = completedState(runs, headSha);
	if (completed) return completed;
	const id = runId(runs.find((run) => run.status !== "completed"));
	if (!id) return result("pending", "remote CI pending: active run id unavailable", { headSha });

	const watched = await exec(pi, cwd, "gh", ["run", "watch", id, "--exit-status"], GH_WATCH_TIMEOUT_MS);
	const refreshedRuns = await latestRuns(pi, cwd, headSha);
	const refreshedCompleted = completedState(refreshedRuns, headSha);
	if (refreshedCompleted) return refreshedCompleted;
	if (watched.code === 0) return result("passed", `remote CI passed for run ${id}`, { headSha, runId: id, conclusion: "success" });
	return result("failed", `remote CI failed or timed out for run ${id}`, { headSha, runId: id, conclusion: refreshedRuns.find((run) => runId(run) === id)?.conclusion || "unknown" });
}

export function remoteCiVisibilitySummary(ci: RemoteCiGuardResult | undefined): string | undefined {
	if (!ci) return undefined;
	return `remote ${ci.state} · ${ci.summary}`;
}

export function remoteCiGuardBlock(ci: RemoteCiGuardResult | undefined): string | undefined {
	if (!ci || ci.state === "passed" || ci.state === "skipped") return undefined;
	return [
		"## Remote CI guard",
		`Remote CI did not pass before finalization: ${ci.summary}.`,
		"Treat this turn as blocked until the pushed commit's remote CI is green or the failure is explicitly triaged.",
	].join("\n");
}
