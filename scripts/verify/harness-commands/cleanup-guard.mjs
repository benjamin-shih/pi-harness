import { assert, createHarness, root } from "./support.mjs";

export async function runCleanupGuardTests() {
	const major = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "140\t90\textensions/harness-commands.ts\n30\t5\tscripts/verify.mjs\n", untracked: "" },
	]);
	const codingResult = await major.beforeAgentStart({ prompt: "Fix bug in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	assert(codingResult.systemPrompt.includes("## Post-Change Cleanup Gate"), "harness should inject cleanup guidance for coding prompts");
	assert(codingResult.systemPrompt.includes("remove code made obsolete"), "cleanup guidance should require obsolete-code removal");
	await major.toolCall({ toolName: "edit", input: { path: "src/foo.ts" } }, {});
	await major.agentEnd({}, { cwd: root });
	assert(major.sentUserMessages.length === 1, "harness should send a one-shot cleanup guard after major mutating diffs");
	assert(major.sentUserMessages[0].message.includes("PI_CLEANUP_GUARD"), "cleanup guard should be marked to prevent loops");
	assert(major.sentUserMessages[0].message.includes("gpt-5.2"), "cleanup guard should call out stale model/version identifiers");
	assert(major.sentUserMessages[0].options?.deliverAs === "followUp", "cleanup guard should be delivered as a follow-up turn");

	const continuation = createHarness([{ diff: "", untracked: "" }]);
	const continuationResult = await continuation.beforeAgentStart({ prompt: "Go ahead and do this", systemPrompt: "base" }, { cwd: root });
	assert(continuationResult.systemPrompt.includes("## Post-Change Cleanup Gate"), "harness should inject cleanup guidance for execution follow-up prompts");

	const unchanged = createHarness([
		{ diff: "200\t20\tsrc/existing.ts\n", untracked: "" },
		{ diff: "200\t20\tsrc/existing.ts\n", untracked: "" },
	]);
	await unchanged.beforeAgentStart({ prompt: "Fix bug in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	await unchanged.toolCall({ toolName: "bash", input: { command: "npm run verify" } }, {});
	await unchanged.agentEnd({}, { cwd: root });
	assert(unchanged.sentUserMessages.length === 0, "cleanup guard should not fire when a broad command leaves the git diff unchanged");

	const preExistingTiny = createHarness([
		{ diff: "200\t20\tsrc/existing.ts\n", untracked: "" },
		{ diff: "200\t20\tsrc/existing.ts\n1\t0\tsrc/tiny.ts\n", untracked: "" },
	]);
	await preExistingTiny.beforeAgentStart({ prompt: "Fix bug in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	await preExistingTiny.toolCall({ toolName: "edit", input: { path: "src/tiny.ts" } }, {});
	await preExistingTiny.agentEnd({}, { cwd: root });
	assert(preExistingTiny.sentUserMessages.length === 0, "cleanup guard should score only this-turn diff growth, not pre-existing large diffs");

	const fourTinyFiles = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "1\t0\tdocs/a.md\n1\t0\tdocs/b.md\n1\t0\tdocs/c.md\n1\t0\tdocs/d.md\n", untracked: "" },
	]);
	await fourTinyFiles.beforeAgentStart({ prompt: "Update docs and config files", systemPrompt: "base" }, { cwd: root });
	await fourTinyFiles.toolCall({ toolName: "edit", input: { path: "docs/a.md" } }, {});
	await fourTinyFiles.agentEnd({}, { cwd: root });
	assert(fourTinyFiles.sentUserMessages.length === 0, "cleanup guard should not treat four tiny file edits as major");

	const untracked = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "", untracked: "src/new.ts\n", untrackedNumstat: { "src/new.ts": "250\t0\tsrc/new.ts\n" } },
	]);
	await untracked.beforeAgentStart({ prompt: "Fix bug in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	await untracked.toolCall({ toolName: "write", input: { path: "src/new.ts" } }, {});
	await untracked.agentEnd({}, { cwd: root });
	assert(untracked.sentUserMessages.length === 1, "cleanup guard should account for large untracked source files");
	assert(untracked.sentUserMessages[0].message.includes("untracked"), "cleanup guard diff summary should mention untracked files");

	const smallUntracked = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "", untracked: "src/small.ts\n", untrackedNumstat: { "src/small.ts": "1\t0\tsrc/small.ts\n" } },
	]);
	await smallUntracked.beforeAgentStart({ prompt: "Fix bug in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	await smallUntracked.toolCall({ toolName: "write", input: { path: "src/small.ts" } }, {});
	await smallUntracked.agentEnd({}, { cwd: root });
	assert(smallUntracked.sentUserMessages.length === 0, "cleanup guard should not treat a tiny untracked source file as major");

	const replaceSmall = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "1\t0\tsrc/foo.ts\n", untracked: "" },
	]);
	await replaceSmall.beforeAgentStart({ prompt: "Replace the old helper in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	await replaceSmall.toolCall({ toolName: "edit", input: { path: "src/foo.ts" } }, {});
	await replaceSmall.agentEnd({}, { cwd: root });
	assert(replaceSmall.sentUserMessages.length === 0, "cleanup guard should not treat every small replace/cleanup prompt as major");

	const complexSmall = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "1\t0\tsrc/foo.ts\n", untracked: "" },
	]);
	const longScopedPrompt = `Update src/foo.ts. ${"Keep this scoped and preserve behavior. ".repeat(30)}`;
	await complexSmall.beforeAgentStart({ prompt: longScopedPrompt, systemPrompt: "base" }, { cwd: root });
	await complexSmall.toolCall({ toolName: "edit", input: { path: "src/foo.ts" } }, {});
	await complexSmall.agentEnd({}, { cwd: root });
	assert(complexSmall.sentUserMessages.length === 0, "cleanup guard should not treat every complex prompt with a tiny diff as major");

	const loop = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "140\t90\textensions/harness-commands.ts\n", untracked: "" },
	]);
	await loop.beforeAgentStart({ prompt: "PI_CLEANUP_GUARD: run cleanup for this code change", systemPrompt: "base" }, { cwd: root });
	await loop.toolCall({ toolName: "edit", input: { path: "src/foo.ts" } }, {});
	await loop.agentEnd({}, { cwd: root });
	assert(loop.sentUserMessages.length === 0, "cleanup guard should not recursively trigger itself");
}
