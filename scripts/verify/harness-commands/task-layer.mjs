import { agentsRoot, agentsTasksRoot, assert, createTaskHarness, homeRoot, join, root, runRealAgentsTaskLayerTest } from "./support.mjs";

export async function runTaskLayerTests() {
	const boundTask = createTaskHarness({
		bindPayload: { action: "created", bound: true, created: true, blocked: false, reason: "", task_id: "pi-task", task_dir: join(agentsTasksRoot, "pi-task"), runtime: "pi", session: "pi-session-1", project_root: root },
	});
	await boundTask.handlers.get("session_start")({ reason: "startup" }, boundTask.ctx);
	const taskPromptResult = await boundTask.handlers.get("before_agent_start")({ prompt: "Implement ambient task binding", systemPrompt: "base" }, boundTask.ctx);
	assert(taskPromptResult.systemPrompt.includes("## Active AGENTS Task Context"), "harness should inject bound AGENTS task context");
	assert(taskPromptResult.systemPrompt.includes("task_id: pi-task"), "harness should include active task id in context");
	await boundTask.handlers.get("tool_result")({ toolName: "read", input: { path: "README.md" }, isError: false }, boundTask.ctx);
	await boundTask.handlers.get("tool_result")({ toolName: "edit", input: { path: "extensions/harness-commands.ts" }, isError: false }, boundTask.ctx);
	await boundTask.handlers.get("tool_result")({ toolName: "bash", input: { command: "npm run verify" }, isError: false }, boundTask.ctx);
	await boundTask.handlers.get("agent_end")({}, boundTask.ctx);
	await boundTask.handlers.get("session_shutdown")({ reason: "quit" }, boundTask.ctx);
	const bindCall = boundTask.execCalls.find((call) => call.args[0]?.endsWith("task-bind.sh"));
	assert(bindCall && !bindCall.args.includes("--prompt-text"), "pi task binding should not persist raw prompts by default");
	const artifactCalls = boundTask.execCalls.filter((call) => call.args[0]?.endsWith("task-artifact-add.sh"));
	assert(artifactCalls.some((call) => call.args.includes("file_path") && call.args.includes("extensions/harness-commands.ts")), "pi task layer should capture edited path artifacts");
	assert(artifactCalls.some((call) => call.args.includes("verification_summary") && call.args.includes("npm verify completed")), "pi task layer should capture verification summary artifacts");
	assert(boundTask.execCalls.some((call) => call.args[0]?.endsWith("task-event.sh") && call.args.includes("checkpoint")), "pi task layer should append a checkpoint event after meaningful turns");
	assert(boundTask.execCalls.some((call) => call.args[0]?.endsWith("task-gc.sh") && call.args.includes("--no-sweep")), "pi task layer should release only current-session tasks on shutdown");

	const skippedArtifactTask = createTaskHarness({
		artifactAddPayload: { artifact_api_version: 2, recorded: false },
		bindPayload: { action: "created", bound: true, created: true, blocked: false, reason: "", task_id: "pi-task", task_dir: join(agentsTasksRoot, "pi-task"), runtime: "pi", session: "pi-session-1", project_root: root },
	});
	await skippedArtifactTask.handlers.get("session_start")({ reason: "startup" }, skippedArtifactTask.ctx);
	await skippedArtifactTask.handlers.get("before_agent_start")({ prompt: "Implement artifact accounting", systemPrompt: "base" }, skippedArtifactTask.ctx);
	await skippedArtifactTask.handlers.get("tool_result")({ toolName: "edit", input: { path: "src/foo.ts" }, isError: false }, skippedArtifactTask.ctx);
	assert(skippedArtifactTask.execCalls.some((call) => call.args[0]?.endsWith("task-artifact-add.sh")), "pi task layer should attempt artifact capture before counting skipped artifacts");
	await skippedArtifactTask.commands.get("status").handler("", skippedArtifactTask.ctx);
	assert(skippedArtifactTask.sentMessages.at(-1).content.includes("0 recorded, 1 skipped"), "pi task layer should count unsupported artifact responses as skipped");

	const incompatibleClassify = createTaskHarness({
		classifyPayload: { task_api_version: 2, weight: "standard", binding_mode: "auto", reasons: [] },
		bindPayload: { action: "created", bound: true, created: true, blocked: false, reason: "", task_id: "bad", task_dir: "/tmp/bad", runtime: "pi", session: "pi-session-1", project_root: root },
	});
	await incompatibleClassify.handlers.get("session_start")({ reason: "startup" }, incompatibleClassify.ctx);
	const incompatibleClassifyResult = await incompatibleClassify.handlers.get("before_agent_start")({ prompt: "Implement task binding", systemPrompt: "base" }, incompatibleClassify.ctx);
	assert(!incompatibleClassifyResult?.systemPrompt?.includes("## Active AGENTS Task Context"), "pi task layer should not bind when task-classify returns an incompatible API version");
	assert(!incompatibleClassify.execCalls.some((call) => call.args[0]?.endsWith("task-bind.sh")), "pi task layer should skip task-bind after incompatible classification");

	for (const [label, classifyResult] of [
		["missing version", { code: 0, stdout: JSON.stringify({ weight: "standard", binding_mode: "auto", reasons: [] }), stderr: "" }],
		["invalid JSON", { code: 0, stdout: "not json", stderr: "" }],
		["nonzero", { code: 1, stdout: "", stderr: "boom" }],
	]) {
		const badClassify = createTaskHarness({
			classifyResult,
			bindPayload: { action: "created", bound: true, created: true, blocked: false, reason: "", task_id: "bad", task_dir: "/tmp/bad", runtime: "pi", session: "pi-session-1", project_root: root },
		});
		await badClassify.handlers.get("session_start")({ reason: "startup" }, badClassify.ctx);
		await badClassify.handlers.get("before_agent_start")({ prompt: `Implement task binding with ${label}`, systemPrompt: "base" }, badClassify.ctx);
		assert(!badClassify.execCalls.some((call) => call.args[0]?.endsWith("task-bind.sh")), `pi task layer should skip task-bind after ${label} task-classify output`);
	}

	const incompatibleBind = createTaskHarness({
		bindPayload: { task_api_version: 2, action: "created", bound: true, created: true, blocked: false, reason: "", task_id: "bad", task_dir: "/tmp/bad", runtime: "pi", session: "pi-session-1", project_root: root },
	});
	await incompatibleBind.handlers.get("session_start")({ reason: "startup" }, incompatibleBind.ctx);
	const incompatibleBindResult = await incompatibleBind.handlers.get("before_agent_start")({ prompt: "Implement task binding", systemPrompt: "base" }, incompatibleBind.ctx);
	assert(!incompatibleBindResult?.systemPrompt?.includes("## Active AGENTS Task Context"), "pi task layer should not inject context when task-bind returns an incompatible API version");

	const homeTask = createTaskHarness({
		cwd: homeRoot,
		bindPayload: { action: "skipped", bound: false, created: false, blocked: false, reason: "no matching task", task_id: "", task_dir: "", runtime: "pi", session: "pi-session-home", project_root: homeRoot },
	});
	await homeTask.handlers.get("session_start")({ reason: "startup" }, homeTask.ctx);
	await homeTask.handlers.get("before_agent_start")({ prompt: "Implement a harness improvement", systemPrompt: "base" }, homeTask.ctx);
	const homeBindCall = homeTask.execCalls.find((call) => call.args[0]?.endsWith("task-bind.sh"));
	assert(homeBindCall?.args.includes("--auto-create") && homeBindCall.args[homeBindCall.args.indexOf("--auto-create") + 1] === "never", "pi task layer should not auto-create broad home-root tasks");
	await homeTask.handlers.get("tool_result")({ toolName: "read", input: { path: join(root, "README.md") }, isError: false }, homeTask.ctx);
	const lateBindCalls = homeTask.execCalls.filter((call) => call.args[0]?.endsWith("task-bind.sh"));
	const lateBindCall = lateBindCalls[lateBindCalls.length - 1];
	assert(lateBindCall.args[lateBindCall.args.indexOf("--auto-create") + 1] === "auto", "pi task layer should late-bind from concrete project file activity");

	const bootstrapTask = createTaskHarness({
		cwd: homeRoot,
		bindPayload: { action: "skipped", bound: false, created: false, blocked: false, reason: "no matching task", task_id: "", task_dir: "", runtime: "pi", session: "pi-session-home", project_root: homeRoot },
	});
	await bootstrapTask.handlers.get("session_start")({ reason: "startup" }, bootstrapTask.ctx);
	await bootstrapTask.handlers.get("before_agent_start")({ prompt: "Implement a harness improvement", systemPrompt: "base" }, bootstrapTask.ctx);
	await bootstrapTask.handlers.get("tool_result")({ toolName: "read", input: { path: join(homeRoot, "CLAUDE.md") }, isError: false }, bootstrapTask.ctx);
	await bootstrapTask.handlers.get("tool_result")({ toolName: "read", input: { path: "~/CLAUDE.md" }, isError: false }, bootstrapTask.ctx);
	await bootstrapTask.handlers.get("tool_result")({ toolName: "read", input: { path: "~/.claude/CLAUDE.md" }, isError: false }, bootstrapTask.ctx);
	await bootstrapTask.handlers.get("tool_result")({ toolName: "read", input: { path: join(agentsRoot, "skills", "SKILLS.md") }, isError: false }, bootstrapTask.ctx);
	await bootstrapTask.handlers.get("tool_result")({ toolName: "read", input: { path: join(agentsRoot, "shared", "AGENT_OPERATING_CONTRACT.md") }, isError: false }, bootstrapTask.ctx);
	assert(bootstrapTask.execCalls.filter((call) => call.args[0]?.endsWith("task-bind.sh")).length === 1, "pi task layer should not late-bind or auto-create from home bootstrap files");

	const staleTask = createTaskHarness({
		bindPayloads: [
			{ action: "created", bound: true, created: true, blocked: false, reason: "", task_id: "task-a", task_dir: join(agentsTasksRoot, "task-a"), runtime: "pi", session: "pi-session-1", project_root: root },
			{ action: "skipped", bound: false, created: false, blocked: false, reason: "home root", task_id: "", task_dir: "", runtime: "pi", session: "pi-session-1", project_root: homeRoot },
			{ action: "claimed_existing", bound: true, created: false, blocked: false, reason: "", task_id: "task-b", task_dir: join(agentsTasksRoot, "task-b"), runtime: "pi", session: "pi-session-1", project_root: root },
		],
	});
	await staleTask.handlers.get("session_start")({ reason: "startup" }, staleTask.ctx);
	await staleTask.handlers.get("before_agent_start")({ prompt: "Implement project A", systemPrompt: "base" }, staleTask.ctx);
	await staleTask.handlers.get("tool_result")({ toolName: "read", input: { path: "README.md" }, isError: false }, staleTask.ctx);
	await staleTask.handlers.get("agent_end")({}, staleTask.ctx);
	staleTask.ctx.cwd = homeRoot;
	await staleTask.handlers.get("before_agent_start")({ prompt: "Implement another harness improvement", systemPrompt: "base" }, staleTask.ctx);
	await staleTask.handlers.get("tool_result")({ toolName: "read", input: { path: join(root, "README.md") }, isError: false }, staleTask.ctx);
	await staleTask.handlers.get("agent_end")({}, staleTask.ctx);
	const staleTaskEvents = staleTask.execCalls.filter((call) => call.args[0]?.endsWith("task-event.sh"));
	assert(staleTaskEvents.at(-1).args[1] === "task-b", "pi task layer should not checkpoint a stale prior task after late-binding another project");

	const shutdownTask = createTaskHarness({
		bindPayloads: [
			{ action: "created", bound: true, created: true, blocked: false, reason: "", task_id: "task-a", task_dir: join(agentsTasksRoot, "task-a"), runtime: "pi", session: "pi-session-1", project_root: root },
			{ action: "skipped", bound: false, created: false, blocked: false, reason: "home root", task_id: "", task_dir: "", runtime: "pi", session: "pi-session-1", project_root: homeRoot },
		],
	});
	await shutdownTask.handlers.get("session_start")({ reason: "startup" }, shutdownTask.ctx);
	await shutdownTask.handlers.get("before_agent_start")({ prompt: "Implement project A", systemPrompt: "base" }, shutdownTask.ctx);
	shutdownTask.ctx.cwd = homeRoot;
	await shutdownTask.handlers.get("before_agent_start")({ prompt: "Tiny follow-up", systemPrompt: "base" }, shutdownTask.ctx);
	await shutdownTask.handlers.get("session_shutdown")({ reason: "quit" }, shutdownTask.ctx);
	assert(shutdownTask.execCalls.some((call) => call.args[0]?.endsWith("task-gc.sh") && call.args.includes("--session") && call.args.includes("pi-session-1")), "pi task layer should run current-session cleanup on shutdown even after a no-bind turn");

	await runRealAgentsTaskLayerTest();
}
