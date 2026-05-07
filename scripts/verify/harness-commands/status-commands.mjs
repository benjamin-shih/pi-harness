import { assert, harnessCommands, piPackagePolicyPayload, root } from "./support.mjs";

export async function runStatusCommandTests() {
	const statusCommands = new Map();
	const statusMessages = [];
	const execCalls = [];
	let statusPorcelain = "";
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
			if (key === "status --porcelain=v1 --untracked-files=no") return { code: 0, stdout: statusPorcelain, stderr: "" };
			if (String(args[0] || "").endsWith("memory-stats.sh")) return { code: 0, stdout: JSON.stringify(memoryStatsPayload), stderr: "" };
			if (String(args[0] || "").endsWith("pi-package-doctor.sh")) return { code: 0, stdout: JSON.stringify(piPackagePolicyPayload()), stderr: "" };
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
	assert(statusMessages[0].content.includes("╭─ Harness"), "/status should render a visual harness block");
	assert(statusMessages[0].content.includes("╭─ Task"), "/status should render a visual task block");
	assert(statusMessages[0].content.includes("╭─ Ambient"), "/status should render a visual ambient block");
	assert(statusMessages[0].content.includes("╭─ Memory"), "/status should render a visual memory block");
	assert(statusMessages[0].content.includes("╭─ Repo"), "/status should render a visual repo block");
	assert(statusMessages[0].content.includes("not bound this session yet"), "/status should distinguish uninitialized task binding from an absent task");
	assert(statusMessages[0].content.includes("run a nontrivial turn"), "/status should hint how task binding becomes available");
	assert(statusMessages[0].content.includes("not assembled this session yet"), "/status should distinguish uninitialized ambient context");
	assert(statusMessages[0].content.includes("appears after the next agent turn"), "/status should hint how ambient context becomes available");
	assert(!statusMessages[0].content.includes("harness audit:"), "/status should avoid the heavier harness audit subprocess");
	assert(statusMessages[0].content.includes("tracked clean (untracked not scanned)"), "/status should avoid scanning untracked filenames");
	assert(!execCalls.some((call) => String(call.args?.[0] || "").endsWith("harness-audit.mjs")), "/status should not run harness-audit.mjs");
	assert(execCalls.some((call) => call.args.join(" ") === "status --porcelain=v1 --untracked-files=no"), "/status should request git status without untracked filenames");
	assert(!execCalls.some((call) => call.args.join(" ") === "status --porcelain=v1 --untracked-files=all"), "/status should not request untracked filename scans");
	assert(statusMessages[0].content.includes("spine    warning"), "/status should include compact memory-spine health");
	assert(statusMessages[0].content.includes("review   2 candidates pending"), "/status should surface pending memory candidate review availability");
	assert(statusMessages[0].content.includes("write    durable explicit-only"), "/status should distinguish durable memory writes from automatic task operational writes");
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
	assert(statusMessages[1].content.includes("## Pi package approvals"), "/doctor should include local Pi package approval diagnostics");
	assert(statusMessages[1].content.includes("package policy: ok"), "/doctor should report Pi package policy health without checking upstream");
	assert(statusMessages[1].content.includes("4 approved, 0 unapproved, 0 unpinned"), "/doctor should summarize configured Pi package approval counts");
	assert(statusMessages[1].content.includes("installed attestation: 2 verified, 0 mismatch, 0 missing, 2 skipped; cache 2 hit, 0 miss, 0 disabled"), "/doctor should summarize installed-byte attestation cache state without listing file manifests");
	assert(statusMessages[1].content.includes("upstream checks: disabled in harness"), "/doctor should not encourage runtime package update checks");
	assert(execCalls.some((call) => String(call.args?.[0] || "").endsWith("pi-package-doctor.sh")), "/doctor should call the shared read-only Pi package policy script");
	assert(!execCalls.some((call) => String(call.args?.[0] || "").endsWith("pi-package-check-upstream.sh")), "/doctor should not run networked upstream package checks");
	assert(statusMessages[1].content.includes("task artifacts: metadata-only and policy-filtered"), "/doctor should describe artifact metadata write semantics");
	assert(statusMessages[1].content.includes("Ask to review memory candidates when ready"), "/doctor should recommend explicit candidate review when candidates are pending");
	await statusCommands.get("doct").handler("", commandCtx);
	assert(statusMessages[2].customType === "harness-doctor", "/doct should use the same doctor output path");
	assert(statusMessages[2].content.includes("## Harness doctor"), "/doct should render a doctor report");
	await statusCommands.get("memory").handler("", commandCtx);
	assert(statusMessages[3].customType === "harness-memory", "/memory should send a memory diagnostics message");
	assert(statusMessages[3].content.includes("latest diagnostic error: context_length_exceeded"), "/memory should include latest diagnostic errors");
	assert(!execCalls.some((call) => String(call.args?.[0] || "").endsWith("memory-review.sh")), "status/doctor should not auto-run memory-review.sh");
	statusPorcelain = " M README.md\n";
	await statusCommands.get("status").handler("", commandCtx);
	assert(statusMessages.at(-1).content.includes("0 staged, 1 unstaged tracked"), "/status should preserve git porcelain columns when counting unstaged-only tracked changes");
}
