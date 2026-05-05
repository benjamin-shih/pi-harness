import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadExtensionModule } from "../harness.mjs";
import { agentsRoot, assert, createTaskHarness, executionRoutePayload, root, taskBindPayload } from "./support.mjs";

export async function runExecutionGuidanceTests() {
	const execution = loadExtensionModule("extensions/shared/execution-guidance.ts");
	const execCalls = [];
	const pi = {
		exec: async (cmd, args, options) => {
			execCalls.push({ cmd, args, options });
			const promptFileIndex = args.indexOf("--prompt-file");
			const promptFile = promptFileIndex >= 0 ? args[promptFileIndex + 1] : undefined;
			assert(promptFile && existsSync(promptFile), "execution route adapter should pass prompt through a private temp file");
			assert(!args.includes("Go ahead and implement the plan"), "execution route adapter should not pass raw prompt text on argv");
			return { code: 0, stdout: JSON.stringify(executionRoutePayload({ overlays: ["repo_cleanup"], summary: "profile software; overlays repo_cleanup" })), stderr: "" };
		},
	};
	const route = await execution.buildExecutionGuidance(pi, "/tmp/project", "Go ahead and implement the plan");
	assert(route?.summary === "profile software; overlays repo_cleanup", "execution guidance should consume shared route script output");
	assert(execCalls.at(-1).args[0].endsWith("execution-route.sh"), "execution guidance should call the .agents execution-route script");
	assert(execCalls.at(-1).args.includes("--cwd"), "execution guidance should pass cwd to shared route script");

	const noIntent = await execution.buildExecutionGuidance({ exec: async () => ({ code: 0, stdout: JSON.stringify({ execution_route_api_version: 1, execution_intent: false, profile: null, overlays: [], summary: "", guidance: "" }), stderr: "" }) }, "/tmp/project", "What does this do?");
	assert(!noIntent, "non-execution script results should skip ambient execution guidance");
	const incompatible = await execution.buildExecutionGuidance({ exec: async () => ({ code: 0, stdout: JSON.stringify({ execution_route_api_version: 999, execution_intent: true }), stderr: "" }) }, "/tmp/project", "Go ahead");
	assert(!incompatible, "incompatible execution-route API versions should degrade without blocking");

	const realScript = join(agentsRoot, "scripts", "execution-route.sh");
	if (existsSync(realScript)) {
		const realPi = {
			exec: async (cmd, args, options) => {
				try {
					const stdout = execFileSync(cmd, args, { cwd: options?.cwd, env: process.env, encoding: "utf8", timeout: options?.timeout || 10_000 });
					return { code: 0, stdout, stderr: "" };
				} catch (error) {
					return { code: error.status ?? 1, stdout: String(error.stdout || ""), stderr: String(error.stderr || error.message || "") };
				}
			},
		};
		const realRoute = await execution.buildExecutionGuidance(realPi, root, "Task: Simplify the recently changed code");
		assert(realRoute?.summary === "profile software; overlays repo_cleanup", "real .agents execution-route script should support wrapped execution prompts");
	}

	const harness = createTaskHarness({
		bindPayload: taskBindPayload(),
		executionPayload: executionRoutePayload({ overlays: ["repo_cleanup"], summary: "profile software; overlays repo_cleanup", guidance: "## Ambient Execution Protocol\nSubagent topology contract\nAutomatically commit and push" }),
	});
	assert(!harness.commands.has("execute"), "ambient execution protocol should not add an /execute command yet");
	await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
	const result = await harness.handlers.get("before_agent_start")({ prompt: "Simplify the recently changed code. Preserve observable behavior.", systemPrompt: "base" }, harness.ctx);
	assert(result.systemPrompt.includes("## Ambient Execution Protocol"), "execution prompts should include ambient execution protocol guidance");
	assert(result.systemPrompt.includes("execution: included"), "ambient receipt should expose execution protocol inclusion");
	assert(result.systemPrompt.includes("profile software; overlays repo_cleanup"), "ambient receipt should include safe execution route summary");
	await harness.commands.get("status").handler("", harness.ctx);
	assert(harness.sentMessages.at(-1).content.includes("exec     profile software; overlays repo_cleanup"), "/status should expose safe execution route metadata");

	const discussion = createTaskHarness({ bindPayload: taskBindPayload() });
	await discussion.handlers.get("session_start")({ reason: "startup" }, discussion.ctx);
	const discussionResult = await discussion.handlers.get("before_agent_start")({ prompt: "Continue discussing the execution protocol design", systemPrompt: "base" }, discussion.ctx);
	assert(!discussionResult.systemPrompt.includes("## Ambient Execution Protocol"), "discussion prompts should not include execution protocol guidance when the shared route script returns no intent");
}
