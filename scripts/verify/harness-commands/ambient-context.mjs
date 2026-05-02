import { loadExtensionModule } from "../harness.mjs";
import { assert, createTaskHarness, join, agentsTasksRoot, root } from "./support.mjs";

export async function runAmbientContextTests() {
	const ambient = loadExtensionModule("extensions/shared/ambient-context.ts");
	const ambientPolicy = loadExtensionModule("extensions/shared/ambient-policy.ts");
	const repoContext = loadExtensionModule("extensions/shared/repo-context.ts");
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

	const assembled = ambient.assembleAmbientContext("base", "standard", [
		{ id: "late", title: "Late", priority: 20, content: "late content" },
		{ id: "early", title: "Early", priority: 10, content: "early content" },
		{ id: "empty", title: "Empty", priority: 30, reason: "not needed" },
	]);
	assert(assembled.systemPrompt.indexOf("early content") < assembled.systemPrompt.indexOf("late content"), "ambient assembler should preserve deterministic priority order");
	assert(assembled.receipt.includes("## Ambient Context Receipt"), "ambient assembler should add a receipt for nontrivial prompts");
	assert(assembled.receipt.includes("policy: nontrivial_prompt"), "ambient receipt should include policy reasons");
	assert(assembled.receipt.includes("vector_memory: no"), "ambient receipt should document that vector memory is disabled");
	assert(assembled.receipt.includes("empty: skipped, not needed"), "ambient receipt should include skipped lane reasons");

	const trivial = ambient.assembleAmbientContext("base", "trivial", [{ id: "one", title: "One", priority: 10, content: "one" }]);
	assert(!trivial.receipt, "ambient assembler should not add receipt noise for trivial prompts");

	const boundTask = createTaskHarness({
		bindPayload: { action: "created", bound: true, created: true, blocked: false, reason: "", task_id: "pi-task", task_dir: join(agentsTasksRoot, "pi-task"), runtime: "pi", session: "pi-session-1", project_root: root },
		memoryContextPayload: { memory_api_version: 1, included: [{ id: "mem-1" }], omitted: [], context: "## Approved Scoped Memory\n- Project preference: Keep ambient behavior command-light." },
	});
	await boundTask.handlers.get("session_start")({ reason: "startup" }, boundTask.ctx);
	const result = await boundTask.handlers.get("before_agent_start")({ prompt: "Implement ambient context receipts", systemPrompt: "base" }, boundTask.ctx);
	assert(result.systemPrompt.includes("## Ambient Context Receipt"), "standard prompts should include compact ambient context receipt");
	assert(result.systemPrompt.includes("agents_task: included"), "ambient receipt should show task context inclusion");
	assert(result.systemPrompt.includes("## Approved Scoped Memory"), "standard scoped prompts should include approved memory from the .agents API");
	assert(result.systemPrompt.includes("memory: included"), "ambient receipt should show approved memory inclusion");
	assert(result.systemPrompt.includes("personal_context: auto_scoped"), "ambient receipt should report scoped memory auto-consideration");
	assert(result.systemPrompt.includes("## Repo Context"), "standard prompts should include passive repo metadata");
	assert(result.systemPrompt.includes("repo: included"), "ambient receipt should show repo metadata inclusion");
	await boundTask.commands.get("status").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("ambient context:"), "/status should expose the last ambient context decision");
	await boundTask.commands.get("doctor").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("## Ambient context"), "/doctor should include ambient context diagnostics");
}
