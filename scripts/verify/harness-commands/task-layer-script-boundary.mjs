import { assert, agentsRoot, createTaskHarness, homeRoot, join, root, taskBindPayload } from "./support.mjs";

const result = (stdout, code = 0, stderr = "") => ({ code, stdout, stderr });
const jsonResult = (payload) => result(JSON.stringify(payload));
const nonzero = (stderr) => result("", 1, stderr);

function calls(harness, scriptName) {
	return harness.execCalls.filter((call) => call.args[0]?.endsWith(scriptName));
}

function hasCall(harness, scriptName) {
	return calls(harness, scriptName).length > 0;
}

function autoCreateMode(call) {
	return call?.args[call.args.indexOf("--auto-create") + 1];
}

function assertNoRawPromptArg(harness, prompt) {
	assert(!harness.execCalls.some((call) => call.args.includes(prompt)), "task-layer script args should not include raw prompt text");
	assert(!calls(harness, "task-bind.sh").some((call) => call.args.includes("--prompt-text")), "task-bind should not receive raw prompt text");
}

export async function runTaskLayerScriptBoundaryTests() {
	for (const [label, bindResult] of [
		["nonzero", nonzero("bind failed")],
		["malformed", result("not json")],
		["missing version", jsonResult(taskBindPayload({ task_api_version: undefined, task_id: "bad" }))],
	]) {
		const prompt = `Implement bind boundary ${label}`;
		const bindFailure = createTaskHarness({ scriptResults: { "task-bind.sh": bindResult }, bindPayload: taskBindPayload() });
		await bindFailure.handlers.get("session_start")({ reason: "startup" }, bindFailure.ctx);
		const promptResult = await bindFailure.handlers.get("before_agent_start")({ prompt, systemPrompt: "base" }, bindFailure.ctx);
		assert(!promptResult?.systemPrompt?.includes("## Active AGENTS Task Context"), `task layer should not inject context after ${label} task-bind output`);
		assert(!hasCall(bindFailure, "task-context.sh"), `task layer should not fetch context after ${label} task-bind output`);
		assert(!hasCall(bindFailure, "task-event.sh") && !hasCall(bindFailure, "task-status.sh"), `task layer should not checkpoint after ${label} task-bind output`);
		assertNoRawPromptArg(bindFailure, prompt);
		await bindFailure.commands.get("status").handler("", bindFailure.ctx);
		assert(bindFailure.sentMessages.at(-1).content.includes("active task: unavailable"), `/status should report unavailable task after ${label} task-bind output`);
	}

	for (const [label, candidateResult] of [
		["nonzero", nonzero("candidate failed")],
		["malformed", result("not json")],
		["incompatible", jsonResult({ task_api_version: 2, project_root: root, bindable: true, auto_create: "auto" })],
	]) {
		const candidateFailure = createTaskHarness({ scriptResults: { "task-candidate-root.sh": candidateResult }, bindPayload: taskBindPayload() });
		await candidateFailure.handlers.get("session_start")({ reason: "startup" }, candidateFailure.ctx);
		await candidateFailure.handlers.get("before_agent_start")({ prompt: `Implement candidate root ${label}`, systemPrompt: "base" }, candidateFailure.ctx);
		const bindCall = calls(candidateFailure, "task-bind.sh").at(-1);
		assert(autoCreateMode(bindCall) === "never", `initial ${label} candidate-root output should fall back to reuse-only binding`);
	}

	const lateCandidateFailure = createTaskHarness({
		cwd: homeRoot,
		bindPayload: taskBindPayload({ action: "skipped", bound: false, reason: "no matching task", task_id: "", project_root: homeRoot }),
		scriptResults: { "task-candidate-root.sh": [jsonResult({ task_api_version: 1, project_root: homeRoot, bindable: false, auto_create: "never" }), nonzero("late candidate failed")] },
	});
	await lateCandidateFailure.handlers.get("session_start")({ reason: "startup" }, lateCandidateFailure.ctx);
	await lateCandidateFailure.handlers.get("before_agent_start")({ prompt: "Implement late candidate failure", systemPrompt: "base" }, lateCandidateFailure.ctx);
	await lateCandidateFailure.handlers.get("tool_result")({ toolName: "read", input: { path: join(root, "README.md") }, isError: false }, lateCandidateFailure.ctx);
	assert(calls(lateCandidateFailure, "task-bind.sh").length === 1, "late candidate-root failure should not trigger a late bind");

	const contextFailure = createTaskHarness({ scriptResults: { "task-context.sh": nonzero("context failed") }, bindPayload: taskBindPayload() });
	await contextFailure.handlers.get("session_start")({ reason: "startup" }, contextFailure.ctx);
	const contextResult = await contextFailure.handlers.get("before_agent_start")({ prompt: "Implement context failure", systemPrompt: "base" }, contextFailure.ctx);
	assert(!contextResult?.systemPrompt?.includes("## Active AGENTS Task Context"), "task-context failure should not inject a stale context block");
	await contextFailure.commands.get("status").handler("", contextFailure.ctx);
	assert(contextFailure.sentMessages.at(-1).content.includes("active task: pi-task"), "task-context failure should leave the bound task visible");
	await contextFailure.commands.get("doctor").handler("", contextFailure.ctx);
	assert(contextFailure.sentMessages.at(-1).content.includes("context failed"), "/doctor should expose task-context failure diagnostics");

	const noArtifactCapability = createTaskHarness({
		scriptResults: { "task-api.sh": jsonResult({ task_api_version: 1, agents_shared_root: agentsRoot, tasks_root: join(agentsRoot, "tasks"), scripts_dir: join(agentsRoot, "scripts"), capabilities: ["candidate_root_policy"] }) },
		bindPayload: taskBindPayload(),
	});
	await noArtifactCapability.handlers.get("session_start")({ reason: "startup" }, noArtifactCapability.ctx);
	const noArtifactResult = await noArtifactCapability.handlers.get("before_agent_start")({ prompt: "Implement without artifact capability", systemPrompt: "base" }, noArtifactCapability.ctx);
	assert(noArtifactResult?.systemPrompt?.includes("## Active AGENTS Task Context"), "binding should still work without artifact capability");
	await noArtifactCapability.handlers.get("tool_result")({ toolName: "edit", input: { path: "src/no-artifacts.ts" }, isError: false }, noArtifactCapability.ctx);
	assert(!hasCall(noArtifactCapability, "task-artifact-list.sh") && !hasCall(noArtifactCapability, "task-artifact-add.sh"), "task layer should not call artifact scripts without the artifact capability");

	for (const [label, artifactListResult] of [
		["nonzero", nonzero("artifact list failed")],
		["malformed", result("not json")],
	]) {
		const artifactListFailure = createTaskHarness({ scriptResults: { "task-artifact-list.sh": artifactListResult }, bindPayload: taskBindPayload() });
		await artifactListFailure.handlers.get("session_start")({ reason: "startup" }, artifactListFailure.ctx);
		const artifactListPrompt = await artifactListFailure.handlers.get("before_agent_start")({ prompt: `Implement artifact list ${label}`, systemPrompt: "base" }, artifactListFailure.ctx);
		assert(artifactListPrompt?.systemPrompt?.includes("## Active AGENTS Task Context"), `binding should survive ${label} artifact-list output`);
		await artifactListFailure.commands.get("status").handler("", artifactListFailure.ctx);
		assert(artifactListFailure.sentMessages.at(-1).content.includes("0 recorded"), `artifact count should remain safe after ${label} artifact-list output`);
	}

	for (const [label, artifactAddResult] of [
		["nonzero", nonzero("artifact add failed")],
		["malformed", result("not json")],
	]) {
		const artifactAddFailure = createTaskHarness({ scriptResults: { "task-artifact-add.sh": artifactAddResult }, bindPayload: taskBindPayload() });
		await artifactAddFailure.handlers.get("session_start")({ reason: "startup" }, artifactAddFailure.ctx);
		await artifactAddFailure.handlers.get("before_agent_start")({ prompt: `Implement artifact add ${label}`, systemPrompt: "base" }, artifactAddFailure.ctx);
		await artifactAddFailure.handlers.get("tool_result")({ toolName: "edit", input: { path: "src/artifact.ts" }, isError: false }, artifactAddFailure.ctx);
		await artifactAddFailure.commands.get("status").handler("", artifactAddFailure.ctx);
		assert(artifactAddFailure.sentMessages.at(-1).content.includes("0 recorded, 1 skipped"), `artifact skip count should increment after ${label} artifact-add output`);
	}

	const postTurnFailure = createTaskHarness({
		bindPayload: taskBindPayload(),
		scriptResults: {
			"task-heartbeat.sh": () => { throw new Error("heartbeat failed"); },
			"task-event.sh": nonzero("event failed"),
			"task-status.sh": () => { throw new Error("status failed"); },
			"task-gc.sh": nonzero("gc failed"),
		},
	});
	await postTurnFailure.handlers.get("session_start")({ reason: "startup" }, postTurnFailure.ctx);
	await postTurnFailure.handlers.get("before_agent_start")({ prompt: "Implement post-turn boundary failures", systemPrompt: "base" }, postTurnFailure.ctx);
	await postTurnFailure.handlers.get("tool_result")({ toolName: "read", input: { path: "README.md" }, isError: false }, postTurnFailure.ctx);
	await postTurnFailure.handlers.get("agent_end")({}, postTurnFailure.ctx);
	await postTurnFailure.handlers.get("session_shutdown")({ reason: "quit" }, postTurnFailure.ctx);
	assert(hasCall(postTurnFailure, "task-event.sh") && hasCall(postTurnFailure, "task-status.sh") && hasCall(postTurnFailure, "task-gc.sh"), "post-turn best-effort scripts should still be attempted after boundary failures");
	await postTurnFailure.commands.get("doctor").handler("", postTurnFailure.ctx);
	assert(postTurnFailure.sentMessages.at(-1).content.includes("event failed"), "/doctor should expose task-event failure diagnostics");
}
