import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Box } from "@earendil-works/pi-tui";
import { loadExtensionModule } from "../harness.mjs";
import { agentsRoot, assert, controlPlaneDecisionPayload, createTaskHarness, harnessCommands, homeRoot, join, memoryReviewPayload, root, taskBindPayload, taskDiscoverPayload, withEnv } from "./support.mjs";

function renderToolBox(theme, isError, width, ...components) {
	const box = new Box(1, 1, (text) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", text));
	for (const component of components) box.addChild(component);
	return box.render(width);
}

function assertFullBackground(lines, color, width, message) {
	const prefix = `[${color}]`;
	assert(lines.length > 0, `${message}: expected rendered lines`);
	for (const line of lines) {
		assert(line.startsWith(prefix), `${message}: line should start with ${color}`);
		assert(!line.slice(prefix.length).includes(prefix), `${message}: line should not contain nested ${color} spans`);
		assert(line.slice(prefix.length).length === width, `${message}: line should be padded to terminal width`);
	}
}

export async function runAmbientContextTests() {
	const ambient = loadExtensionModule("extensions/shared/ambient-context.ts");
	const ambientPolicy = loadExtensionModule("extensions/shared/ambient-policy.ts");
	const ambientRegistry = loadExtensionModule("extensions/harness-commands/ambient-lane-registry.ts");
	const repoContext = loadExtensionModule("extensions/shared/repo-context.ts");
	const memoryContext = loadExtensionModule("extensions/shared/memory-context.ts");
	const largeHtml = loadExtensionModule("extensions/shared/large-response-html.ts");
	const promptGuidance = loadExtensionModule("extensions/shared/prompt-guidance.ts");
	assert(typeof ambient.assembleAmbientContext === "function", "ambient context module should export assembler");
	assert(ambientRegistry.AMBIENT_LANE_REGISTRY.map((lane) => `${lane.id}:${lane.priority}`).join(",") === "display_math:10,markdown_heading:20,mode:30,skill_routing:40,qmd_retrieval:45,cleanup:50,git_push:52,subagent_topology:55,large_response_html:58,agents_task:60,orchestration:62,memory:65,memory_candidates:66,memory_admin:67,execution:68,repo:70", "ambient lane registry should preserve lane ids and priorities");
	assert(ambientPolicy.decideAmbientPolicy("trivial").receipt === "off", "ambient policy should suppress receipts for trivial prompts");
	assert(ambientPolicy.decideAmbientPolicy("standard").personalContext === "auto_scoped", "ambient policy should auto-consider scoped approved memory for nontrivial prompts");
	assert(ambientPolicy.shouldIncludeRepoContext(ambientPolicy.decideAmbientPolicy("standard")), "ambient policy should include repo context for nontrivial prompts");

	const dirtyRepo = await repoContext.buildRepoContextSummary({ exec: async (_cmd, args) => {
		if (args.join(" ") === "rev-parse --show-toplevel") return { code: 0, stdout: `${root}\n`, stderr: "" };
		if (args.join(" ") === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "" };
		if (args.join(" ") === "status --porcelain=v1 --untracked-files=no") return { code: 0, stdout: " M README.md\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	} }, root);
	assert(dirtyRepo.status === "dirty" && dirtyRepo.summary === "0 staged, 1 unstaged, untracked not scanned", "repo context should summarize tracked porcelain status without scanning untracked names");
	assert(repoContext.formatRepoContext(dirtyRepo).includes("## Repo Context"), "repo context should render bounded metadata");
	assert(memoryContext.memoryAdminGuidance("Remember this project preference: use scoped candidates by default")?.includes("candidate by default"), "remember prompts should get memory admin guidance");
	assert(memoryContext.memoryAdminGuidance("Remember: I prefer concise answers")?.includes("candidate by default"), "remember-colon preference prompts should get memory admin guidance");
	assert(memoryContext.memoryAdminGuidance("Remember I prefer scoped candidates")?.includes("candidate by default"), "remember preference prompts should get memory admin guidance");
	assert(memoryContext.memoryAdminGuidance("Remember I prefer running tests before final")?.includes("candidate by default"), "first-person remember preference prompts should override code-word suppression");
	assert(memoryContext.memoryAdminGuidance("Remember I use pnpm")?.includes("candidate by default"), "non-code remember-use prompts should get memory admin guidance");
	assert(memoryContext.memoryAdminGuidance("Remember this project preference: always run tests before final")?.includes("candidate by default"), "durable project preference prompts should override code-word suppression");
	assert(memoryContext.memoryAdminGuidance("Remember this repo convention: put helpers in shared files")?.includes("candidate by default"), "durable repo convention prompts should override code-word suppression");
	assert(memoryContext.memoryAdminGuidance("Remember: use pnpm")?.includes("candidate by default"), "remember-colon prompts should get memory admin guidance");
	assert(memoryContext.memoryAdminGuidance("Please remember my name is Ben")?.includes("candidate by default"), "remember-my prompts should get memory admin guidance");
	assert(memoryContext.memoryAdminGuidance("Could you remember this project preference: use pnpm by default")?.includes("candidate by default"), "polite remember prompts should get memory admin guidance");
	assert(memoryContext.memoryAdminGuidance("Do not record this in docs. Remember: I prefer pnpm")?.includes("candidate by default"), "negation in an earlier sentence should not suppress a later explicit remember request");
	assert(memoryContext.memoryAdminGuidance("Do not record this in docs, but remember: I prefer pnpm")?.includes("candidate by default"), "comma-but negation should not suppress a later explicit remember request");
	const listGuidance = memoryContext.memoryAdminGuidance("Please list memory records for this project");
	assert(listGuidance?.includes("memory-list.sh"), "explicit list memory record prompts should get list guidance");
	assert(!/global|all-scope|--all/i.test(listGuidance), "runtime memory-admin guidance should avoid global/all-scope instructions");
	assert(memoryContext.memoryAdminGuidance("List memories for this project")?.includes("memory-list.sh"), "explicit project-scoped memories list prompts should get list guidance");
	assert(memoryContext.memoryAdminGuidance("List all memories for this project")?.includes("memory-list.sh"), "explicit all-worded project-scoped memories list prompts should get list guidance without all-scope instructions");
	assert(memoryContext.memoryAdminGuidance("List memories for this task")?.includes("memory-list.sh"), "explicit task-scoped memories list prompts should get list guidance");
	assert(memoryContext.memoryAdminGuidance("List all memories for this task")?.includes("memory-list.sh"), "explicit all-worded task-scoped memories list prompts should get list guidance without all-scope instructions");
	const reviewGuidance = memoryContext.memoryAdminGuidance("Review memory candidates for this project");
	assert(reviewGuidance?.includes("memory-review.sh"), "explicit memory candidate review prompts should get review guidance");
	assert(reviewGuidance.includes("read-only"), "memory candidate review guidance should be read-only");
	assert(reviewGuidance.includes("before any mutation"), "memory candidate review guidance should require explicit selection before mutation");
	assert(memoryContext.memoryAdminGuidance("Show pending memories")?.includes("memory-review.sh"), "pending-memory prompts should get review guidance");
	assert(!memoryContext.memoryAdminGuidance("Do not review memory candidates"), "negated review prompts should not get candidate review guidance");
	assert(!memoryContext.memoryAdminGuidance("Never audit pending memories"), "negated audit prompts should not get candidate review guidance");
	assert(!memoryContext.memoryAdminGuidance("Review memory-context.ts tests"), "code review prompts mentioning memory-context should not get candidate review guidance");
	assert(!memoryContext.memoryAdminGuidance("Final blocker-only review of current uncommitted diff. Scope: read-only memory candidate review guidance/discovery."), "code-review prompts about memory-review implementation should not get candidate review guidance");
	assert(!memoryContext.memoryAdminGuidance("Check explicit read-only memory candidate review only, .agents API ownership, no hidden review/writes/promotion."), "decision-review prompts mentioning memory candidate review should not get candidate review guidance");
	assert(memoryContext.memoryAdminGuidance("Promote memory candidate mem_example")?.includes("memory-promote.sh"), "explicit promote memory candidate prompts should get promote guidance");
	assert(memoryContext.memoryAdminGuidance("Promote memory mem_123")?.includes("memory-promote.sh"), "explicit promote memory id prompts should get promote guidance");
	assert(memoryContext.memoryAdminGuidance("Forget this memory")?.includes("memory-forget.sh"), "explicit forget-this-memory prompts should get forget guidance");
	assert(memoryContext.memoryAdminGuidance("Forget memory mem_123")?.includes("memory-forget.sh"), "explicit forget memory id prompts should get forget guidance");
	assert(!memoryContext.memoryAdminGuidance("Please save this diff summary in progress.md"), "ordinary save-file prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Record this decision in docs/adr.md"), "ordinary docs-record prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Do not remember this preference"), "negated remember prompts should not get add-memory guidance");
	assert(!memoryContext.memoryAdminGuidance("Do not save this as a memory record"), "negated save-memory prompts should not get add-memory guidance");
	assert(!memoryContext.memoryAdminGuidance("Don't promote memory candidate mem_123"), "negated promote prompts should not get promote guidance");
	assert(!memoryContext.memoryAdminGuidance("Never store this memory record"), "negated store-memory prompts should not get add-memory guidance");
	assert(!memoryContext.memoryAdminGuidance("I cannot remember this convention; inspect docs"), "non-admin remember statements should not get add-memory guidance");
	assert(!memoryContext.memoryAdminGuidance("Remove memory-context shim from the harness"), "code prompts mentioning memory-context should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Inspect memory-context.ts tests"), "code inspection prompts mentioning memory-context.ts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Remove project memory leak in the cache"), "memory-leak code prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Inspect project memory usage before optimizing"), "memory-usage code prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Show project memory profile"), "memory-profile diagnostics prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Inspect memory record serialization code"), "code inspection prompts around memory records should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Remember to update README"), "ordinary remember-to file prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Remember to fix the parser"), "ordinary remember-to coding prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Please remember to check git diff"), "ordinary remember-to process prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Remember I need to update memory-context.ts tests"), "transient need-to-code prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Remember we need to fix parser tests"), "transient need-to-test prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Remember we use parser tests"), "remember-use code prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Remember we use memory-context.ts tests"), "remember-use memory-context code prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Remember to update memory-context.ts tests"), "remember-to code prompts should not get memory admin guidance");
	assert(!memoryContext.memoryAdminGuidance("Remember to inspect memory record serialization code"), "remember-to code inspection prompts should not get memory admin guidance");
	assert(largeHtml.shouldUseLargeResponseHtmlGuidance("Write a comprehensive implementation status report with a table and next steps", "standard"), "large-response HTML guidance should trigger for lengthy structured reports");
	assert(!largeHtml.shouldUseLargeResponseHtmlGuidance("Answer in chat only: what is 2+2?", "standard"), "large-response HTML guidance should honor explicit inline/chat-only requests");
	assert(promptGuidance.qmdRetrievalGuidance("Search the skills and docs for token optimization guidance", "standard")?.includes("qmd search"), "markdown-heavy prompts should get qmd search-first retrieval guidance");
	assert(promptGuidance.qmdRetrievalGuidance("Search the .agents shared contracts for memory policy", "standard")?.includes("agents-contracts"), "contract prompts should point qmd at .agents shared contracts");
	assert(promptGuidance.qmdRetrievalGuidance("Find the HTML artifact template guidance", "standard")?.includes("agents-templates"), "template prompts should point qmd at .agents template docs");
	assert(!promptGuidance.qmdRetrievalGuidance("Ship the CI release workflow end-to-end", "complex"), "non-Markdown complex prompts should not get qmd retrieval guidance");
	assert(!promptGuidance.qmdRetrievalGuidance("Summarize the CI failure and next action", "complex"), "generic summarize prompts should not get qmd retrieval guidance without a Markdown retrieval term");
	assert(!promptGuidance.qmdRetrievalGuidance("What is 2+2?", "trivial"), "trivial prompts should not get qmd retrieval guidance");

	await withEnv({ BEN_PI_COMPACT_TOOL_OUTPUT: "0" }, async () => {
		const defaultToolDisplay = createTaskHarness({});
		assert(defaultToolDisplay.tools.size === 0, "compact tool output should be disabled when the setting/env is off");
	});
	const orchestratorHarness = createTaskHarness({});
	assert(orchestratorHarness.commands.has("orchestrator"), "harness should register /orchestrator session tagging command");
	await orchestratorHarness.commands.get("orchestrator").handler("kalshi", orchestratorHarness.ctx);
	assert(orchestratorHarness.getSessionName() === "[ORCHESTRATOR] kalshi", "/orchestrator should tag the session name for pi -r selectors");
	assert(orchestratorHarness.notifications.some((item) => item.message.includes("[ORCHESTRATOR] kalshi")), "/orchestrator should notify the user-visible tag");
	await orchestratorHarness.commands.get("orchestrator").handler("off", orchestratorHarness.ctx);
	assert(orchestratorHarness.getSessionName() === "kalshi", "/orchestrator off should clear only the orchestrator prefix");

	await withEnv({ BEN_PI_COMPACT_TOOL_OUTPUT: "1" }, async () => {
		const compactToolDisplay = createTaskHarness({});
		assert(compactToolDisplay.tools.has("read") && compactToolDisplay.tools.has("bash") && compactToolDisplay.tools.has("edit") && compactToolDisplay.tools.has("write"), "compact tool output should be enabled by setting/env and override built-in renderers");
		for (const name of ["read", "bash", "edit", "write"]) assert(compactToolDisplay.tools.get(name).renderShell === "default", `compact ${name} renderer should force Pi's default highlighted shell`);
		const theme = { fg: (_color, text) => text, bg: (color, text) => `[${color}]${text}`, bold: (text) => text };
		const bashCall = compactToolDisplay.tools.get("bash").renderCall({ command: `python3 scripts/build-report.py --input ${homeRoot}/project/data.json\necho done` }, theme, {});
		assert(bashCall.text.includes("python3 scripts/build-report.py") && bashCall.text.includes("~/project/data.json") && bashCall.text.includes("+1 lines"), "compact bash call should show the command summary and shorten home paths");
		const readCall = compactToolDisplay.tools.get("read").renderCall({ path: `${homeRoot}/project/file.ts`, offset: 10, limit: 20 }, theme, {});
		assert(readCall.text.includes("read ~/project/file.ts") && readCall.text.includes("offset 10") && readCall.text.includes("limit 20"), "compact read call should show path and range");
		const readResult = compactToolDisplay.tools.get("read").renderResult({ content: [{ type: "text", text: "hidden file text" }], details: {} }, { expanded: true, isPartial: false }, theme, { isError: false });
		const readBox = renderToolBox(theme, false, 46, readCall, readResult);
		assertFullBackground(readBox, "toolSuccessBg", 46, "compact read shell should paint call and result lines");
		const writeCall = compactToolDisplay.tools.get("write").renderCall({ path: "notes.md", content: "one\ntwo" }, theme, {});
		assert(writeCall.text.includes("write notes.md") && writeCall.text.includes("2 lines"), "compact write call should show path and content size");
		const editCall = compactToolDisplay.tools.get("edit").renderCall({ path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, theme, {});
		assert(editCall.text.includes("edit src/app.ts") && editCall.text.includes("2 replacements"), "compact edit call should show path and replacement count");
		const bashResult = compactToolDisplay.tools.get("bash").renderResult({ content: [{ type: "text", text: "hidden output\nsecond line" }], details: {}, isError: false }, { expanded: true, isPartial: false }, theme, { isError: false });
		assert(!bashResult.text.includes("hidden output") && bashResult.text.includes("✓ exit 0") && bashResult.text.includes("2 lines"), "compact bash renderer should summarize output without dumping it");
		const bashBox = renderToolBox(theme, false, 52, compactToolDisplay.tools.get("bash").renderCall({ command: "npm test" }, theme, {}), bashResult);
		assertFullBackground(bashBox, "toolSuccessBg", 52, "compact bash default shell should paint every responsive column");
		assert(bashBox.join("\n").includes("bash npm test") && bashBox.join("\n").includes("✓ exit 0 2 lines"), "compact bash box should include call and result lines");
		const bashErrorResult = compactToolDisplay.tools.get("bash").renderResult({ content: [{ type: "text", text: "hidden output\n\nCommand exited with code 2" }], details: {} }, { expanded: false, isPartial: false }, theme, { isError: true });
		assert(!bashErrorResult.text.includes("hidden output") && bashErrorResult.text.includes("✗ exit 2"), "compact bash renderer should show failure exit code without dumping output");
		const bashErrorBox = renderToolBox(theme, true, 48, compactToolDisplay.tools.get("bash").renderCall({ command: "npm test" }, theme, {}), bashErrorResult);
		assertFullBackground(bashErrorBox, "toolErrorBg", 48, "compact bash error shell should paint every responsive column");
		const compactedOutput = Array.from({ length: 180 }, (_, index) => `line ${index} ${"x".repeat(70)}`).join("\n");
		const compactedResult = await compactToolDisplay.handlers.get("tool_result")({ toolName: "bash", input: { command: "python noisy.py" }, content: [{ type: "text", text: compactedOutput }], details: {}, isError: false }, compactToolDisplay.ctx);
		assert(compactedResult?.content?.[0]?.text.includes("bash output compacted to reduce context"), "large bash tool results should be compacted for model context");
		assert(compactedResult.content[0].text.includes("captured full output saved to:"), "compacted bash results should include a local captured-output pointer");
		assert(!compactedResult.content[0].text.includes("line 0"), "compacted bash result should avoid dumping the full original output");
		const compactedFile = compactedResult.details?.harnessCompaction?.outputFile;
		assert(compactedFile && existsSync(compactedFile), "compacted bash result should persist the full output locally for targeted follow-up reads");
		rmSync(compactedFile, { force: true });
		const hugeSingleLine = "x".repeat(20_000);
		const hugeLineResult = await compactToolDisplay.handlers.get("tool_result")({ toolName: "bash", input: { command: "python one-line.py" }, content: [{ type: "text", text: hugeSingleLine }], details: {}, isError: false }, compactToolDisplay.ctx);
		assert(hugeLineResult.content[0].text.length < 4_800, "single-line huge bash outputs should still be hard-capped after compaction");
		rmSync(hugeLineResult.details?.harnessCompaction?.outputFile, { force: true });
		const builtInFullOutputPath = join(root, ".tmp-built-in-full-output.log");
		writeFileSync(builtInFullOutputPath, "complete output");
		const truncatedResult = await compactToolDisplay.handlers.get("tool_result")({ toolName: "bash", input: { command: "python truncated.py" }, content: [{ type: "text", text: compactedOutput }], details: { truncation: { truncated: true }, fullOutputPath: builtInFullOutputPath }, isError: false }, compactToolDisplay.ctx);
		assert(truncatedResult.content[0].text.includes("already truncated by bash tool"), "compacted bash results should not claim visible truncated output is complete");
		assert(truncatedResult.content[0].text.includes("complete output saved by bash tool at:"), "compacted bash results should point to built-in full output when available");
		assert(truncatedResult.details?.harnessCompaction?.outputFile === builtInFullOutputPath, "compaction metadata should preserve built-in full output path");
		rmSync(builtInFullOutputPath, { force: true });
		const credentialOutput = [`api_key=abc123456789def`, ...Array.from({ length: 180 }, (_, index) => `safe tail line ${index} ${"x".repeat(70)}`)].join("\n");
		const secretResult = await compactToolDisplay.handlers.get("tool_result")({ toolName: "bash", input: { command: "python secret.py" }, content: [{ type: "text", text: credentialOutput }], details: {}, isError: false }, compactToolDisplay.ctx);
		assert(secretResult.content[0].text.includes("Blocked output"), "credential-bearing bash output should be blocked instead of compacted");
		assert(secretResult.details?.harnessCompaction?.redacted === true && !secretResult.details?.harnessCompaction?.outputFile, "credential-bearing bash output should not be saved to a compaction file");
		const smallResult = await compactToolDisplay.handlers.get("tool_result")({ toolName: "bash", input: { command: "echo ok" }, content: [{ type: "text", text: "ok" }], details: {}, isError: false }, compactToolDisplay.ctx);
		assert(!smallResult, "small bash results should remain inline and unmodified");
		const editResult = compactToolDisplay.tools.get("edit").renderResult({ content: [{ type: "text", text: "ok" }], details: { diff: "diff --git" } }, { expanded: true, isPartial: false }, theme, { isError: false });
		const editBox = renderToolBox(theme, false, 54, editCall, editResult);
		assertFullBackground(editBox, "toolSuccessBg", 54, "compact edit shell should paint call and result lines");
		assert(editBox.join("\n").includes("edit src/app.ts · 2 replacements") && editBox.join("\n").includes("✓ edited diff recorded"), "compact edit box should render requested two-line summary");
		const longEditCall = compactToolDisplay.tools.get("edit").renderCall({ path: `${homeRoot}/project/src/really/long/path/to/app.ts`, edits: [{ oldText: "a", newText: "b" }] }, theme, {});
		const narrowEditBox = renderToolBox(theme, false, 34, longEditCall, editResult);
		assertFullBackground(narrowEditBox, "toolSuccessBg", 34, "compact edit shell should stay fully highlighted when wrapping on narrow terminals");
	});

	const assembled = ambient.assembleAmbientContext("base", "standard", [
		{ id: "late", title: "Late", priority: 20, content: "late content" },
		{ id: "early", title: "Early", priority: 10, content: "early content", publicSummary: "safe summary" },
		{ id: "empty", title: "Empty", priority: 30, reason: "not needed", publicSummary: "should stay hidden" },
	]);
	assert(assembled.systemPrompt.indexOf("early content") < assembled.systemPrompt.indexOf("late content"), "ambient assembler should preserve deterministic priority order");
	assert(assembled.receipt.includes("## Ambient Context Receipt"), "ambient assembler should add a receipt for nontrivial prompts");
	assert(assembled.receipt.includes("policy: nontrivial_prompt"), "ambient receipt should include policy reasons");
	assert(assembled.receipt.includes("vector_memory: no"), "ambient receipt should document that vector memory is disabled");
	assert(assembled.receipt.includes("early: included, 13 chars, safe summary"), "ambient receipt should include safe summaries for included lanes");
	assert(assembled.receipt.includes("empty: skipped, not needed"), "ambient receipt should include skipped lane reasons");
	assert(!assembled.receipt.includes("should stay hidden"), "ambient receipt should not include summaries for skipped lanes");

	const trivial = ambient.assembleAmbientContext("base", "trivial", [{ id: "one", title: "One", priority: 10, content: "one" }]);
	assert(!trivial.receipt, "ambient assembler should not add receipt noise for trivial prompts");

	const leanHarness = createTaskHarness({ bindPayload: taskBindPayload(), memoryContextPayload: { memory_api_version: 1, included: [{ id: "mem-1" }], omitted: [], context: "## Approved Scoped Memory\n- Project preference: Keep task binding and memory hot." } });
	assert(!leanHarness.commands.has("inbox"), "lean harness profile should not register async inbox commands by default");
	assert(!leanHarness.commands.has("control-center") && !leanHarness.commands.has("run-card") && !leanHarness.commands.has("choose-topology") && !leanHarness.commands.has("orchestrate"), "removed orchestration/control-plane slash surfaces should not be registered");
	assert(leanHarness.commands.has("memory") && leanHarness.commands.has("orchestrator"), "lean harness profile should keep memory and session tagging commands");
	await leanHarness.handlers.get("session_start")({ reason: "startup" }, leanHarness.ctx);
	const leanResult = await leanHarness.handlers.get("before_agent_start")({ prompt: "Implement a focused docs token optimization", systemPrompt: "base" }, leanHarness.ctx);
	assert(!leanResult.systemPrompt.includes("## Orchestration Decision"), "lean harness profile should not inject ambient orchestration decisions");
	assert(leanResult.systemPrompt.includes("orchestration: skipped, ambient orchestration disabled by harness profile"), "lean ambient receipt should explain skipped orchestration");
	assert(!leanHarness.execCalls.some((call) => String(call.args?.[0] || "").endsWith("orchestration-decision.sh")), "lean harness profile should not call ambient orchestration decision API");
	assert(!leanHarness.execCalls.some((call) => String(call.args?.[0] || "").endsWith("task-event.sh") && call.args.includes("orchestration_recommended")), "lean harness profile should not record orchestration_recommended task events");
	assert(leanResult.systemPrompt.includes("## Approved Scoped Memory") && leanResult.systemPrompt.includes("## Active AGENTS Task Context"), "lean harness profile should keep memory and task binding hot-path lanes");
	const readOnlyHarness = createTaskHarness({ bindPayload: taskBindPayload() });
	await readOnlyHarness.handlers.get("session_start")({ reason: "startup" }, readOnlyHarness.ctx);
	const readOnlyResult = await readOnlyHarness.handlers.get("before_agent_start")({ prompt: "Read-only audit this repo; no edits, no commits, no subagents.", systemPrompt: "base" }, readOnlyHarness.ctx);
	assert(!readOnlyResult.systemPrompt.includes("## Post-Change Cleanup Gate") && !readOnlyResult.systemPrompt.includes("## Git Push Default") && !readOnlyResult.systemPrompt.includes("## Subagent Topology Reminder"), "explicit read-only/no-subagent prompts should suppress contradictory cleanup, push, and subagent guidance");
	const discussionHarness = createTaskHarness({ bindPayload: taskBindPayload() });
	await discussionHarness.handlers.get("session_start")({ reason: "startup" }, discussionHarness.ctx);
	await discussionHarness.handlers.get("before_agent_start")({ prompt: "What is the current harness control plane shape?", systemPrompt: "base" }, discussionHarness.ctx);
	assert(!discussionHarness.execCalls.some((call) => String(call.args?.[0] || "").endsWith("execution-route.sh")), "obvious discussion prompts should skip the execution-route script");
	const executionHarness = createTaskHarness({ bindPayload: taskBindPayload() });
	await executionHarness.handlers.get("session_start")({ reason: "startup" }, executionHarness.ctx);
	await executionHarness.handlers.get("before_agent_start")({ prompt: "Go ahead and implement the next harness slice", systemPrompt: "base" }, executionHarness.ctx);
	assert(executionHarness.execCalls.some((call) => String(call.args?.[0] || "").endsWith("execution-route.sh")), "execution prompts should still call the execution-route script");
	let repoRootPending = false;
	let memoryDuringRepoRoot = false;
	const parallelMemoryHarness = createTaskHarness({
		bindPayload: taskBindPayload(),
		execHook: async (cmd, args) => {
			const key = args.join(" ");
			const script = String(args[0] || "");
			if (cmd === "git" && key === "rev-parse --show-toplevel") {
				repoRootPending = true;
				await new Promise((resolve) => setTimeout(resolve, 20));
				repoRootPending = false;
				return { code: 0, stdout: `${root}\n`, stderr: "" };
			}
			if (cmd === "bash" && script.endsWith("memory-context.sh") && repoRootPending) memoryDuringRepoRoot = true;
			return undefined;
		},
	});
	await parallelMemoryHarness.handlers.get("session_start")({ reason: "startup" }, parallelMemoryHarness.ctx);
	await parallelMemoryHarness.handlers.get("before_agent_start")({ prompt: "Implement parallel memory lookup", systemPrompt: "base" }, parallelMemoryHarness.ctx);
	assert(memoryDuringRepoRoot, "ambient memory lookup should start without waiting for repo summary when task project root is already known");
	const htmlGuidanceTask = createTaskHarness({ bindPayload: taskBindPayload() });
	await htmlGuidanceTask.handlers.get("session_start")({ reason: "startup" }, htmlGuidanceTask.ctx);
	const htmlGuidance = await htmlGuidanceTask.handlers.get("before_agent_start")({ prompt: "Write a comprehensive implementation status report with diagrams and next steps", systemPrompt: "base" }, htmlGuidanceTask.ctx);
	assert(htmlGuidance.systemPrompt.includes("## Large Response HTML Medium"), "large structured report prompts should inject HTML-as-medium guidance");
	assert(htmlGuidance.systemPrompt.includes("concise: conclusion/current state"), "HTML medium guidance should require concise chat response shape");
	assert(htmlGuidance.systemPrompt.includes("benjamin-report-template.html"), "HTML medium guidance should point at the shared Benjamin report template");
	assert(htmlGuidance.systemPrompt.includes("large_response_html: included"), "ambient receipt should expose large-response HTML guidance inclusion");
	await htmlGuidanceTask.handlers.get("session_compact")({ compactionEntry: { summary: "compact" }, fromExtension: false }, htmlGuidanceTask.ctx);
	assert(htmlGuidanceTask.sentMessages.some((message) => message.customType === "harness-html-artifact-continuity" && message.display === false && message.content.includes("Large Response HTML Artifact Continuity")), "compaction should preserve large-response HTML medium guidance as hidden continuity context");
	const policyRoot = mkdtempSync(join(tmpdir(), "pi-html-policy-"));
	const continuityTemp = mkdtempSync(join(tmpdir(), "pi-html-continuity-"));
	try {
		mkdirSync(join(policyRoot, "policy"));
		writeFileSync(join(policyRoot, "policy", "html-artifacts.json"), JSON.stringify({ auto_open: { enabled: true, modes: ["html_report"] }, modes: [{ id: "html_report" }] }));
		await withEnv({ AGENTS_SHARED_ROOT: policyRoot }, async () => {
			const htmlContinuityTask = createTaskHarness({ bindPayload: taskBindPayload() });
			await htmlContinuityTask.handlers.get("session_start")({ reason: "startup" }, htmlContinuityTask.ctx);
			await htmlContinuityTask.handlers.get("before_agent_start")({ prompt: "Implement small fix", systemPrompt: "base" }, htmlContinuityTask.ctx);
			const htmlPath = join(continuityTemp, "status-report.html");
			writeFileSync(htmlPath, "<!doctype html><title>Status</title>");
			await htmlContinuityTask.handlers.get("tool_result")({ toolName: "write", input: { path: htmlPath }, isError: false }, htmlContinuityTask.ctx);
			await htmlContinuityTask.handlers.get("session_compact")({ compactionEntry: { summary: "compact" }, fromExtension: false }, htmlContinuityTask.ctx);
			const continuity = htmlContinuityTask.sentMessages.find((message) => message.customType === "harness-html-artifact-continuity");
			assert(continuity?.content.includes(htmlPath), "compaction continuity should preserve known local HTML artifact paths");
			assert(continuity?.content.includes(policyRoot), "HTML continuity guidance should honor AGENTS_SHARED_ROOT");
			await htmlContinuityTask.handlers.get("agent_end")({}, htmlContinuityTask.ctx);
			assert(htmlContinuityTask.execCalls.some((call) => call.cmd === "open" && call.args?.[0] === htmlPath), "lean profile should preserve HTML artifact auto-open from shared policy without ambient orchestration");
		});
	} finally {
		rmSync(policyRoot, { recursive: true, force: true });
		rmSync(continuityTemp, { recursive: true, force: true });
	}

	const boundTask = createTaskHarness({
		harnessProfile: "full",
		bindPayload: taskBindPayload(),
		memoryContextPayload: { memory_api_version: 1, included: [{ id: "mem-1" }], omitted: [], context: "## Approved Scoped Memory\n- Project preference: Keep ambient behavior command-light." },
	});
	assert(!boundTask.commands.has("control-center") && !boundTask.commands.has("run-card") && !boundTask.commands.has("choose-topology") && !boundTask.commands.has("orchestrate") && !boundTask.commands.has("inbox"), "full harness profile should not restore removed slash surfaces");
	await boundTask.handlers.get("session_start")({ reason: "startup" }, boundTask.ctx);
	const result = await boundTask.handlers.get("before_agent_start")({ prompt: "Implement ambient context receipts", systemPrompt: "base" }, boundTask.ctx);
	assert(result.systemPrompt.includes("## Ambient Context Receipt"), "standard prompts should include compact ambient context receipt");
	assert(result.systemPrompt.includes("## Orchestration Decision"), "standard prompts should include bounded orchestration decision guidance");
	assert(result.systemPrompt.includes("orchestration: included"), "ambient receipt should show orchestration guidance inclusion");
	assert(boundTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("orchestration-decision.sh")), "ambient orchestration should call the shared decision API");
	assert(boundTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("task-event.sh") && call.args.includes("orchestration_recommended") && call.args.some((arg) => String(arg).startsWith("recommended_topology="))), "ambient orchestration should record a bounded recommended-topology task event");
	assert(result.systemPrompt.includes("agents_task: included"), "ambient receipt should show task context inclusion");
	assert(result.systemPrompt.includes("## Approved Scoped Memory"), "standard scoped prompts should include approved memory from the .agents API");
	assert(result.systemPrompt.includes("memory: included"), "ambient receipt should show approved memory inclusion");
	assert(result.systemPrompt.includes("personal_context: auto_scoped"), "ambient receipt should report scoped memory auto-consideration");
	assert(result.systemPrompt.includes("## Durable Memory Candidate Discipline"), "standard prompts should include candidate-memory final-response discipline");
	assert(result.systemPrompt.includes("memory_candidates: included"), "ambient receipt should show candidate-memory discipline inclusion");
	assert(result.systemPrompt.includes("## Git Push Default"), "standard coding prompts should include plain git-push guidance");
	assert(result.systemPrompt.includes("use `git push`"), "plain git-push guidance should prefer the upstream-aware command");
	assert(result.systemPrompt.includes("Do not use `git push origin main`"), "plain git-push guidance should discourage explicit origin/main refspecs by default");
	assert(result.systemPrompt.includes("git_push: included"), "ambient receipt should show git-push guidance inclusion");
	assert(result.systemPrompt.includes("## Repo Context"), "standard prompts should include passive repo metadata");
	assert(result.systemPrompt.includes("repo: included"), "ambient receipt should show repo metadata inclusion");
	await boundTask.commands.get("status").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("╭─ Ambient"), "/status should expose the last ambient context decision");
	assert(boundTask.sentMessages.at(-1).content.includes("╭─ Memory"), "/status should expose scoped memory API diagnostics");
	assert(boundTask.sentMessages.at(-1).content.includes("recommended single_agent_standard"), "/status should expose recommended orchestration topology");
	await boundTask.commands.get("doctor").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("## Ambient context"), "/doctor should include ambient context diagnostics");
	assert(boundTask.sentMessages.at(-1).content.includes("## Scoped memory API"), "/doctor should include scoped memory API diagnostics");
	const htmlOpenTemp = mkdtempSync(join(tmpdir(), "pi-html-open-"));
	try {
		const htmlPlan = join(htmlOpenTemp, "implementation-plan.html");
		writeFileSync(htmlPlan, "<!doctype html><title>Plan</title>");
		await boundTask.handlers.get("tool_result")({ toolName: "write", input: { path: htmlPlan }, isError: false }, boundTask.ctx);
		assert(!boundTask.execCalls.some((call) => call.cmd === "open" && call.args?.[0] === htmlPlan), "HTML artifacts should open after the turn, not before the final file settles");
		await boundTask.handlers.get("agent_end")({}, boundTask.ctx);
		assert(boundTask.execCalls.some((call) => call.cmd === "open" && call.args?.[0] === htmlPlan), "harness should auto-open newly written local HTML plan artifacts");
	} finally {
		rmSync(htmlOpenTemp, { recursive: true, force: true });
	}
	const htmlOpenDisabled = createTaskHarness({
		harnessProfile: "full",
		bindPayload: taskBindPayload(),
		controlPlaneDecisionPayload: controlPlaneDecisionPayload({
			artifacts: { html: { publish_policy: "explicit_only", source_of_truth: "json_or_markdown", modes: [{ id: "html_report" }], auto_open: { enabled: false, when: "after_local_html_artifact_created", modes: [], safety: ["local_file_only"] }, long_response: { enabled: true, chat_response: "concise_summary_plus_local_artifact_path_and_next_action" }, authoring: { structure_policy: "content_first_flexible", title_style: "compact_first_screen_readable" }, template: { id: "benjamin_local_v1", path: `${agentsRoot}/shared/templates/html-artifacts/benjamin-local-template.html`, allowed_components: [] }, templates: [{ id: "benjamin_local_v1" }], retention: { cleanup_strategy: "manifest_and_marker", delete_on_task_status: ["completed", "stale"], marker: "agents-html-artifact" }, safety: [] } },
		}),
	});
	await htmlOpenDisabled.handlers.get("session_start")({ reason: "startup" }, htmlOpenDisabled.ctx);
	await htmlOpenDisabled.handlers.get("before_agent_start")({ prompt: "Write a long report", systemPrompt: "base" }, htmlOpenDisabled.ctx);
	const htmlOpenDisabledTemp = mkdtempSync(join(tmpdir(), "pi-html-open-disabled-"));
	try {
		const htmlReport = join(htmlOpenDisabledTemp, "very-long-report.html");
		writeFileSync(htmlReport, "<!doctype html><title>Report</title>");
		await htmlOpenDisabled.handlers.get("tool_result")({ toolName: "write", input: { path: htmlReport }, isError: false }, htmlOpenDisabled.ctx);
		await htmlOpenDisabled.handlers.get("agent_end")({}, htmlOpenDisabled.ctx);
		assert(!htmlOpenDisabled.execCalls.some((call) => call.cmd === "open" && call.args?.[0] === htmlReport), "harness should not auto-open name-hinted HTML when shared policy disables auto-open");
	} finally {
		rmSync(htmlOpenDisabledTemp, { recursive: true, force: true });
	}
	const slashOnlyMemoryTask = createTaskHarness({
		cwd: homeRoot,
		gitRoot: false,
		taskDiscoverPayload: taskDiscoverPayload({ project_root: homeRoot, task_project_root: homeRoot }),
		memoryStatsPayload: { memory_api_version: 1, counts_by_state: { candidate: 0, approved: 0, deprecated: 0 }, skipped: 0, scope: { project: false, task: true, global: false, all: false, requested_project: true }, warnings: [{ scope: "project", reason: "home_root" }] },
	});
	await slashOnlyMemoryTask.handlers.get("session_start")({ reason: "startup" }, slashOnlyMemoryTask.ctx);
	await slashOnlyMemoryTask.commands.get("memory").handler("", slashOnlyMemoryTask.ctx);
	assert(slashOnlyMemoryTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("task-discover.sh")), "/memory should discover active task scope when no agent turn has bound this session yet");
	const memoryStatsCall = slashOnlyMemoryTask.execCalls.find((call) => String(call.args?.[0] || "").endsWith("memory-stats.sh"));
	assert(memoryStatsCall?.args.includes("--task-id"), "/memory should pass discovered task id to scoped memory stats");
	assert(slashOnlyMemoryTask.sentMessages.at(-1).content.includes("scoped memory API: ok (task; 0 candidate, 0 approved, 0 deprecated; 0 skipped; 1 warning)"), "/memory should report task-scoped memory API health for home-root slash-only sessions");

	const reviewMemoryTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		memoryStatsPayload: { memory_api_version: 1, counts_by_state: { candidate: 1, approved: 0, deprecated: 0 }, skipped: 0 },
		memoryReviewPayload: memoryReviewPayload({ count: 1, scope: { project: false, task: true, global: false, all: false }, candidates: [{ id: "mem_candidate_1", state: "candidate", title: "Prefer scoped memory", body_preview: "Keep durable memories scoped unless the user explicitly says always.", body_chars: 68, scope: { type: "task" }, provenance: { source: "manual", reason: "explicit test" } }] }),
	});
	await reviewMemoryTask.handlers.get("session_start")({ reason: "startup" }, reviewMemoryTask.ctx);
	await reviewMemoryTask.commands.get("memory").handler("review", reviewMemoryTask.ctx);
	assert(reviewMemoryTask.sentMessages.at(-1).content.includes("## Memory candidate review"), "/memory review should render candidate review output");
	assert(reviewMemoryTask.sentMessages.at(-1).content.includes("review scope: task"), "/memory review should make the effective review scope explicit");
	assert(reviewMemoryTask.sentMessages.at(-1).content.includes("read-only"), "/memory review should state that review is read-only");
	assert(reviewMemoryTask.sentMessages.at(-1).content.includes("mem_candidate_1"), "/memory review should show candidate ids so users can explicitly choose promote/forget");
	assert(reviewMemoryTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("memory-review.sh")), "/memory review should call the shared read-only review script");
	assert(!reviewMemoryTask.execCalls.some((call) => /memory-(add|promote|forget)\.sh$/.test(String(call.args?.[0] || ""))), "/memory review should not perform memory mutations");
	await reviewMemoryTask.commands.get("memory").handler("help", reviewMemoryTask.ctx);
	assert(reviewMemoryTask.sentMessages.at(-1).content.includes("explicit user request only"), "/memory help should explain explicit-only durable write semantics");
	assert(reviewMemoryTask.sentMessages.at(-1).content.includes("memory-add.sh"), "/memory help should point explicit remember requests at the shared add script");
	assert(reviewMemoryTask.sentMessages.at(-1).content.includes("/memory review global"), "/memory help should document explicit global candidate review");

	const globalReviewTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		memoryReviewPayload: memoryReviewPayload({ count: 1, scope: { project: false, task: false, global: true, all: false }, candidates: [{ id: "mem_global_1", state: "candidate", title: "Global roadmap", body_preview: "Review global roadmap themes explicitly.", body_chars: 40, scope: { type: "global" }, provenance: { source: "manual", reason: "explicit test" } }] }),
	});
	await globalReviewTask.handlers.get("session_start")({ reason: "startup" }, globalReviewTask.ctx);
	await globalReviewTask.commands.get("memory").handler("review global", globalReviewTask.ctx);
	assert(globalReviewTask.sentMessages.at(-1).content.includes("## Memory candidate review (global)"), "/memory review global should label global review output");
	assert(globalReviewTask.sentMessages.at(-1).content.includes("review scope: global"), "/memory review global should make the global scope explicit");
	assert(globalReviewTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("memory-review.sh") && call.args.includes("--include-global")), "/memory review global should request explicit global review from the shared script");

	const rememberTask = createTaskHarness({
		bindPayload: taskBindPayload(),
	});
	await rememberTask.handlers.get("session_start")({ reason: "startup" }, rememberTask.ctx);
	const rememberResult = await rememberTask.handlers.get("before_agent_start")({ prompt: "Remember this project preference: keep memory scoped and manual", systemPrompt: "base" }, rememberTask.ctx);
	assert(rememberResult.systemPrompt.includes("## Explicit Memory Admin Request"), "explicit remember prompts should get safe memory-admin guidance");
	assert(rememberResult.systemPrompt.includes("create a candidate by default"), "remember guidance should default to candidate memory, not approved injection");
	assert(rememberResult.systemPrompt.includes("memory_admin: included"), "ambient receipt should expose memory-admin guidance inclusion");
	assert(!rememberTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("memory-add.sh")), "ambient memory-admin guidance should not write memory during prompt assembly");
	assert(!rememberTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("memory-review.sh")), "ambient memory-admin guidance should not auto-review candidates during prompt assembly");
	await rememberTask.commands.get("remember").handler("--task keep memory scoped and manual", rememberTask.ctx);
	assert(rememberTask.sentMessages.at(-1).content.includes("## Remember candidate"), "/remember should render candidate-memory creation output");
	assert(rememberTask.sentMessages.at(-1).content.includes("state: candidate"), "/remember should create candidate memory, not approved memory");
	assert(rememberTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("memory-add.sh") && call.args.includes("--state") && call.args.includes("candidate")), "/remember should call memory-add.sh explicitly as candidate");
	await rememberTask.commands.get("promote-memory").handler("mem_candidate_1 explicit approval", rememberTask.ctx);
	assert(rememberTask.sentMessages.at(-1).content.includes("## Promote memory"), "/promote-memory should render explicit promotion output");
	assert(rememberTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("memory-promote.sh")), "/promote-memory should call the shared promote script");
	await rememberTask.commands.get("forget-memory").handler("mem_candidate_1 explicit forget", rememberTask.ctx);
	assert(rememberTask.sentMessages.at(-1).content.includes("## Forget memory"), "/forget-memory should render explicit forget output");
	assert(rememberTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("memory-forget.sh")), "/forget-memory should call the shared forget script");

	const omittedMemoryTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		memoryContextPayload: { memory_api_version: 1, included: [], omitted: [{ reason: "credential-like metadata" }], context: "" },
	});
	await omittedMemoryTask.handlers.get("session_start")({ reason: "startup" }, omittedMemoryTask.ctx);
	const omittedResult = await omittedMemoryTask.handlers.get("before_agent_start")({ prompt: "Implement memory context", systemPrompt: "base" }, omittedMemoryTask.ctx);
	assert(omittedResult.systemPrompt.includes("memory: skipped, memory API returned 0 included records; 1 omitted by filter/safety/budget"), "ambient receipt should distinguish omitted memory from absent memory without overstating the cause");

	await withEnv({ PI_SUBAGENT_CHILD: "1" }, async () => {
		const childCommands = new Map();
		harnessCommands({ on: () => {}, registerCommand: (name, command) => childCommands.set(name, command) });
		assert(childCommands.size === 0, "PI_SUBAGENT_CHILD should suppress harness slash commands in subagent children");
	});
}
