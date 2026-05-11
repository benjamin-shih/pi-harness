import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadExtensionModule } from "../harness.mjs";
import { agentsRoot, assert, controlPlaneDashboardPayload, controlPlaneDecisionPayload, createTaskHarness, harnessCommands, homeRoot, join, memoryReviewPayload, root, taskBindPayload, taskDiscoverPayload, withEnv } from "./support.mjs";

export async function runAmbientContextTests() {
	const ambient = loadExtensionModule("extensions/shared/ambient-context.ts");
	const ambientPolicy = loadExtensionModule("extensions/shared/ambient-policy.ts");
	const repoContext = loadExtensionModule("extensions/shared/repo-context.ts");
	const memoryContext = loadExtensionModule("extensions/shared/memory-context.ts");
	assert(typeof ambient.assembleAmbientContext === "function", "ambient context module should export assembler");
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

	await withEnv({ BEN_PI_COMPACT_TOOL_OUTPUT: "0" }, async () => {
		const defaultToolDisplay = createTaskHarness({});
		assert(defaultToolDisplay.tools.size === 0, "compact tool output should be disabled when the setting/env is off");
	});
	await withEnv({ BEN_PI_COMPACT_TOOL_OUTPUT: "1" }, async () => {
		const compactToolDisplay = createTaskHarness({});
		assert(compactToolDisplay.tools.has("read") && compactToolDisplay.tools.has("bash") && compactToolDisplay.tools.has("edit") && compactToolDisplay.tools.has("write"), "compact tool output should be enabled by setting/env and override built-in renderers");
		const theme = { fg: (_color, text) => text, bg: (color, text) => `[${color}]${text}`, bold: (text) => text };
		const bashCall = compactToolDisplay.tools.get("bash").renderCall({ command: `python3 scripts/build-report.py --input ${homeRoot}/project/data.json\necho done` }, theme, {});
		assert(bashCall.text.includes("python3 scripts/build-report.py") && bashCall.text.includes("~/project/data.json") && bashCall.text.includes("+1 lines"), "compact bash call should show the command summary and shorten home paths");
		const readCall = compactToolDisplay.tools.get("read").renderCall({ path: `${homeRoot}/project/file.ts`, offset: 10, limit: 20 }, theme, {});
		assert(readCall.text.includes("read ~/project/file.ts") && readCall.text.includes("offset 10") && readCall.text.includes("limit 20"), "compact read call should show path and range");
		const writeCall = compactToolDisplay.tools.get("write").renderCall({ path: "notes.md", content: "one\ntwo" }, theme, {});
		assert(writeCall.text.includes("write notes.md") && writeCall.text.includes("2 lines"), "compact write call should show path and content size");
		const editCall = compactToolDisplay.tools.get("edit").renderCall({ path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, theme, {});
		assert(editCall.text.includes("edit src/app.ts") && editCall.text.includes("2 replacements"), "compact edit call should show path and replacement count");
		const bashResult = compactToolDisplay.tools.get("bash").renderResult({ content: [{ type: "text", text: "hidden output\nsecond line" }], details: {}, isError: false }, { expanded: true, isPartial: false }, theme, { isError: false });
		assert(!bashResult.text.includes("hidden output") && bashResult.text.includes("2 lines") && bashResult.text.includes("[toolSuccessBg]✓ exit 0"), "compact bash renderer should summarize output with success background without dumping it");
		const bashErrorResult = compactToolDisplay.tools.get("bash").renderResult({ content: [{ type: "text", text: "hidden output\n\nCommand exited with code 2" }], details: {} }, { expanded: false, isPartial: false }, theme, { isError: true });
		assert(!bashErrorResult.text.includes("hidden output") && bashErrorResult.text.includes("[toolErrorBg]✗ exit 2"), "compact bash renderer should show failure background and exit code without dumping output");
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

	const boundTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		memoryContextPayload: { memory_api_version: 1, included: [{ id: "mem-1" }], omitted: [], context: "## Approved Scoped Memory\n- Project preference: Keep ambient behavior command-light." },
	});
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
	assert(result.systemPrompt.includes("## Repo Context"), "standard prompts should include passive repo metadata");
	assert(result.systemPrompt.includes("repo: included"), "ambient receipt should show repo metadata inclusion");
	await boundTask.commands.get("status").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("╭─ Ambient"), "/status should expose the last ambient context decision");
	assert(boundTask.sentMessages.at(-1).content.includes("╭─ Memory"), "/status should expose scoped memory API diagnostics");
	assert(boundTask.sentMessages.at(-1).content.includes("recommended single_agent_standard"), "/status should expose recommended orchestration topology");
	await boundTask.commands.get("doctor").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("## Ambient context"), "/doctor should include ambient context diagnostics");
	assert(boundTask.sentMessages.at(-1).content.includes("## Scoped memory API"), "/doctor should include scoped memory API diagnostics");
	await boundTask.commands.get("run-card").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).customType === "harness-run-card", "/run-card should send a run-card message");
	assert(boundTask.sentMessages.at(-1).content.includes("## Run card"), "/run-card should render latest orchestration decision details");
	assert(boundTask.sentMessages.at(-1).content.includes("topology: single_agent_standard"), "/run-card should include the recommended topology");
	assert(boundTask.sentMessages.at(-1).content.includes("run shape: main_agent"), "/run-card should include the recommended run shape");
	assert(boundTask.sentMessages.at(-1).content.includes("registry: project via cwd"), "/run-card should include project registry match metadata");
	assert(boundTask.sentMessages.at(-1).content.includes("default checks: make verify"), "/run-card should include project registry default checks");
	assert(boundTask.sentMessages.at(-1).content.includes("gate ids: repo_clean_preflight"), "/run-card should include decision gate ids");
	assert(boundTask.sentMessages.at(-1).content.includes("html artifacts: html_report"), "/run-card should include HTML artifact recommendations");
	assert(boundTask.sentMessages.at(-1).content.includes("benjamin-local-template.html"), "/run-card should show the reusable HTML artifact template");
	assert(boundTask.sentMessages.at(-1).content.includes("html templates: benjamin_local_v1; benjamin_report_v1; benjamin_dashboard_v1"), "/run-card should show the reusable HTML template catalog");
	assert(boundTask.sentMessages.at(-1).content.includes("range_sliders"), "/run-card should show template component capabilities");
	assert(boundTask.sentMessages.at(-1).content.includes("html auto-open: enabled"), "/run-card should show HTML artifact auto-open policy");
	assert(boundTask.sentMessages.at(-1).content.includes("html long responses: concise_summary_plus_local_artifact_path_and_next_action"), "/run-card should show long-response HTML policy");
	assert(boundTask.sentMessages.at(-1).content.includes("html structure: content_first_flexible"), "/run-card should show flexible HTML structure policy");
	assert(boundTask.sentMessages.at(-1).content.includes("html title style: compact_first_screen_readable"), "/run-card should show compact title policy");
	assert(boundTask.sentMessages.at(-1).content.includes("html retention: manifest_and_marker"), "/run-card should show HTML artifact retention policy");
	assert(boundTask.sentMessages.at(-1).content.includes("delegation launch: manual_main_agent_only; auto-launch no"), "/run-card should show manual-only delegation launch policy");
	assert(boundTask.sentMessages.at(-1).content.includes("delegation pattern: single_writer_optional_review"), "/run-card should show delegation workflow pattern");
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
	await boundTask.commands.get("choose-topology").handler("single_agent_standard simple surgical task", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("## Orchestration choice"), "/choose-topology should render explicit choice tracking output");
	const chosenCall = boundTask.execCalls.find((call) => String(call.args?.[0] || "").endsWith("task-event.sh") && call.args.includes("orchestration_chosen"));
	assert(chosenCall?.args.some((arg) => String(arg).startsWith("chosen_topology=")), "/choose-topology should record a bounded chosen-topology task event");
	assert(chosenCall?.args.some((arg) => String(arg).startsWith("decision_id=")), "/choose-topology should pair the choice with the latest recommendation id without displaying it");
	assert(!chosenCall?.args.some((arg) => String(arg).startsWith("reason=")), "/choose-topology should not persist free-form reason text in task events");
	await boundTask.commands.get("run-card").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("## Chosen vs recommended"), "/run-card should include chosen-vs-recommended tracking");
	assert(boundTask.sentMessages.at(-1).content.includes("chosen single_agent_standard"), "/run-card should show explicitly chosen topology");
	assert(boundTask.sentMessages.at(-1).content.includes("orchestration explanation: explicit choice matches"), "/run-card should explain session-local chosen-vs-recommended status");
	assert(boundTask.sentMessages.at(-1).content.includes("use /control-center for decision-id stale-choice checks"), "/run-card should point stale-choice diagnostics to control-center");
	await boundTask.commands.get("control-center").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).customType === "harness-control-center", "/control-center should send a control-center message");
	assert(boundTask.sentMessages.at(-1).content.includes("## Agent Control Center v0"), "/control-center should render the local dashboard card");
	assert(boundTask.sentMessages.at(-1).content.includes("mode: read-only diagnostics"), "/control-center should state it is read-only");
	assert(boundTask.sentMessages.at(-1).content.includes("topology: no orchestration decision requested"), "/control-center without prompt should show that no orchestration decision was requested");
	assert(boundTask.sentMessages.at(-1).content.includes("active task: status in_progress; lease live"), "/control-center should summarize active task lifecycle without exposing task ids");
	assert(boundTask.sentMessages.at(-1).content.includes("recent events: 2026-05-08T00:00:00Z checkpoint"), "/control-center should show a sanitized recent event timeline");
	assert(boundTask.sentMessages.at(-1).content.includes("orchestration tracking: recommended parallel_recon; chosen single_agent_standard; status mismatch; mismatch true"), "/control-center should summarize chosen-vs-recommended tracking from the dashboard API");
	assert(boundTask.sentMessages.at(-1).content.includes("orchestration tracking explanation: explicit choice differs"), "/control-center should explain chosen-vs-recommended mismatches");
	assert(boundTask.sentMessages.at(-1).content.includes("## Async inbox"), "/control-center should include bounded async inbox diagnostics");
	assert(boundTask.sentMessages.at(-1).content.includes("queued lanes: project=1"), "/control-center should summarize async inbox lanes without listing raw requests");
	assert(boundTask.sentMessages.at(-1).content.includes("## HTML artifact retention"), "/control-center should include HTML retention diagnostics");
	assert(boundTask.sentMessages.at(-1).content.includes("cleanup candidates"), "/control-center should summarize HTML cleanup candidates");
	assert(boundTask.sentMessages.at(-1).content.includes("candidates: 1"), "/control-center should include scoped memory candidate counts");
	assert(!boundTask.sentMessages.at(-1).content.includes("pi-task"), "/control-center should not display private task ids");
	assert(boundTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("control-plane.sh") && call.args.includes("dashboard")), "/control-center should call the shared dashboard API");

	const explicitControlCenterTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		controlPlaneDashboardPayload: controlPlaneDashboardPayload({ route: { task: { shape: "coursework", complexity: "complex", risk: "medium" }, run: { shape: "parallel_recon", summary: "coursework assist/explain/verify" } }, orchestration_decision: controlPlaneDecisionPayload({ task: { shape: "coursework", complexity: "complex", risk: "medium" }, project: { name: "STATS300C", root: "/Users/benjaminshih/Desktop/Stanford/STATS300C", type: "coursework", registry_id: "STATS300C", match_type: "explicit_project", steward: "course-steward", description: "Course project", tags: ["course"], default_checks: ["make check-homework"], write_policy: "assist_explain_verify", coursework_policy: "assist_explain_verify" }, route: { run: { shape: "parallel_recon", summary: "coursework assist/explain/verify" }, reasons: [] }, topology: { recommended: "parallel_recon", reason: "coursework needs recon", advisory_only: true, subagents: [] } }), project: { name: "STATS300C", root: "/Users/benjaminshih/Desktop/Stanford/STATS300C", type: "coursework", registry_id: "STATS300C", match_type: "explicit_project", steward: "course-steward", description: "Course project", tags: ["course"], default_checks: ["make check-homework"], write_policy: "assist_explain_verify", coursework_policy: "assist_explain_verify" } }),
	});
	await explicitControlCenterTask.handlers.get("session_start")({ reason: "startup" }, explicitControlCenterTask.ctx);
	await explicitControlCenterTask.commands.get("control-center").handler("--project STATS300C Finish HW3", explicitControlCenterTask.ctx);
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("task: coursework; complexity complex; risk medium"), "/control-center with prompt text should show route summary");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("topology: parallel_recon"), "/control-center with prompt text should show orchestration topology");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("topology rationale: coursework needs recon"), "/control-center should show why the topology was recommended");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("project defaults: checks make check-homework; write assist_explain_verify; coursework assist_explain_verify"), "/control-center should show project defaults beside the decision");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("html artifact modes: html_report"), "/control-center should summarize HTML artifact modes from decision payloads");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("html template: "), "/control-center should summarize the reusable HTML artifact template");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("html templates: benjamin_local_v1; benjamin_report_v1; benjamin_dashboard_v1"), "/control-center should summarize the reusable HTML template catalog");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("html components: cards; tabs; range_sliders; sortable_tables"), "/control-center should summarize reusable HTML component capabilities");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("html auto-open: enabled"), "/control-center should summarize HTML artifact auto-open policy");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("html long responses: concise_summary_plus_local_artifact_path_and_next_action"), "/control-center should summarize long-response HTML policy");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("html structure: content_first_flexible"), "/control-center should summarize flexible HTML structure policy");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("html title style: compact_first_screen_readable"), "/control-center should summarize compact title policy");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("html retention: manifest_and_marker"), "/control-center should summarize HTML artifact retention policy");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("delegation launch: manual_main_agent_only; auto-launch no"), "/control-center should summarize manual-only delegation policy");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("registry: STATS300C via explicit_project"), "/control-center should pass explicit project selectors to the shared dashboard API");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("policy: write assist_explain_verify; coursework assist_explain_verify"), "/control-center should expose coursework policy read-only");
	const dashboardCall = explicitControlCenterTask.execCalls.find((call) => String(call.args?.[0] || "").endsWith("control-plane.sh") && call.args.includes("dashboard"));
	assert(dashboardCall?.args.includes("--project") && dashboardCall.args.includes("STATS300C"), "/control-center should forward --project to control-plane dashboard");
	await explicitControlCenterTask.commands.get("control-center").handler("web --project STATS300C", explicitControlCenterTask.ctx);
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("## Agent Control Center web"), "/control-center web should report the local web dashboard URL");
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("read-only local web dashboard"), "/control-center web should be explicitly read-only");
	assert(explicitControlCenterTask.execCalls.some((call) => call.cmd === "open" && String(call.args?.[0] || "").startsWith("http://127.0.0.1:")), "/control-center web should open a localhost dashboard URL");
	const controlCenterSource = readFileSync(join(root, "extensions/shared/control-center.ts"), "utf8");
	assert(controlCenterSource.includes("method: 'POST'"), "control-center web should send project/prompt inputs in a POST body");
	assert(!controlCenterSource.includes("searchParams.get(\"prompt\")"), "control-center web should not transport prompt text in URL query strings");
	await explicitControlCenterTask.commands.get("control-center").handler("web stop", explicitControlCenterTask.ctx);
	assert(explicitControlCenterTask.sentMessages.at(-1).content.includes("stopped: yes"), "/control-center web stop should close the local web dashboard server");

	const fallbackRunCardTask = createTaskHarness({
		controlPlaneDecisionPayload: controlPlaneDecisionPayload({ notices: ["project not bindable: home_root"], warnings: [] }),
	});
	await fallbackRunCardTask.handlers.get("session_start")({ reason: "startup" }, fallbackRunCardTask.ctx);
	await fallbackRunCardTask.commands.get("run-card").handler("", fallbackRunCardTask.ctx);
	assert(!fallbackRunCardTask.sentMessages.at(-1).content.includes("not assembled yet"), "/run-card without cached decision should build a fallback current-project decision");
	assert(fallbackRunCardTask.sentMessages.at(-1).content.includes("source: generated current-project fallback"), "/run-card fallback should label its source");
	assert(fallbackRunCardTask.sentMessages.at(-1).content.includes("notices: project not bindable: home_root"), "/run-card should render decision notices separately from warnings");
	const explicitRunCardTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		controlPlaneDecisionPayload: controlPlaneDecisionPayload({ task: { shape: "coursework", complexity: "complex", risk: "medium" }, project: { name: "STATS300C", root: "/Users/benjaminshih/Desktop/Stanford/STATS300C", type: "coursework", bindable: true, reason: "project_path", registry_id: "STATS300C", registered: true, match_type: "prompt_alias", steward: "course-steward", default_checks: ["make check-homework"], write_policy: "assist_explain_verify", coursework_policy: "assist_explain_verify", local_instructions_required: true }, route: { run: { shape: "parallel_recon", summary: "front-door main agent remains accountable; coursework assist/explain/verify" }, reasons: [] }, topology: { recommended: "parallel_recon", reason: "coursework assist/explain/verify", advisory_only: true, subagents: [] }, guidance: "## Orchestration Decision\n- task: coursework; complexity complex; risk medium" }),
	});
	await explicitRunCardTask.handlers.get("session_start")({ reason: "startup" }, explicitRunCardTask.ctx);
	await explicitRunCardTask.commands.get("run-card").handler("Finish HW3 for STATS300C", explicitRunCardTask.ctx);
	assert(explicitRunCardTask.sentMessages.at(-1).content.includes("project: STATS300C (coursework)"), "/run-card with prompt text should route explicit coursework prompts");
	assert(explicitRunCardTask.sentMessages.at(-1).content.includes("policy: write assist_explain_verify; coursework assist_explain_verify"), "/run-card should expose coursework policy from the registry");
	assert(explicitRunCardTask.execCalls.some((call) => String(call.args?.[0] || "").endsWith("orchestration-decision.sh")), "/run-card should call the shared orchestration decision API");

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
