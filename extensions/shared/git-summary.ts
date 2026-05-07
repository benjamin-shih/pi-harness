import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type GitOutputOptions = {
	timeoutMs?: number;
	preserveLeading?: boolean;
};

type TrackedPorcelainCounts = {
	staged: number;
	unstaged: number;
};

export async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[], options: GitOutputOptions = {}): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", args, { cwd, timeout: options.timeoutMs ?? 2_000 });
		if (result.code !== 0) return undefined;
		return options.preserveLeading ? result.stdout.replace(/\s+$/g, "") : result.stdout.trim();
	} catch {
		return undefined;
	}
}

export function countTrackedPorcelain(status: string): TrackedPorcelainCounts {
	let staged = 0;
	let unstaged = 0;
	for (const line of status.split(/\r?\n/)) {
		if (line[0] && line[0] !== " ") staged++;
		if (line[1] && line[1] !== " ") unstaged++;
	}
	return { staged, unstaged };
}
