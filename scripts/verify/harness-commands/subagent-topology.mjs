import { loadExtensionModule } from "../harness.mjs";
import { assert, createHarness, createTaskHarness, root, taskBindPayload } from "./support.mjs";

export async function runSubagentTopologyTests() {
	const topology = loadExtensionModule("extensions/shared/subagent-topology.ts");
	assert(!topology.shouldIncludeSubagentTopologyGuidance("What is the CLT?", "trivial"), "trivial prompts should not get subagent topology guidance");
	assert(topology.shouldIncludeSubagentTopologyGuidance("Design a risky multi-step architecture migration", "standard"), "risky detailed prompts should get subagent topology guidance");
	assert(topology.shouldIncludeSubagentTopologyGuidance("Summarize this large implementation plan", "complex"), "complex prompts should get subagent topology guidance");

	const light = topology.buildSubagentTopologyReminder("Post-implementation review of a risky architecture change", "standard");
	assert(light?.includes("## Subagent Topology Reminder"), "light topology guidance should have a clear section heading");
	assert(light.includes("scout/researcher"), "light topology guidance should mention scout/researcher roles");
	assert(light.includes("reviewer for blocker-only post-implementation review"), "light topology guidance should mention post-implementation reviewer use");
	assert(light.includes("same relevant profile and capability overlays"), "light topology guidance should ask subagents to adopt relevant profiles/overlays");
	assert(light.includes("main agent accountable"), "light topology guidance should keep the main agent accountable");

	const trivialHarness = createHarness([]);
	const trivialResult = await trivialHarness.beforeAgentStart({ prompt: "What is the CLT?", systemPrompt: "base" }, { cwd: root });
	assert(!trivialResult?.systemPrompt?.includes("## Subagent Topology Reminder"), "trivial harness prompts should not inject subagent topology guidance");

	const detailedHarness = createTaskHarness({ bindPayload: taskBindPayload() });
	await detailedHarness.handlers.get("session_start")({ reason: "startup" }, detailedHarness.ctx);
	const result = await detailedHarness.handlers.get("before_agent_start")({ prompt: "Design a risky multi-step architecture migration with post-implementation review", systemPrompt: "base" }, detailedHarness.ctx);
	assert(result.systemPrompt.includes("## Subagent Topology Reminder"), "detailed prompts should inject subagent topology guidance");
	assert(result.systemPrompt.includes("subagent_topology: included"), "ambient receipt should expose subagent topology inclusion");
	assert(!detailedHarness.commands.has("subagent-topology"), "subagent topology guidance should not add a command surface");
}
