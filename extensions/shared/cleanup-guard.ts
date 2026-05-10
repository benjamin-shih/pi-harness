import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CLEANUP_GUARD_MARKER = "PI_CLEANUP_GUARD";

const MAJOR_CLEANUP_FILE_THRESHOLD = 4;
const MAJOR_CLEANUP_FILE_LINE_FLOOR = 40;
const MAJOR_CLEANUP_LINE_THRESHOLD = 200;

type PathStat = {
	inserted: number;
	deleted: number;
	untracked: boolean;
};

type DiffStats = {
	files: number;
	inserted: number;
	deleted: number;
	untracked: number;
	paths: string[];
	byPath: Record<string, PathStat>;
};

export type GitChangeSnapshot = {
	stats: DiffStats;
	signature: string;
	head?: string;
};

function emptyDiffStats(): DiffStats {
	return { files: 0, inserted: 0, deleted: 0, untracked: 0, paths: [], byPath: {} };
}

function addFileStat(stats: DiffStats, filePath: string, inserted: number, deleted: number, untracked = false): void {
	const current = stats.byPath[filePath] ?? { inserted: 0, deleted: 0, untracked: false };
	if (!stats.byPath[filePath]) {
		stats.files++;
		stats.paths.push(filePath);
	}
	stats.inserted += inserted;
	stats.deleted += deleted;
	if (untracked && !current.untracked) stats.untracked++;
	current.inserted += inserted;
	current.deleted += deleted;
	current.untracked ||= untracked;
	stats.byPath[filePath] = current;
}

function addNumstat(stats: DiffStats, stdout: string, untracked = false, fallbackPath?: string): void {
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [insertedText, deletedText, ...pathParts] = line.split("\t");
		const filePath = pathParts.join("\t").trim() || fallbackPath;
		if (!filePath) continue;
		addFileStat(stats, filePath, Number.parseInt(insertedText ?? "0", 10) || 0, Number.parseInt(deletedText ?? "0", 10) || 0, untracked);
	}
}

async function untrackedFileNumstat(pi: ExtensionAPI, cwd: string, filePath: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["diff", "--numstat", "--no-index", "--", "/dev/null", filePath], { cwd, timeout: 5_000 });
		return result.stdout;
	} catch {
		return "";
	}
}

export async function gitChangeSnapshot(pi: ExtensionAPI, cwd: string): Promise<GitChangeSnapshot | undefined> {
	try {
		const diff = await pi.exec("git", ["diff", "--numstat", "HEAD", "--"], { cwd, timeout: 5_000 });
		if (diff.code !== 0) return undefined;
		const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 });

		const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd, timeout: 5_000 });
		const untrackedFiles = untracked.code === 0 ? untracked.stdout.split(/\r?\n/).filter(Boolean) : [];
		const stats = emptyDiffStats();
		addNumstat(stats, diff.stdout);

		const untrackedNumstats: string[] = [];
		for (const filePath of untrackedFiles.slice(0, 20)) {
			const numstat = await untrackedFileNumstat(pi, cwd, filePath);
			untrackedNumstats.push(numstat || `0\t0\t${filePath}`);
			if (numstat.trim()) addNumstat(stats, numstat, true, filePath);
			else addFileStat(stats, filePath, 0, 0, true);
		}

		const headText = head.code === 0 ? head.stdout.trim() : undefined;
		return { stats, signature: [headText ?? "", diff.stdout, untrackedFiles.join("\n"), untrackedNumstats.join("\n")].join("\0"), head: headText };
	} catch {
		return undefined;
	}
}

export async function committedDiffStats(pi: ExtensionAPI, cwd: string, fromHead: string | undefined, toHead: string | undefined): Promise<DiffStats | undefined> {
	if (!fromHead || !toHead || fromHead === toHead) return undefined;
	try {
		const diff = await pi.exec("git", ["diff", "--numstat", `${fromHead}..${toHead}`, "--"], { cwd, timeout: 5_000 });
		if (diff.code !== 0) return undefined;
		const stats = emptyDiffStats();
		addNumstat(stats, diff.stdout);
		return stats;
	} catch {
		return undefined;
	}
}

export function combineDiffStats(...items: Array<DiffStats | undefined>): DiffStats {
	const combined = emptyDiffStats();
	for (const stats of items) {
		if (!stats) continue;
		for (const [filePath, stat] of Object.entries(stats.byPath)) {
			addFileStat(combined, filePath, stat.inserted, stat.deleted, stat.untracked);
		}
	}
	return combined;
}

export function diffDelta(before: DiffStats | undefined, after: DiffStats): DiffStats {
	if (!before) return after;
	const delta = emptyDiffStats();
	for (const [filePath, current] of Object.entries(after.byPath)) {
		const previous = before.byPath[filePath];
		const inserted = Math.max(0, current.inserted - (previous?.inserted ?? 0));
		const deleted = Math.max(0, current.deleted - (previous?.deleted ?? 0));
		const untracked = current.untracked && !previous?.untracked;
		if (inserted > 0 || deleted > 0 || untracked) addFileStat(delta, filePath, inserted, deleted, untracked);
	}
	return delta;
}

export function diffLooksMajor(stats: DiffStats | undefined): boolean {
	if (!stats) return false;
	const changedLines = stats.inserted + stats.deleted;
	const structuralPathTouched = stats.paths.some((filePath) => /(?:^|\/)(extensions|packages|scripts|src|lib|app|core)\//.test(filePath));
	return (
		(stats.files >= MAJOR_CLEANUP_FILE_THRESHOLD && changedLines >= MAJOR_CLEANUP_FILE_LINE_FLOOR) ||
		changedLines >= MAJOR_CLEANUP_LINE_THRESHOLD ||
		(structuralPathTouched && changedLines >= 80)
	);
}

function formatDiffStats(stats: DiffStats | undefined): string {
	if (!stats) return "git diff stats unavailable";
	const untracked = stats.untracked ? `, ${stats.untracked} untracked` : "";
	return `${stats.files} file(s), +${stats.inserted}/-${stats.deleted}${untracked}`;
}

export function looksFileMutatingCommand(command: string): boolean {
	return /(^|[;&|()\s])(?:rm|mv|cp|touch|mkdir|rmdir|tee|python|python3|node|npm|pnpm|yarn|make|git\s+(?:add|commit|reset|checkout|switch|merge|rebase|stash|clean))\b/.test(command)
		|| /(^|[^<])>{1,2}\s*[^&]/.test(command)
		|| /\b(?:sed|perl)\s+[^\n]*\s-i\b/.test(command);
}

export function cleanupGuardMessage(stats: DiffStats | undefined, promptWasMajor: boolean): string {
	const reason = promptWasMajor ? "major-change prompt" : `large/structural diff (${formatDiffStats(stats)})`;
	return [
		`${CLEANUP_GUARD_MARKER}: Major code/file change detected (${reason}).`,
		"Before finalizing, run a cleanup/simplify pass:",
		"- inspect the current git diff and touched files",
		"- remove code, docs, comments, config, helpers, imports, and compatibility shims made obsolete by this change",
		"- scan affected subsystems and obvious repo-wide references for stale names or versions, including old model IDs like `gpt-5.2`/`gpt5.2` when relevant",
		"- simplify only where behavior is preserved; do not broaden into unrelated rewrites",
		"- run the relevant verification again, then commit/push or report the blocker",
	].join("\n");
}
