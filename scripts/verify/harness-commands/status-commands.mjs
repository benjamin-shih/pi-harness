import { assert, harnessCommands, root } from "./support.mjs";

export async function runStatusCommandTests() {
	const statusCommands = new Map();
	const statusMessages = [];
	const execCalls = [];
	const memoryStatsPayload = {
		memory_api_version: 1,
		counts_by_state: { candidate: 2, approved: 1, deprecated: 0 },
		skipped: 0,
	};
	const promptSizing = {
		promptChars: 1000,
		conversationChars: 2000,
		turnPrefixChars: 0,
		previousSummaryChars: 0,
		customInstructionsChars: 0,
		gitStatusChars: 0,
		messagesToSummarize: 2,
		turnPrefixMessages: 0,
		tokensBefore: 1234,
		promptBudgetChars: 120000,
		maxSummaryTokens: 8192,
		isSplitTurn: false,
		firstKeptEntryId: "entry-1",
	};
	const statusBranch = [
		{
			type: "custom",
			customType: "ben-continuity-checkpoint",
			data: {
				version: 1,
				reason: "agent_end",
				timestamp: "2026-04-30T00:00:00.000Z",
				cwd: root,
				prompt: "Add doctor and memory diagnostics.",
				filesRead: ["README.md"],
				filesModified: ["extensions/harness-commands.ts"],
				commands: [{ command: "npm run verify", status: "ok" }],
				toolErrors: [],
			},
		},
		{
			type: "compaction",
			timestamp: "2026-04-30T00:05:00.000Z",
			tokensBefore: 1234,
			firstKeptEntryId: "entry-1",
			details: { source: "ben-pi-harness/session-continuity", version: 1, promptSizing },
		},
		{
			type: "custom",
			customType: "ben-continuity-compaction-diagnostic",
			data: {
				version: 1,
				timestamp: "2026-04-30T00:10:00.000Z",
				reason: "exception",
				cwd: root,
				error: "context_length_exceeded",
				fallbackReturned: true,
				promptSizing,
			},
		},
	];
	harnessCommands({
		on: () => {},
		registerCommand: (name, command) => statusCommands.set(name, command),
		getAllTools: () => [],
		getActiveTools: () => ["read", "bash"],
		getThinkingLevel: () => "xhigh",
		exec: async (cmd, args) => {
			execCalls.push({ cmd, args });
			const key = args.join(" ");
			if (key === "rev-parse --show-toplevel") return { code: 0, stdout: `${root}\n`, stderr: "" };
			if (key === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "" };
			if (key === "status --porcelain=v1 --untracked-files=no") return { code: 0, stdout: "", stderr: "" };
			if (String(args[0] || "").endsWith("memory-stats.sh")) return { code: 0, stdout: JSON.stringify(memoryStatsPayload), stderr: "" };
			if (key === "scripts/harness-audit.mjs --json" || key.endsWith("scripts/harness-audit.mjs --json")) {
				return {
					code: 0,
					stdout: JSON.stringify({ root, packageVersion: "0.2.0", metrics: { runtimeExtensionEntrypoints: 4, extensionLoc: 2000, optionalLatexLoc: 1300 }, issues: [], warnings: [] }),
					stderr: "",
				};
			}
			return { code: 1, stdout: "", stderr: "" };
		},
		sendMessage: (message) => statusMessages.push(message),
	});
	const commandCtx = {
		cwd: root,
		model: { provider: "test", id: "model" },
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		sessionManager: { getBranch: () => statusBranch },
	};
	assert(typeof statusCommands.get("doctor")?.handler === "function", "harness should register /doctor");
	assert(typeof statusCommands.get("doct")?.handler === "function", "harness should register /doct alias");
	assert(typeof statusCommands.get("memory")?.handler === "function", "harness should register /memory");
	await statusCommands.get("status").handler("", commandCtx);
	assert(!statusMessages[0].content.includes("harness audit:"), "/status should avoid the heavier harness audit subprocess");
	assert(statusMessages[0].content.includes("tracked clean (untracked not scanned)"), "/status should avoid scanning untracked filenames");
	assert(!execCalls.some((call) => String(call.args?.[0] || "").endsWith("harness-audit.mjs")), "/status should not run harness-audit.mjs");
	assert(execCalls.some((call) => call.args.join(" ") === "status --porcelain=v1 --untracked-files=no"), "/status should request git status without untracked filenames");
	assert(!execCalls.some((call) => call.args.join(" ") === "status --porcelain=v1 --untracked-files=all"), "/status should not request untracked filename scans");
	assert(statusMessages[0].content.includes("memory spine: warning"), "/status should include compact memory-spine health");
	assert(statusMessages[0].content.includes("memory review: 2 candidates pending"), "/status should surface pending memory candidate review availability");
	assert(statusMessages[0].content.includes("write semantics: durable memory mutations explicit-only; task operational writes automatic when bound"), "/status should distinguish durable memory writes from automatic task operational writes");
	await statusCommands.get("doctor").handler("", commandCtx);
	assert(statusMessages[1].customType === "harness-doctor", "/doctor should send a harness doctor message");
	assert(statusMessages[1].content.includes("## Harness doctor"), "/doctor should render a doctor report");
	assert(statusMessages[1].content.includes("package: ben-pi-harness 0.2.0"), "/doctor should include package version");
	assert(statusMessages[1].content.includes("harness audit: ok"), "/doctor should include harness audit health");
	assert(statusMessages[1].content.includes("runtime extensions: 4"), "/doctor should include runtime extension count");
	assert(execCalls.some((call) => String(call.args?.[0] || "").endsWith("harness-audit.mjs")), "/doctor should run harness-audit.mjs");
	assert(statusMessages[1].content.includes("latest diagnostic"), "/doctor should include memory-spine diagnostics");
	assert(statusMessages[1].content.includes("memory review: 2 candidates pending"), "/doctor should surface pending memory candidate review availability");
	assert(statusMessages[1].content.includes("## Write semantics"), "/doctor should include write-semantics diagnostics");
	assert(statusMessages[1].content.includes("durable memory mutations: explicit user request only"), "/doctor should make durable memory mutation semantics explicit");
	assert(statusMessages[1].content.includes("task artifacts: metadata-only and policy-filtered"), "/doctor should describe artifact metadata write semantics");
	assert(statusMessages[1].content.includes("Ask to review memory candidates when ready"), "/doctor should recommend explicit candidate review when candidates are pending");
	await statusCommands.get("doct").handler("", commandCtx);
	assert(statusMessages[2].customType === "harness-doctor", "/doct should use the same doctor output path");
	assert(statusMessages[2].content.includes("## Harness doctor"), "/doct should render a doctor report");
	await statusCommands.get("memory").handler("", commandCtx);
	assert(statusMessages[3].customType === "harness-memory", "/memory should send a memory diagnostics message");
	assert(statusMessages[3].content.includes("latest diagnostic error: context_length_exceeded"), "/memory should include latest diagnostic errors");
	assert(!execCalls.some((call) => String(call.args?.[0] || "").endsWith("memory-review.sh")), "status/doctor should not auto-run memory-review.sh");
}
