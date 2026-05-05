import { loadExtensionModule } from "../harness.mjs";
import { assert, createTaskHarness, taskBindPayload } from "./support.mjs";

export async function runExecutionGuidanceTests() {
	const execution = loadExtensionModule("extensions/shared/execution-guidance.ts");
	assert(!execution.hasExecutionIntent("What does this repository do?"), "ordinary questions should not trigger execution protocol");
	assert(!execution.buildExecutionGuidance("Continue discussing the design tradeoffs"), "discussion-continuation prompts should not trigger execution protocol");
	assert(!execution.hasExecutionIntent("How would you implement this?"), "implementation questions should not authorize execution");
	assert(!execution.hasExecutionIntent("Can you explain how to implement this plan?"), "explanation questions should not authorize execution");
	assert(!execution.hasExecutionIntent("Continue with the plan discussion"), "plan-discussion prompts should not authorize execution");
	assert(!execution.hasExecutionIntent("Please proceed with discussing the task"), "task-discussion prompts should not authorize execution");
	assert(!execution.hasExecutionIntent("Continue"), "bare continue should not authorize automatic execution/commit policy");
	assert(!execution.hasExecutionIntent("Proceed"), "bare proceed should not authorize automatic execution/commit policy");
	assert(!execution.hasExecutionIntent("Continue with the plan"), "ambiguous plan continuation should not authorize automatic execution/commit policy");
	assert(!execution.hasExecutionIntent("Proceed with implementation"), "ambiguous implementation continuation should not authorize automatic execution/commit policy");
	assert(execution.hasExecutionIntent("Go ahead and implement the plan"), "go-ahead implementation prompts should trigger execution protocol");
	assert(execution.hasExecutionIntent("Ship this end-to-end"), "ship/end-to-end prompts should trigger execution protocol");
	assert(execution.hasExecutionIntent("Go ahead and write the docs"), "go-ahead writing prompts should trigger execution protocol");
	assert(execution.hasExecutionIntent("Go ahead with the plan"), "go-ahead plan prompts should trigger execution protocol");
	assert(execution.hasExecutionIntent("Go ahead with implementation"), "go-ahead implementation-continuation prompts should trigger execution protocol");
	assert(execution.hasExecutionIntent("Go ahead and continue from the latest checkpoint"), "go-ahead checkpoint continuation prompts should trigger execution protocol");

	assert(execution.classifyExecutionProfile("Go ahead and implement the TypeScript extension tests") === "software", "software execution prompts should route to software profile");
	assert(execution.classifyExecutionProfile("Go ahead and cut the changelog release") === "software", "release/changelog work should remain under software profile with overlay support");
	assert(execution.classifyExecutionProfile("Execute the GitHub Actions deployment rollback") === "devops", "CI/deployment prompts should route to devops profile");
	assert(execution.classifyExecutionProfile("Execute the AI literature review and benchmark ablation") === "research_ai_ml", "AI research prompts should route to research profile");
	assert(execution.classifyExecutionProfile("Run the quant backtest and statistical robustness checks") === "empirical_data", "data/quant prompts should route to empirical profile");
	assert(execution.classifyExecutionProfile("Go ahead and write the documentation guide") === "documentation", "documentation prompts should route to documentation profile");

	const overlays = execution.classifyExecutionOverlays("Go ahead and implement the Python UV experiment, plot the Matplotlib figure, write the LaTeX proof, and prepare changelog release notes without leaking secrets");
	for (const overlay of ["python_uv", "plotting", "math_latex", "release_changelog", "security_privacy"]) {
		assert(overlays.includes(overlay), `execution overlay should include ${overlay}`);
	}

	const route = execution.buildExecutionGuidance("Go ahead and simplify the package dependency cleanup with subagents");
	assert(route?.guidance.includes("## Ambient Execution Protocol"), "execution guidance should have a clear ambient section heading");
	assert(route.summary === "profile software; overlays repo_cleanup, package_hygiene, subagent_orchestration", "execution route should expose a safe profile/overlay summary");
	assert(route.guidance.includes("correct the route"), "execution guidance should ask agents to correct continuation-prompt routing from context");
	assert(route.guidance.includes("Automatically commit and push"), "execution guidance should include auto commit/push policy");
	assert(route.guidance.includes("incremental coherent commits"), "execution guidance should include incremental commit policy");
	assert(route.guidance.includes("subagents"), "execution guidance should include subagent-use expectations");
	assert(route.guidance.includes("Final report"), "execution guidance should include final-report expectations");

	const harness = createTaskHarness({ bindPayload: taskBindPayload() });
	assert(!harness.commands.has("execute"), "ambient execution protocol should not add an /execute command yet");
	await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
	const result = await harness.handlers.get("before_agent_start")({ prompt: "Go ahead and implement the execution protocol end-to-end", systemPrompt: "base" }, harness.ctx);
	assert(result.systemPrompt.includes("## Ambient Execution Protocol"), "execution prompts should include ambient execution protocol guidance");
	assert(result.systemPrompt.includes("execution: included"), "ambient receipt should expose execution protocol inclusion");
	assert(result.systemPrompt.includes("profile software; overlays none"), "ambient receipt should include safe execution route summary");
	await harness.commands.get("status").handler("", harness.ctx);
	assert(harness.sentMessages.at(-1).content.includes("ambient execution: profile software; overlays none"), "/status should expose safe execution route metadata");
	const discussion = createTaskHarness({ bindPayload: taskBindPayload() });
	await discussion.handlers.get("session_start")({ reason: "startup" }, discussion.ctx);
	const discussionResult = await discussion.handlers.get("before_agent_start")({ prompt: "Continue discussing the execution protocol design", systemPrompt: "base" }, discussion.ctx);
	assert(!discussionResult.systemPrompt.includes("## Ambient Execution Protocol"), "discussion prompts should not include execution protocol guidance");
}
