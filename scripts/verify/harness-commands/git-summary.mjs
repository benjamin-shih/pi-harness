import { loadExtensionModule } from "../harness.mjs";
import { assert } from "./support.mjs";

export async function runGitSummaryTests() {
	const gitSummary = loadExtensionModule("extensions/shared/git-summary.ts");
	assert(typeof gitSummary.gitOutput === "function", "git summary module should export gitOutput");
	assert(typeof gitSummary.countTrackedPorcelain === "function", "git summary module should export tracked porcelain counter");

	const counts = gitSummary.countTrackedPorcelain([" M README.md", "M  package.json", "MM extensions/index.ts"].join("\n"));
	assert(counts.staged === 2 && counts.unstaged === 2, "tracked porcelain counter should preserve staged/unstaged counts");

	const calls = [];
	const result = await gitSummary.gitOutput({
		exec: async (cmd, args, options) => {
			calls.push({ cmd, args, options });
			return { code: 0, stdout: " M README.md\n\n", stderr: "" };
		},
	}, "/repo", ["status"], { preserveLeading: true, timeoutMs: 123 });
	assert(result === " M README.md", "gitOutput should optionally preserve leading porcelain columns while trimming trailing whitespace");
	assert(calls[0].cmd === "git" && calls[0].options.timeout === 123, "gitOutput should pass through git command and timeout");
}
