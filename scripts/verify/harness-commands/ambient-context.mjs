import { loadExtensionModule } from "../harness.mjs";
import { assert, createTaskHarness, join, agentsTasksRoot, root } from "./support.mjs";

export async function runAmbientContextTests() {
	const ambient = loadExtensionModule("extensions/shared/ambient-context.ts");
	assert(typeof ambient.assembleAmbientContext === "function", "ambient context module should export assembler");
	assert(typeof ambient.ambientStatusLines === "function", "ambient context module should export status lines");

	const assembled = ambient.assembleAmbientContext("base", "standard", [
		{ id: "late", title: "Late", priority: 20, content: "late content" },
		{ id: "early", title: "Early", priority: 10, content: "early content" },
		{ id: "empty", title: "Empty", priority: 30, reason: "not needed" },
	]);
	assert(assembled.systemPrompt.indexOf("early content") < assembled.systemPrompt.indexOf("late content"), "ambient assembler should preserve deterministic priority order");
	assert(assembled.receipt.includes("## Ambient Context Receipt"), "ambient assembler should add a receipt for nontrivial prompts");
	assert(assembled.receipt.includes("vector_memory: no"), "ambient receipt should document that vector memory is disabled");
	assert(assembled.receipt.includes("empty: skipped, not needed"), "ambient receipt should include skipped lane reasons");

	const trivial = ambient.assembleAmbientContext("base", "trivial", [{ id: "one", title: "One", priority: 10, content: "one" }]);
	assert(!trivial.receipt, "ambient assembler should not add receipt noise for trivial prompts");

	const boundTask = createTaskHarness({
		bindPayload: { action: "created", bound: true, created: true, blocked: false, reason: "", task_id: "pi-task", task_dir: join(agentsTasksRoot, "pi-task"), runtime: "pi", session: "pi-session-1", project_root: root },
	});
	await boundTask.handlers.get("session_start")({ reason: "startup" }, boundTask.ctx);
	const result = await boundTask.handlers.get("before_agent_start")({ prompt: "Implement ambient context receipts", systemPrompt: "base" }, boundTask.ctx);
	assert(result.systemPrompt.includes("## Ambient Context Receipt"), "standard prompts should include compact ambient context receipt");
	assert(result.systemPrompt.includes("agents_task: included"), "ambient receipt should show task context inclusion");
	await boundTask.commands.get("status").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("ambient context:"), "/status should expose the last ambient context decision");
	await boundTask.commands.get("doctor").handler("", boundTask.ctx);
	assert(boundTask.sentMessages.at(-1).content.includes("## Ambient context"), "/doctor should include ambient context diagnostics");
}
