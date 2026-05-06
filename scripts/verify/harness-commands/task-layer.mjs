import { existsSync } from "node:fs";
import { agentsRoot, assert, createTaskHarness, harnessCommands, homeRoot, join, root, runRealAgentsTaskLayerTest, taskBindPayload, taskLifecyclePayload, taskRetentionPayload, withEnv } from "./support.mjs";

export async function runTaskLayerTests() {
	await withEnv({ PI_SUBAGENT_CHILD: "1" }, async () => {
		const handlers = new Map();
		const commands = new Map();
		harnessCommands({
			on: (event, handler) => handlers.set(event, handler),
			registerCommand: (name, command) => commands.set(name, command),
		});
		assert(handlers.size === 0 && commands.size === 0, "harness commands should not register ambient handlers or slash commands inside subagent children");
	});

	const boundTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		lifecyclePayload: taskLifecyclePayload({ lease: { state: "live", runtime: "secret-runtime", owner: "secret-owner", session: "secret-lifecycle-session", expires_at: "2026-05-05T00:00:00Z" } }),
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
	const classifyCall = boundTask.execCalls.find((call) => call.args[0]?.endsWith("task-classify.sh"));
	const promptFile = classifyCall?.args[classifyCall.args.indexOf("--prompt-file") + 1];
	assert(classifyCall?.args.includes("--prompt-file"), "pi task classification should pass prompt text through a temporary prompt file");
	assert(!classifyCall?.args.includes("--prompt-text"), "pi task classification should not pass raw prompts through argv");
	assert(!classifyCall?.args.includes("Implement ambient task binding"), "pi task classification argv should not include raw prompt text");
	assert(promptFile && !existsSync(promptFile), "pi task classification should clean up the temporary prompt file");
	const bindCall = boundTask.execCalls.find((call) => call.args[0]?.endsWith("task-bind.sh"));
	assert(bindCall && !bindCall.args.includes("--prompt-text"), "pi task binding should not persist raw prompts by default");
	const artifactCalls = boundTask.execCalls.filter((call) => call.args[0]?.endsWith("task-artifact-add.sh"));
	assert(artifactCalls.some((call) => call.args.includes("file_path") && call.args.includes("extensions/harness-commands.ts")), "pi task layer should capture edited path artifacts");
	assert(artifactCalls.some((call) => call.args.includes("verification_summary") && call.args.includes("npm verify completed")), "pi task layer should capture verification summary artifacts");
	assert(boundTask.execCalls.some((call) => call.args[0]?.endsWith("task-event.sh") && call.args.includes("checkpoint")), "pi task layer should append a checkpoint event after meaningful turns");
	assert(boundTask.execCalls.some((call) => call.args[0]?.endsWith("task-gc.sh") && call.args.includes("--no-sweep")), "pi task layer should release only current-session tasks on shutdown");
	await boundTask.commands.get("doctor").handler("", boundTask.ctx);
	const doctorText = boundTask.sentMessages.at(-1).content;
	assert(doctorText.includes("## AGENTS task lifecycle"), "/doctor should include shared lifecycle diagnostics for the active task");
	assert(doctorText.includes("lifecycle API: ok (v1)"), "/doctor should report task lifecycle API health");
	assert(doctorText.includes("lifecycle status: in_progress (active)"), "/doctor should include bounded lifecycle status");
	assert(doctorText.includes("lifecycle route: pi / review=none / effort=standard / handoff_required=false"), "/doctor should include bounded route lifecycle metadata");
	assert(doctorText.includes("## AGENTS task retention"), "/doctor should include shared retention diagnostics");
	assert(doctorText.includes("retention API: ok (v1)"), "/doctor should report retention API health");
	assert(doctorText.includes("retention scope: project; destructive actions disabled"), "/doctor should show retention policy without enabling cleanup");
	assert(doctorText.includes("task packages: 3 scoped; 1 active, 2 terminal, 1 stale"), "/doctor should include bounded task-package retention counts");
	assert(doctorText.includes("artifact indexes: 2 indexes, 7 records, 512 bytes, 0 oversized"), "/doctor should include bounded artifact-index counts");
	assert(doctorText.includes("archive: available; 1 candidates, 2 archived scoped"), "/doctor should include bounded archive availability and counts");
	assert(doctorText.includes("archive delete: available; 1 candidates, 1 skipped"), "/doctor should include bounded archived-bundle delete availability and counts");
	assert(boundTask.execCalls.some((call) => call.args[0]?.endsWith("task-retention.sh") && call.args.includes("--cwd")), "/doctor should call shared retention diagnostics with project cwd");
	for (const secret of ["secret-runtime", "secret-owner", "secret-lifecycle-session"]) {
		assert(!doctorText.includes(secret), "/doctor lifecycle diagnostics should not expose lease holder details");
	}

	const retentionPrivacyTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		retentionPayload: taskRetentionPayload({
			summary: {
				...taskRetentionPayload().summary,
				artifact_records: 11,
			},
			secret_task_id: "secret-retention-task",
			secret_path: "/private/project/secret-file",
		}),
	});
	await retentionPrivacyTask.handlers.get("session_start")({ reason: "startup" }, retentionPrivacyTask.ctx);
	await retentionPrivacyTask.handlers.get("before_agent_start")({ prompt: "Review retention privacy", systemPrompt: "base" }, retentionPrivacyTask.ctx);
	await retentionPrivacyTask.commands.get("doctor").handler("", retentionPrivacyTask.ctx);
	const retentionPrivacyDoctor = retentionPrivacyTask.sentMessages.at(-1).content;
	assert(retentionPrivacyDoctor.includes("artifact indexes: 2 indexes, 11 records"), "/doctor should render bounded retention counts");
	assert(retentionPrivacyDoctor.includes("2 archived scoped"), "/doctor should render bounded archive counts");
	assert(!retentionPrivacyDoctor.includes("secret-retention-task"), "/doctor should not render task ids from unexpected retention payload fields");
	assert(!retentionPrivacyDoctor.includes("secret-file"), "/doctor should not render paths from unexpected retention payload fields");

	const legacyRetentionTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		retentionPayload: {
			policy: { destructive_actions: false },
			summary: {
				task_packages_total: 2,
				task_packages_scoped: 1,
				active_tasks: 1,
				terminal_tasks: 0,
				stale_tasks: 0,
			},
		},
	});
	await legacyRetentionTask.handlers.get("session_start")({ reason: "startup" }, legacyRetentionTask.ctx);
	await legacyRetentionTask.handlers.get("before_agent_start")({ prompt: "Review legacy retention payload", systemPrompt: "base" }, legacyRetentionTask.ctx);
	await legacyRetentionTask.commands.get("doctor").handler("", legacyRetentionTask.ctx);
	const legacyRetentionDoctor = legacyRetentionTask.sentMessages.at(-1).content;
	assert(!legacyRetentionDoctor.includes("NaN"), "/doctor should render missing same-version retention fields as zero instead of NaN");
	assert(legacyRetentionDoctor.includes("archive delete: unavailable; 0 candidates, 0 skipped"), "/doctor should degrade optional archive-delete counts to zero for older retention payloads");

	const retentionUnavailableTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		scriptResults: { "task-retention.sh": { code: 1, stdout: "", stderr: "private retention error" } },
	});
	await retentionUnavailableTask.handlers.get("session_start")({ reason: "startup" }, retentionUnavailableTask.ctx);
	await retentionUnavailableTask.handlers.get("before_agent_start")({ prompt: "Review unavailable retention", systemPrompt: "base" }, retentionUnavailableTask.ctx);
	await retentionUnavailableTask.commands.get("doctor").handler("", retentionUnavailableTask.ctx);
	const retentionUnavailableDoctor = retentionUnavailableTask.sentMessages.at(-1).content;
	assert(retentionUnavailableDoctor.includes("retention API: unavailable (script_error)"), "/doctor should degrade safely when retention diagnostics fail");
	assert(!retentionUnavailableDoctor.includes("private retention error"), "/doctor retention diagnostics should not expose script stderr");

	const terminalLifecycleTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		lifecyclePayload: taskLifecyclePayload({ status: "completed", terminal: true, active: false, closed_at: "2026-05-05T00:00:00Z", has_closure_reason: true, lease: { state: "expired", runtime: "pi", owner: "tester", session: "secret-lifecycle-session", expires_at: "2026-05-05T00:00:00Z" } }),
	});
	await terminalLifecycleTask.handlers.get("session_start")({ reason: "startup" }, terminalLifecycleTask.ctx);
	await terminalLifecycleTask.handlers.get("before_agent_start")({ prompt: "Review completed task lifecycle", systemPrompt: "base" }, terminalLifecycleTask.ctx);
	await terminalLifecycleTask.commands.get("doctor").handler("", terminalLifecycleTask.ctx);
	const terminalDoctor = terminalLifecycleTask.sentMessages.at(-1).content;
	assert(terminalDoctor.includes("lifecycle status: completed (terminal)"), "/doctor should show terminal lifecycle state from the shared API");
	assert(terminalDoctor.includes("lifecycle closure reason: recorded"), "/doctor should not print raw closure reason text");

	const lifecycleUnavailableTask = createTaskHarness({
		bindPayload: taskBindPayload(),
		scriptResults: { "task-lifecycle.sh": { code: 1, stdout: "", stderr: "private lifecycle error" } },
	});
	await lifecycleUnavailableTask.handlers.get("session_start")({ reason: "startup" }, lifecycleUnavailableTask.ctx);
	await lifecycleUnavailableTask.handlers.get("before_agent_start")({ prompt: "Review unavailable task lifecycle", systemPrompt: "base" }, lifecycleUnavailableTask.ctx);
	await lifecycleUnavailableTask.commands.get("doctor").handler("", lifecycleUnavailableTask.ctx);
	const lifecycleUnavailableDoctor = lifecycleUnavailableTask.sentMessages.at(-1).content;
	assert(lifecycleUnavailableDoctor.includes("lifecycle API: unavailable (script_error)"), "/doctor should degrade safely when lifecycle diagnostics fail");
	assert(!lifecycleUnavailableDoctor.includes("private lifecycle error"), "/doctor lifecycle diagnostics should not expose script stderr");

	const skippedArtifactTask = createTaskHarness({
		artifactAddPayload: { artifact_api_version: 2, recorded: false },
		bindPayload: taskBindPayload(),
	});
	await skippedArtifactTask.handlers.get("session_start")({ reason: "startup" }, skippedArtifactTask.ctx);
	await skippedArtifactTask.handlers.get("before_agent_start")({ prompt: "Implement artifact accounting", systemPrompt: "base" }, skippedArtifactTask.ctx);
	await skippedArtifactTask.handlers.get("tool_result")({ toolName: "edit", input: { path: "src/foo.ts" }, isError: false }, skippedArtifactTask.ctx);
	assert(skippedArtifactTask.execCalls.some((call) => call.args[0]?.endsWith("task-artifact-add.sh")), "pi task layer should attempt artifact capture before counting skipped artifacts");
	await skippedArtifactTask.commands.get("status").handler("", skippedArtifactTask.ctx);
	assert(skippedArtifactTask.sentMessages.at(-1).content.includes("0 recorded, 1 skipped"), "pi task layer should count unsupported artifact responses as skipped");

	for (const [label, taskApiResult] of [
		["nonzero", { code: 1, stdout: "", stderr: "task api unavailable" }],
		["incompatible", { code: 0, stdout: JSON.stringify({ task_api_version: 2, agents_shared_root: agentsRoot, capabilities: [] }), stderr: "" }],
		["malformed", { code: 0, stdout: "not json", stderr: "" }],
	]) {
		const unavailableTaskApi = createTaskHarness({ scriptResults: { "task-api.sh": taskApiResult }, bindPayload: taskBindPayload() });
		await unavailableTaskApi.handlers.get("session_start")({ reason: "startup" }, unavailableTaskApi.ctx);
		const result = await unavailableTaskApi.handlers.get("before_agent_start")({ prompt: `Implement task binding with ${label} task API`, systemPrompt: "base" }, unavailableTaskApi.ctx);
		assert(!result?.systemPrompt?.includes("## Active AGENTS Task Context"), `pi task layer should not inject context after ${label} task-api output`);
		for (const scriptName of ["task-classify.sh", "task-candidate-root.sh", "task-bind.sh", "task-context.sh"]) {
			assert(!unavailableTaskApi.execCalls.some((call) => call.args[0]?.endsWith(scriptName)), `pi task layer should not call ${scriptName} after ${label} task-api output`);
		}
		await unavailableTaskApi.commands.get("status").handler("", unavailableTaskApi.ctx);
		assert(unavailableTaskApi.sentMessages.at(-1).content.includes("state    unavailable"), `/status should report unavailable task binding after ${label} task-api output`);
	}

	const recoveredTaskApi = createTaskHarness({
		scriptResults: {
			"task-api.sh": [
				{ code: 1, stdout: "", stderr: "task api warming up" },
				{ code: 0, stdout: JSON.stringify({ task_api_version: 1, agents_shared_root: agentsRoot, capabilities: ["candidate_root_policy", "task_artifacts", "task_lifecycle", "task_retention_diagnostics"] }), stderr: "" },
			],
		},
		bindPayload: taskBindPayload(),
	});
	await recoveredTaskApi.handlers.get("session_start")({ reason: "startup" }, recoveredTaskApi.ctx);
	const recoveredTaskApiResult = await recoveredTaskApi.handlers.get("before_agent_start")({ prompt: "Implement task binding after transient API startup failure", systemPrompt: "base" }, recoveredTaskApi.ctx);
	assert(recoveredTaskApiResult?.systemPrompt?.includes("## Active AGENTS Task Context"), "pi task layer should retry a failed task-api check and recover within the same session");
	assert(recoveredTaskApi.execCalls.filter((call) => call.args[0]?.endsWith("task-api.sh")).length === 2, "pi task layer should cache successful task-api checks but retry transient failures");

	const incompatibleClassify = createTaskHarness({
		classifyPayload: { task_api_version: 2, weight: "standard", binding_mode: "auto" },
		bindPayload: taskBindPayload({ task_id: "bad" }),
	});
	await incompatibleClassify.handlers.get("session_start")({ reason: "startup" }, incompatibleClassify.ctx);
	const incompatibleClassifyResult = await incompatibleClassify.handlers.get("before_agent_start")({ prompt: "Implement task binding", systemPrompt: "base" }, incompatibleClassify.ctx);
	assert(!incompatibleClassifyResult?.systemPrompt?.includes("## Active AGENTS Task Context"), "pi task layer should not bind when task-classify returns an incompatible API version");
	assert(!incompatibleClassify.execCalls.some((call) => call.args[0]?.endsWith("task-bind.sh")), "pi task layer should skip task-bind after incompatible classification");

	for (const [label, classifyResult] of [
		["missing version", { code: 0, stdout: JSON.stringify({ weight: "standard", binding_mode: "auto" }), stderr: "" }],
		["invalid JSON", { code: 0, stdout: "not json", stderr: "" }],
		["nonzero", { code: 1, stdout: "", stderr: "boom" }],
	]) {
		const badClassify = createTaskHarness({
			classifyResult,
			bindPayload: taskBindPayload({ task_id: "bad" }),
		});
		await badClassify.handlers.get("session_start")({ reason: "startup" }, badClassify.ctx);
		await badClassify.handlers.get("before_agent_start")({ prompt: `Implement task binding with ${label}`, systemPrompt: "base" }, badClassify.ctx);
		assert(!badClassify.execCalls.some((call) => call.args[0]?.endsWith("task-bind.sh")), `pi task layer should skip task-bind after ${label} task-classify output`);
	}

	const incompatibleBind = createTaskHarness({
		bindPayload: taskBindPayload({ task_api_version: 2, task_id: "bad" }),
	});
	await incompatibleBind.handlers.get("session_start")({ reason: "startup" }, incompatibleBind.ctx);
	const incompatibleBindResult = await incompatibleBind.handlers.get("before_agent_start")({ prompt: "Implement task binding", systemPrompt: "base" }, incompatibleBind.ctx);
	assert(!incompatibleBindResult?.systemPrompt?.includes("## Active AGENTS Task Context"), "pi task layer should not inject context when task-bind returns an incompatible API version");

	const blockedTask = createTaskHarness({
		bindPayload: taskBindPayload({ action: "blocked", bound: false, blocked: true, reason: "lease held by another pi session", task_id: "" }),
	});
	await blockedTask.handlers.get("session_start")({ reason: "startup" }, blockedTask.ctx);
	const blockedResult = await blockedTask.handlers.get("before_agent_start")({ prompt: "Implement blocked task binding", systemPrompt: "base" }, blockedTask.ctx);
	assert(!blockedResult?.systemPrompt?.includes("## Active AGENTS Task Context"), "pi task layer should not inject task context after a blocked bind");
	await blockedTask.handlers.get("tool_result")({ toolName: "read", input: { path: "README.md" }, isError: false }, blockedTask.ctx);
	await blockedTask.handlers.get("agent_end")({}, blockedTask.ctx);
	const blockedBindCalls = blockedTask.execCalls.filter((call) => call.args[0]?.endsWith("task-bind.sh"));
	assert(blockedBindCalls.length === 1, "pi task layer should not retry task-bind in the same turn after a blocked lease conflict");
	assert(!blockedTask.execCalls.some((call) => call.args[0]?.endsWith("task-event.sh")), "pi task layer should not checkpoint an unbound blocked task");
	assert(!blockedTask.execCalls.some((call) => call.args[0]?.endsWith("task-status.sh")), "pi task layer should not update task status for an unbound blocked task");
	await blockedTask.commands.get("status").handler("", blockedTask.ctx);
	assert(blockedTask.sentMessages.at(-1).content.includes("state    blocked"), "/status should keep blocked bind state visible");
	assert(blockedTask.sentMessages.at(-1).content.includes("lease held by another pi session"), "/status should keep the blocked bind reason visible");

	const homeTask = createTaskHarness({
		cwd: homeRoot,
		bindPayload: taskBindPayload({ action: "skipped", bound: false, reason: "no matching task", task_id: "", project_root: homeRoot }),
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
		bindPayload: taskBindPayload({ action: "skipped", bound: false, reason: "no matching task", task_id: "", project_root: homeRoot }),
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
			taskBindPayload({ task_id: "task-a" }),
			taskBindPayload({ action: "skipped", bound: false, reason: "home root", task_id: "", project_root: homeRoot }),
			taskBindPayload({ action: "claimed_existing", task_id: "task-b" }),
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
			taskBindPayload({ task_id: "task-a" }),
			taskBindPayload({ action: "skipped", bound: false, reason: "home root", task_id: "", project_root: homeRoot }),
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
