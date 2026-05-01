import { join } from "node:path";
import { assert, loadExtensionModule, root } from "./harness.mjs";

function textFromCodes(...codes) {
	return String.fromCharCode(...codes);
}

export async function runSessionContinuityBehaviorTests() {
	const continuity = loadExtensionModule("extensions/session-continuity/index.ts");
	assert(typeof continuity.redactSensitiveText === "function", "session-continuity should export redactSensitiveText");
	assert(typeof continuity.extractContinuityCheckpoints === "function", "session-continuity should export extractContinuityCheckpoints");
	assert(typeof continuity.buildLedger === "function", "session-continuity should export buildLedger");
	assert(typeof continuity.buildContinuitySummaryPrompt === "function", "session-continuity should export buildContinuitySummaryPrompt");
	assert(typeof continuity.buildDeterministicContinuitySummary === "function", "session-continuity should export buildDeterministicContinuitySummary");
	assert(typeof continuity.buildMemorySpineDiagnostics === "function", "session-continuity should export buildMemorySpineDiagnostics");
	assert(typeof continuity.formatMemorySpineDiagnostics === "function", "session-continuity should export formatMemorySpineDiagnostics");
	assert(typeof continuity.createSessionContinuity === "function", "session-continuity should export createSessionContinuity for behavior tests");
	assert(typeof continuity.formatUnknownError === "function", "session-continuity should export formatUnknownError for diagnostic regression coverage");
	const fakeToken = textFromCodes(84, 79, 75, 69, 78, 61, 97, 98, 99, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102);
	assert(
		continuity.redactSensitiveText(fakeToken) === "TOKEN=[REDACTED]",
		"session-continuity should redact credential-looking command text",
	);
	assert(
		continuity.formatUnknownError({ detail: "Instructions are required" }) === '{"detail":"Instructions are required"}',
		"session-continuity should preserve structured object errors in compaction diagnostics",
	);

	const factory = continuity.default ?? continuity;
	const handlers = new Map();
	const appended = [];
	let registeredCommands = 0;
	let registeredShortcuts = 0;
	factory({
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: (customType, data) => appended.push({ customType, data }),
		getThinkingLevel: () => "xhigh",
		registerCommand: () => registeredCommands++,
		registerShortcut: () => registeredShortcuts++,
	});
	assert(registeredCommands === 0 && registeredShortcuts === 0, "session-continuity should not depend on commands or shortcuts");
	for (const event of ["session_start", "before_agent_start", "tool_result", "agent_end", "session_shutdown", "session_before_compact", "session_compact"]) {
		assert(typeof handlers.get(event) === "function", `session-continuity should register ${event}`);
	}

	const ctx = {
		cwd: root,
		hasUI: true,
		ui: { theme: { fg: (_color, text) => text }, setStatus: () => {}, notify: () => {} },
		sessionManager: { getBranch: () => [], getSessionFile: () => join(root, ".test-session.jsonl") },
		model: { provider: "test", id: "model", contextWindow: 272000, maxTokens: 32768 },
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
	};
	await handlers.get("session_start")(
		{ reason: "startup" },
		{ ...ctx, ui: { setStatus: () => {}, notify: () => {} } },
	);
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await handlers.get("before_agent_start")({ prompt: "Implement robust automatic memory spine for the harness." }, ctx);
	await handlers.get("tool_result")({ toolName: "edit", input: { path: "extensions/session-continuity/index.ts" }, isError: false }, ctx);
	await handlers.get("tool_result")({ toolName: "bash", input: { command: `echo ${fakeToken}` }, isError: false }, ctx);
	await handlers.get("agent_end")({}, ctx);

	assert(appended.length === 1, "session-continuity should append one hidden checkpoint after a meaningful turn");
	assert(appended[0].customType === "ben-continuity-checkpoint", "session-continuity should use the checkpoint custom entry type");
	assert(appended[0].data.filesModified.includes("extensions/session-continuity/index.ts"), "session-continuity should track modified files");
	assert(appended[0].data.commands[0].command.includes("[REDACTED]"), "session-continuity should redact checkpoint commands");

	const entries = [{ type: "custom", customType: appended[0].customType, data: appended[0].data }];
	const checkpoints = continuity.extractContinuityCheckpoints(entries);
	const ledger = continuity.buildLedger(checkpoints);
	const prompt = continuity.buildContinuitySummaryPrompt({
		conversationText: `[Tool result]: ${fakeToken}`,
		previousSummary: fakeToken,
		customInstructions: fakeToken,
		ledger,
	});
	for (const section of [
		"## Goal",
		"## Current State",
		"## Constraints / Preferences",
		"## Decisions Made",
		"## Files Read",
		"## Files Modified",
		"## Commands / Verification",
		"## Active Skills / Routing",
		"## Subagents / Intercom State",
		"## Blockers / Open Questions",
		"## Next Exact Actions",
		"## Critical Continuation Notes",
	]) {
		assert(prompt.includes(section), `session-continuity prompt should include ${section}`);
	}
	assert(!prompt.includes(fakeToken.slice(6)), "session-continuity prompt should not contain unredacted token text");

	const hugeToolResult = `[User]: summarize\n[Tool result]: ${"x".repeat(500_000)}\n[Assistant thinking]: ${"y".repeat(500_000)}\n[Assistant]: done`;
	const boundedPrompt = continuity.buildContinuitySummaryPrompt({ conversationText: hugeToolResult, ledger });
	assert(boundedPrompt.length <= 120_000, "session-continuity compaction prompt should be hard capped");
	assert(boundedPrompt.includes("[Tool result]: [omitted by memory spine budget"), "session-continuity should omit bulky tool result bodies");
	assert(boundedPrompt.includes("[Assistant thinking]: [omitted by memory spine budget"), "session-continuity should omit bulky thinking bodies");

	const compactFallback = await handlers.get("session_before_compact")(
		{
			preparation: {
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				previousSummary: undefined,
				fileOps: { readFiles: [], modifiedFiles: [] },
				firstKeptEntryId: "entry-1",
				tokensBefore: 100,
			},
			branchEntries: entries,
			signal: new AbortController().signal,
		},
		{ ...ctx, model: undefined },
	);
	assert(compactFallback?.compaction?.details?.fallbackReason === "no_model", "session-continuity should return deterministic fallback without a model");
	assert(appended.some((entry) => entry.customType === "ben-continuity-compaction-diagnostic" && entry.data.reason === "no_model"), "session-continuity should persist no_model fallback diagnostics");
	const memoryDiagnostics = continuity.buildMemorySpineDiagnostics(appended.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })));
	assert(memoryDiagnostics.health === "warning", "session-continuity memory diagnostics should warn on latest fallback diagnostics");
	assert(memoryDiagnostics.checkpointCount === 1 && memoryDiagnostics.diagnosticCount === 1, "session-continuity memory diagnostics should count checkpoints and diagnostics");
	assert(continuity.formatMemorySpineDiagnostics(memoryDiagnostics, { verbose: true }).includes("latest diagnostic"), "session-continuity memory diagnostics should render latest diagnostic details");

	const fakePreparation = {
		messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Continue the harness work." }], timestamp: Date.now() }],
		turnPrefixMessages: [{ role: "assistant", content: [{ type: "text", text: "Earlier split-turn prefix." }], timestamp: Date.now() }],
		isSplitTurn: true,
		previousSummary: "Previous summary.",
		fileOps: { readFiles: ["README.md"], modifiedFiles: ["extensions/session-continuity/index.ts"] },
		firstKeptEntryId: "entry-2",
		tokensBefore: 123456,
	};
	const successHandlers = new Map();
	const successAppended = [];
	let successCompleteContext;
	const successFactory = continuity.createSessionContinuity({
		completeFn: async (_model, context) => {
			successCompleteContext = context;
			return { stopReason: "stop", content: [{ type: "text", text: "## Goal\n- Continue safely." }] };
		},
	});
	successFactory({
		on: (event, handler) => successHandlers.set(event, handler),
		appendEntry: (customType, data) => successAppended.push({ customType, data }),
		getThinkingLevel: () => "xhigh",
	});
	const successResult = await successHandlers.get("session_before_compact")(
		{ preparation: fakePreparation, branchEntries: entries, customInstructions: "Keep it concise.", signal: new AbortController().signal },
		{
			...ctx,
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { test: "1" } }) },
		},
	);
	assert(successCompleteContext?.systemPrompt?.includes("continuity summarizer"), "session-continuity custom compaction should send provider system instructions");
	assert(successResult?.compaction?.details?.source === "ben-pi-harness/session-continuity", "session-continuity successful compaction should identify harness source");
	assert(successResult.compaction.details.promptSizing.messagesToSummarize === 1, "session-continuity successful compaction should persist prompt sizing");
	assert(successResult.compaction.details.promptSizing.promptBudgetChars === 120_000, "session-continuity should cap large-model prompt budget at the harness maximum");
	assert(!("fallbackReason" in successResult.compaction.details), "session-continuity successful compaction should not mark fallbackReason");

	const smallModelResult = await successHandlers.get("session_before_compact")(
		{ preparation: fakePreparation, branchEntries: entries, signal: new AbortController().signal },
		{
			...ctx,
			model: { provider: "test", id: "small", contextWindow: 8192, maxTokens: 2048 },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
		},
	);
	assert(smallModelResult.compaction.details.promptSizing.promptBudgetChars < 120_000, "session-continuity should shrink prompt budget for smaller context windows");
	assert(smallModelResult.compaction.details.promptSizing.maxSummaryTokens <= 2048, "session-continuity should shrink max summary tokens for smaller models");

	const duplicateHandlers = new Map();
	const duplicateAppended = [];
	continuity.createSessionContinuity({ completeFn: async () => ({ stopReason: "stop", content: [{ type: "text", text: "## Goal\n- Continue." }] }) })({
		on: (event, handler) => duplicateHandlers.set(event, handler),
		appendEntry: (customType, data) => duplicateAppended.push({ customType, data }),
		getThinkingLevel: () => "xhigh",
	});
	await duplicateHandlers.get("session_start")({ reason: "startup" }, ctx);
	await duplicateHandlers.get("before_agent_start")({ prompt: "Implement memory spine duplicate checkpoint prevention." }, ctx);
	await duplicateHandlers.get("tool_result")({ toolName: "edit", input: { path: "extensions/session-continuity/index.ts" }, isError: false }, ctx);
	await duplicateHandlers.get("session_before_compact")(
		{ preparation: fakePreparation, branchEntries: entries, signal: new AbortController().signal },
		{
			...ctx,
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
		},
	);
	await duplicateHandlers.get("agent_end")({}, ctx);
	const duplicateCheckpoints = duplicateAppended.filter((entry) => entry.customType === "ben-continuity-checkpoint");
	assert(duplicateCheckpoints.length === 1 && duplicateCheckpoints[0].data.reason === "compact", "session-continuity should not duplicate compact checkpoint activity at agent_end");

	const failureHandlers = new Map();
	const failureAppended = [];
	const failureFactory = continuity.createSessionContinuity({ completeFn: async () => { throw new Error("context_length_exceeded"); } });
	failureFactory({
		on: (event, handler) => failureHandlers.set(event, handler),
		appendEntry: (customType, data) => failureAppended.push({ customType, data }),
		getThinkingLevel: () => "xhigh",
	});
	const failureResult = await failureHandlers.get("session_before_compact")(
		{ preparation: fakePreparation, branchEntries: entries, signal: new AbortController().signal },
		{
			...ctx,
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
		},
	);
	assert(failureResult?.compaction?.details?.fallbackReason === "exception", "session-continuity should return deterministic fallback on model exceptions");
	assert(failureAppended.some((entry) => entry.customType === "ben-continuity-compaction-diagnostic" && entry.data.reason === "exception"), "session-continuity should persist exception diagnostics");

	const objectFailureHandlers = new Map();
	continuity.createSessionContinuity({ completeFn: async () => { throw { detail: "Instructions are required" }; } })({
		on: (event, handler) => objectFailureHandlers.set(event, handler),
		appendEntry: () => {},
		getThinkingLevel: () => "xhigh",
	});
	const objectFailureResult = await objectFailureHandlers.get("session_before_compact")(
		{ preparation: fakePreparation, branchEntries: entries, signal: new AbortController().signal },
		{
			...ctx,
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
		},
	);
	assert(objectFailureResult.compaction.details.error.includes("Instructions are required"), "session-continuity should persist structured compaction exception details");

	const stopReasonHandlers = new Map();
	continuity.createSessionContinuity({
		completeFn: async () => ({ stopReason: "error", errorMessage: "context_length_exceeded", content: [{ type: "text", text: "not a summary" }] }),
	})({
		on: (event, handler) => stopReasonHandlers.set(event, handler),
		appendEntry: () => {},
		getThinkingLevel: () => "xhigh",
	});
	const stopReasonResult = await stopReasonHandlers.get("session_before_compact")(
		{ preparation: fakePreparation, branchEntries: entries, signal: new AbortController().signal },
		{
			...ctx,
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
		},
	);
	assert(stopReasonResult?.compaction?.details?.fallbackReason === "exception", "session-continuity should fallback on model stopReason=error");
	assert(stopReasonResult.compaction.details.error.includes("context_length_exceeded"), "session-continuity should persist stopReason error messages");

	await failureHandlers.get("session_compact")(
		{ fromExtension: false, compactionEntry: { id: "cmp-1", type: "compaction", summary: "default", firstKeptEntryId: "entry-2", tokensBefore: 123456 } },
		ctx,
	);
	assert(failureAppended.some((entry) => entry.customType === "ben-continuity-compaction-diagnostic" && entry.data.reason === "default_compaction"), "session-continuity should persist diagnostics when pi default compaction happens");
}
