import { loadExtensionModule } from "../harness.mjs";
import { assert, createTaskHarness, join, root, taskBindPayload } from "./support.mjs";

export async function runAmbientContextTests() {
	const ambient = loadExtensionModule("extensions/shared/ambient-context.ts");
	const ambientPolicy = loadExtensionModule("extensions/shared/ambient-policy.ts");
	const repoContext = loadExtensionModule("extensions/shared/repo-context.ts");
	const memoryContext = loadExtensionModule("extensions/shared/memory-context.ts");
	assert(typeof ambient.assembleAmbientContext === "function", "ambient context module should export assembler");
	assert(typeof ambient.ambientStatusLines === "function", "ambient context module should export status lines");
	assert(ambientPolicy.decideAmbientPolicy("trivial").receipt === "off", "ambient policy should suppress receipts for trivial prompts");
	assert(ambientPolicy.decideAmbientPolicy("standard").personalContext === "auto_scoped", "ambient policy should auto-consider scoped approved memory for nontrivial prompts");
	assert(ambientPolicy.shouldIncludeRepoContext(ambientPolicy.decideAmbientPolicy("standard")), "ambient policy should include repo context for nontrivial prompts");

	const cleanRepo = await repoContext.buildRepoContextSummary({ exec: async (_cmd, args) => {
		if (args.join(" ") === "rev-parse --show-toplevel") return { code: 0, stdout: `${root}\n`, stderr: "" };
		if (args.join(" ") === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "" };
		if (args.join(" ") === "status --porcelain=v1 --untracked-files=no") return { code: 0, stdout: " M README.md\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	} }, root);
	assert(cleanRepo.status === "dirty" && cleanRepo.summary === "0 staged, 1 unstaged, untracked not scanned", "repo context should summarize tracked porcelain status without scanning untracked names");
	assert(repoContext.formatRepoContext(cleanRepo).includes("## Repo Context"), "repo context should render bounded metadata");
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
	await boundTask.commands.get("doctor").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("## Ambient context"), "/doctor should include ambient context diagnostics");
	assert(boundTask.sentMessages.at(-1).content.includes("## Scoped memory API"), "/doctor should include scoped memory API diagnostics");

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

	const omittedMemoryTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		memoryContextPayload: { memory_api_version: 1, included: [], omitted: [{ reason: "credential-like metadata" }], context: "" },
	});
	await omittedMemoryTask.handlers.get("session_start")({ reason: "startup" }, omittedMemoryTask.ctx);
	const omittedResult = await omittedMemoryTask.handlers.get("before_agent_start")({ prompt: "Implement memory context", systemPrompt: "base" }, omittedMemoryTask.ctx);
	assert(omittedResult.systemPrompt.includes("memory: skipped, memory API returned 0 included records; 1 omitted by filter/safety/budget"), "ambient receipt should distinguish omitted memory from absent memory without overstating the cause");
}
