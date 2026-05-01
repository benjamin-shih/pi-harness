import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assert, loadExtension, root } from "./harness.mjs";

export async function runHarnessCommandBehaviorTests() {
	const harnessCommands = loadExtension("extensions/harness-commands.ts");
	const homeRoot = homedir();
	const agentsRoot = process.env.AGENTS_SHARED_ROOT || join(homeRoot, ".agents");
	const agentsTasksRoot = join(agentsRoot, "tasks");

	async function runRealAgentsTaskLayerTest() {
		const realAgentsRoot = agentsRoot;
		if (!existsSync(join(realAgentsRoot, "scripts", "task-api.sh"))) return;
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-agents-task-layer-"));
		const tasksRoot = join(tempRoot, "tasks");
		const projectRoot = join(tempRoot, "project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(projectRoot, "AGENTS.md"), "# test project\n");
		writeFileSync(join(projectRoot, "README.md"), "hello\n");
		const previousAgentsRoot = process.env.AGENTS_SHARED_ROOT;
		const previousTasksRoot = process.env.TASKS_ROOT;
		process.env.AGENTS_SHARED_ROOT = realAgentsRoot;
		process.env.TASKS_ROOT = tasksRoot;
		try {
			const handlers = new Map();
			harnessCommands({
				on: (event, handler) => handlers.set(event, handler),
				registerCommand: () => {},
				getAllTools: () => [],
				getActiveTools: () => ["read", "bash"],
				getThinkingLevel: () => "xhigh",
				exec: async (cmd, args, options) => {
					try {
						const stdout = execFileSync(cmd, args, { cwd: options?.cwd || projectRoot, env: process.env, encoding: "utf8", timeout: options?.timeout || 10_000 });
						return { code: 0, stdout, stderr: "", killed: false };
					} catch (error) {
						return { code: error.status ?? 1, stdout: String(error.stdout || ""), stderr: String(error.stderr || error.message || ""), killed: false };
					}
				},
				sendUserMessage: () => {},
			});
			const ctx = {
				cwd: projectRoot,
				model: { provider: "test", id: "model" },
				getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
				sessionManager: {
					getBranch: () => [],
					getSessionId: () => "real-script-session",
					getSessionFile: () => join(tempRoot, "session.jsonl"),
					getLeafId: () => undefined,
				},
			};
			await handlers.get("session_start")({ reason: "startup" }, ctx);
			const result = await handlers.get("before_agent_start")({ prompt: "Analyze real AGENTS task layer integration", systemPrompt: "base" }, ctx);
			assert(result?.systemPrompt.includes("## Active AGENTS Task Context"), "real .agents task-layer test should inject task context");
			await handlers.get("tool_result")({ toolName: "read", input: { path: join(projectRoot, "README.md") }, isError: false }, ctx);
			await handlers.get("agent_end")({}, ctx);
			await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
			const taskDirs = readdirSync(tasksRoot).filter((name) => !name.startsWith("."));
			assert(taskDirs.length === 1, "real .agents task-layer test should create exactly one temp task");
			const taskDir = join(tasksRoot, taskDirs[0]);
			const events = readFileSync(join(taskDir, "events.jsonl"), "utf8");
			assert(events.includes('"type": "checkpoint"'), "real .agents task-layer test should checkpoint through real scripts");
			const lease = JSON.parse(readFileSync(join(taskDir, "lease.json"), "utf8"));
			assert(Boolean(lease.released_at), "real .agents task-layer test should release the temp task lease on shutdown");
		} finally {
			if (previousAgentsRoot === undefined) delete process.env.AGENTS_SHARED_ROOT;
			else process.env.AGENTS_SHARED_ROOT = previousAgentsRoot;
			if (previousTasksRoot === undefined) delete process.env.TASKS_ROOT;
			else process.env.TASKS_ROOT = previousTasksRoot;
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}

	function execSnapshots(snapshots) {
		let index = 0;
		let current = snapshots[0] ?? {};
		return async (_cmd, args) => {
			const key = args.join(" ");
			if (key === "diff --numstat HEAD --") {
				current = snapshots[Math.min(index, Math.max(0, snapshots.length - 1))] ?? {};
				index++;
				return { code: 0, stdout: current.diff ?? "", stderr: "" };
			}
			if (key === "ls-files --others --exclude-standard") {
				return { code: 0, stdout: current.untracked ?? "", stderr: "" };
			}
			if (key.startsWith("diff --numstat --no-index")) {
				const file = args.at(-1);
				return { code: 1, stdout: current.untrackedNumstat?.[file] ?? "", stderr: "" };
			}
			return { code: 1, stdout: "", stderr: "" };
		};
	}

	function createHarness(snapshots) {
		const handlers = new Map();
		const sentUserMessages = [];
		harnessCommands({
			on: (event, handler) => handlers.set(event, handler),
			registerCommand: () => {},
			getAllTools: () => [],
			exec: execSnapshots(snapshots),
			sendUserMessage: (message, options) => sentUserMessages.push({ message, options }),
		});
		return {
			beforeAgentStart: handlers.get("before_agent_start"),
			toolCall: handlers.get("tool_call"),
			agentEnd: handlers.get("agent_end"),
			sentUserMessages,
		};
	}

	const basic = createHarness([]);
	const result = await basic.beforeAgentStart({ prompt: "What is the CLT?", systemPrompt: "base" }, { cwd: root });
	assert(result?.systemPrompt?.includes("## Display Math Rendering"), "harness should inject displaymath rendering guidance");
	assert(result.systemPrompt.includes("\\begin{displaymath}"), "harness should ask agents to use displaymath delimiters");
	assert(result.systemPrompt.includes("instead of `\\[`"), "harness should discourage bracket display delimiters");
	assert(result.systemPrompt.includes("## Markdown Heading Rendering"), "harness should inject Markdown heading rendering guidance");
	assert(result.systemPrompt.includes("use only `#` and `##` Markdown headings"), "harness should steer agents away from deeper Markdown headings");
	assert(result.systemPrompt.includes("instead of `###`"), "harness should recommend bold labels instead of raw level-3 headings");
	assert(!result.systemPrompt.includes("## Post-Change Cleanup Gate"), "harness should not inject cleanup guidance for non-coding prompts");

	const previousSkillsRootForPrompt = process.env.AGENTS_SKILLS_ROOT;
	try {
		process.env.AGENTS_SKILLS_ROOT = "/tmp/pi-custom-skills";
		const routed = createHarness([]);
		const routedResult = await routed.beforeAgentStart({ prompt: "Implement config cleanup", systemPrompt: "base" }, { cwd: root });
		assert(routedResult.systemPrompt.includes("/tmp/pi-custom-skills/SKILLS.md"), "skill-routing guidance should honor AGENTS_SKILLS_ROOT");
	} finally {
		if (previousSkillsRootForPrompt === undefined) delete process.env.AGENTS_SKILLS_ROOT;
		else process.env.AGENTS_SKILLS_ROOT = previousSkillsRootForPrompt;
	}

	const statusCommands = new Map();
	const statusMessages = [];
	const promptSizing = {
		promptChars: 1000,
		conversationChars: 2000,
		turnPrefixChars: 0,
		previousSummaryChars: 0,
		customInstructionsChars: 0,
		gitStatusChars: 0,
		messagesToSummarize: 2,
		turnPrefixMessages: 0,
		tokensBefore: 1234,
		promptBudgetChars: 120000,
		maxSummaryTokens: 8192,
		isSplitTurn: false,
		firstKeptEntryId: "entry-1",
	};
	const statusBranch = [
		{
			type: "custom",
			customType: "ben-continuity-checkpoint",
			data: {
				version: 1,
				reason: "agent_end",
				timestamp: "2026-04-30T00:00:00.000Z",
				cwd: root,
				prompt: "Add doctor and memory diagnostics.",
				filesRead: ["README.md"],
				filesModified: ["extensions/harness-commands.ts"],
				commands: [{ command: "npm run verify", status: "ok" }],
				toolErrors: [],
			},
		},
		{
			type: "compaction",
			timestamp: "2026-04-30T00:05:00.000Z",
			tokensBefore: 1234,
			firstKeptEntryId: "entry-1",
			details: { source: "ben-pi-harness/session-continuity", version: 1, promptSizing },
		},
		{
			type: "custom",
			customType: "ben-continuity-compaction-diagnostic",
			data: {
				version: 1,
				timestamp: "2026-04-30T00:10:00.000Z",
				reason: "exception",
				cwd: root,
				error: "context_length_exceeded",
				fallbackReturned: true,
				promptSizing,
			},
		},
	];
	harnessCommands({
		on: () => {},
		registerCommand: (name, command) => statusCommands.set(name, command),
		getAllTools: () => [],
		getActiveTools: () => ["read", "bash"],
		getThinkingLevel: () => "xhigh",
		exec: async (_cmd, args) => {
			const key = args.join(" ");
			if (key === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "" };
			if (key === "status --porcelain=v1 --untracked-files=all") return { code: 0, stdout: "", stderr: "" };
			if (key === "scripts/harness-audit.mjs --json" || key.endsWith("scripts/harness-audit.mjs --json")) {
				return {
					code: 0,
					stdout: JSON.stringify({ root, packageVersion: "0.2.0", metrics: { runtimeExtensionEntrypoints: 4, extensionLoc: 2000, optionalLatexLoc: 1300 }, issues: [], warnings: [] }),
					stderr: "",
				};
			}
			return { code: 1, stdout: "", stderr: "" };
		},
		sendMessage: (message) => statusMessages.push(message),
	});
	const commandCtx = {
		cwd: root,
		model: { provider: "test", id: "model" },
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		sessionManager: { getBranch: () => statusBranch },
	};
	assert(typeof statusCommands.get("doctor")?.handler === "function", "harness should register /doctor");
	assert(typeof statusCommands.get("doct")?.handler === "function", "harness should register /doct alias");
	assert(typeof statusCommands.get("memory")?.handler === "function", "harness should register /memory");
	await statusCommands.get("status").handler("", commandCtx);
	assert(statusMessages[0].content.includes("harness audit: ok"), "/status should include harness audit health");
	assert(statusMessages[0].content.includes("runtime extensions: 4"), "/status should include runtime extension count");
	assert(statusMessages[0].content.includes("memory spine: warning"), "/status should include compact memory-spine health");
	await statusCommands.get("doctor").handler("", commandCtx);
	assert(statusMessages[1].customType === "harness-doctor", "/doctor should send a harness doctor message");
	assert(statusMessages[1].content.includes("## Harness doctor"), "/doctor should render a doctor report");
	assert(statusMessages[1].content.includes("package: ben-pi-harness 0.2.0"), "/doctor should include package version");
	assert(statusMessages[1].content.includes("latest diagnostic"), "/doctor should include memory-spine diagnostics");
	await statusCommands.get("memory").handler("", commandCtx);
	assert(statusMessages[2].customType === "harness-memory", "/memory should send a memory diagnostics message");
	assert(statusMessages[2].content.includes("latest diagnostic error: context_length_exceeded"), "/memory should include latest diagnostic errors");

	function createTaskHarness({ bindPayload, bindPayloads, classifyPayload, classifyResult, cwd = root }) {
		const handlers = new Map();
		const execCalls = [];
		const queuedBindPayloads = [...(bindPayloads ?? [])];
		harnessCommands({
			on: (event, handler) => handlers.set(event, handler),
			registerCommand: () => {},
			getAllTools: () => [],
			getActiveTools: () => ["read"],
			getThinkingLevel: () => "xhigh",
			exec: async (cmd, args, options) => {
				execCalls.push({ cmd, args, cwd: options?.cwd });
				const script = args[0] || "";
				if (cmd === "bash" && script.endsWith("task-api.sh")) return { code: 0, stdout: JSON.stringify({ task_api_version: 1, agents_shared_root: agentsRoot, tasks_root: agentsTasksRoot, scripts_dir: join(agentsRoot, "scripts"), capabilities: ["candidate_root_policy", "task_artifacts"] }), stderr: "" };
				if (cmd === "bash" && script.endsWith("task-classify.sh")) {
					if (classifyResult) return classifyResult;
					return { code: 0, stdout: JSON.stringify({ task_api_version: 1, ...(classifyPayload ?? { weight: "standard", binding_mode: "auto", reasons: [] }) }), stderr: "" };
				}
				if (cmd === "bash" && script.endsWith("task-candidate-root.sh")) {
					const candidate = args[args.indexOf("--candidate") + 1] || cwd;
					const candidateCwd = args[args.indexOf("--cwd") + 1] || cwd;
					const target = candidate === "~" ? homeRoot : (candidate.startsWith("~/") ? join(homeRoot, candidate.slice(2)) : (candidate.startsWith("/") ? candidate : join(candidateCwd, candidate)));
					const isBootstrap = target === join(homeRoot, "CLAUDE.md") || target.startsWith(join(homeRoot, ".claude")) || target.startsWith(join(agentsRoot, "skills")) || target.startsWith(join(agentsRoot, "shared"));
					const isProject = target.startsWith(root);
					return { code: 0, stdout: JSON.stringify({ task_api_version: 1, candidate: target, cwd: candidateCwd, project_root: isProject ? root : homeRoot, bindable: isProject && !isBootstrap, safe_to_auto_create: isProject && !isBootstrap, bootstrap_path: isBootstrap, auto_create: isProject && !isBootstrap ? "auto" : "never", reason: isProject && !isBootstrap ? "project_path" : (isBootstrap ? "bootstrap_path" : "home_root") }), stderr: "" };
				}
				if (cmd === "bash" && script.endsWith("task-bind.sh")) return { code: 0, stdout: JSON.stringify({ task_api_version: 1, ...(queuedBindPayloads.length ? queuedBindPayloads.shift() : bindPayload) }), stderr: "" };
				if (cmd === "bash" && script.endsWith("task-context.sh")) return { code: 0, stdout: "Active task context\n- task_id: pi-task\n- next_action: Continue", stderr: "" };
				if (cmd === "bash" && script.endsWith("task-heartbeat.sh")) return { code: 0, stdout: "", stderr: "" };
				if (cmd === "bash" && script.endsWith("task-event.sh")) return { code: 0, stdout: JSON.stringify({ type: "checkpoint" }), stderr: "" };
				if (cmd === "bash" && script.endsWith("task-artifact-list.sh")) return { code: 0, stdout: JSON.stringify({ artifact_api_version: 1, task_id: args[1], count: 0, artifacts: [] }), stderr: "" };
				if (cmd === "bash" && script.endsWith("task-artifact-add.sh")) return { code: 0, stdout: JSON.stringify({ artifact_api_version: 1, task_id: args[1], recorded: true, artifact: { id: "artifact-1" } }), stderr: "" };
				if (cmd === "bash" && script.endsWith("task-status.sh")) return { code: 0, stdout: "{}", stderr: "" };
				if (cmd === "bash" && script.endsWith("task-gc.sh")) return { code: 0, stdout: "released: pi-task", stderr: "" };
				return { code: 1, stdout: "", stderr: "" };
			},
			sendUserMessage: () => {},
		});
		const ctx = {
			cwd,
			model: { provider: "test", id: "model" },
			getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
			sessionManager: {
				getBranch: () => [],
				getSessionId: () => "session-1",
				getSessionFile: () => join(root, ".test-session.jsonl"),
				getLeafId: () => undefined,
			},
		};
		return { handlers, execCalls, ctx };
	}

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

	const major = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "140\t90\textensions/harness-commands.ts\n30\t5\tscripts/verify.mjs\n", untracked: "" },
	]);
	const codingResult = await major.beforeAgentStart({ prompt: "Fix bug in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	assert(codingResult.systemPrompt.includes("## Post-Change Cleanup Gate"), "harness should inject cleanup guidance for coding prompts");
	assert(codingResult.systemPrompt.includes("remove code made obsolete"), "cleanup guidance should require obsolete-code removal");
	await major.toolCall({ toolName: "edit", input: { path: "src/foo.ts" } }, {});
	await major.agentEnd({}, { cwd: root });
	assert(major.sentUserMessages.length === 1, "harness should send a one-shot cleanup guard after major mutating diffs");
	assert(major.sentUserMessages[0].message.includes("PI_CLEANUP_GUARD"), "cleanup guard should be marked to prevent loops");
	assert(major.sentUserMessages[0].message.includes("gpt-5.2"), "cleanup guard should call out stale model/version identifiers");
	assert(major.sentUserMessages[0].options?.deliverAs === "followUp", "cleanup guard should be delivered as a follow-up turn");

	const continuation = createHarness([{ diff: "", untracked: "" }]);
	const continuationResult = await continuation.beforeAgentStart({ prompt: "Go ahead and do this", systemPrompt: "base" }, { cwd: root });
	assert(continuationResult.systemPrompt.includes("## Post-Change Cleanup Gate"), "harness should inject cleanup guidance for execution follow-up prompts");

	const unchanged = createHarness([
		{ diff: "200\t20\tsrc/existing.ts\n", untracked: "" },
		{ diff: "200\t20\tsrc/existing.ts\n", untracked: "" },
	]);
	await unchanged.beforeAgentStart({ prompt: "Fix bug in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	await unchanged.toolCall({ toolName: "bash", input: { command: "npm run verify" } }, {});
	await unchanged.agentEnd({}, { cwd: root });
	assert(unchanged.sentUserMessages.length === 0, "cleanup guard should not fire when a broad command leaves the git diff unchanged");

	const preExistingTiny = createHarness([
		{ diff: "200\t20\tsrc/existing.ts\n", untracked: "" },
		{ diff: "200\t20\tsrc/existing.ts\n1\t0\tsrc/tiny.ts\n", untracked: "" },
	]);
	await preExistingTiny.beforeAgentStart({ prompt: "Fix bug in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	await preExistingTiny.toolCall({ toolName: "edit", input: { path: "src/tiny.ts" } }, {});
	await preExistingTiny.agentEnd({}, { cwd: root });
	assert(preExistingTiny.sentUserMessages.length === 0, "cleanup guard should score only this-turn diff growth, not pre-existing large diffs");

	const fourTinyFiles = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "1\t0\tdocs/a.md\n1\t0\tdocs/b.md\n1\t0\tdocs/c.md\n1\t0\tdocs/d.md\n", untracked: "" },
	]);
	await fourTinyFiles.beforeAgentStart({ prompt: "Update docs and config files", systemPrompt: "base" }, { cwd: root });
	await fourTinyFiles.toolCall({ toolName: "edit", input: { path: "docs/a.md" } }, {});
	await fourTinyFiles.agentEnd({}, { cwd: root });
	assert(fourTinyFiles.sentUserMessages.length === 0, "cleanup guard should not treat four tiny file edits as major");

	const untracked = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "", untracked: "src/new.ts\n", untrackedNumstat: { "src/new.ts": "250\t0\tsrc/new.ts\n" } },
	]);
	await untracked.beforeAgentStart({ prompt: "Fix bug in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	await untracked.toolCall({ toolName: "write", input: { path: "src/new.ts" } }, {});
	await untracked.agentEnd({}, { cwd: root });
	assert(untracked.sentUserMessages.length === 1, "cleanup guard should account for large untracked source files");
	assert(untracked.sentUserMessages[0].message.includes("untracked"), "cleanup guard diff summary should mention untracked files");

	const smallUntracked = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "", untracked: "src/small.ts\n", untrackedNumstat: { "src/small.ts": "1\t0\tsrc/small.ts\n" } },
	]);
	await smallUntracked.beforeAgentStart({ prompt: "Fix bug in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	await smallUntracked.toolCall({ toolName: "write", input: { path: "src/small.ts" } }, {});
	await smallUntracked.agentEnd({}, { cwd: root });
	assert(smallUntracked.sentUserMessages.length === 0, "cleanup guard should not treat a tiny untracked source file as major");

	const replaceSmall = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "1\t0\tsrc/foo.ts\n", untracked: "" },
	]);
	await replaceSmall.beforeAgentStart({ prompt: "Replace the old helper in src/foo.ts", systemPrompt: "base" }, { cwd: root });
	await replaceSmall.toolCall({ toolName: "edit", input: { path: "src/foo.ts" } }, {});
	await replaceSmall.agentEnd({}, { cwd: root });
	assert(replaceSmall.sentUserMessages.length === 0, "cleanup guard should not treat every small replace/cleanup prompt as major");

	const complexSmall = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "1\t0\tsrc/foo.ts\n", untracked: "" },
	]);
	const longScopedPrompt = `Update src/foo.ts. ${"Keep this scoped and preserve behavior. ".repeat(30)}`;
	await complexSmall.beforeAgentStart({ prompt: longScopedPrompt, systemPrompt: "base" }, { cwd: root });
	await complexSmall.toolCall({ toolName: "edit", input: { path: "src/foo.ts" } }, {});
	await complexSmall.agentEnd({}, { cwd: root });
	assert(complexSmall.sentUserMessages.length === 0, "cleanup guard should not treat every complex prompt with a tiny diff as major");

	const loop = createHarness([
		{ diff: "", untracked: "" },
		{ diff: "140\t90\textensions/harness-commands.ts\n", untracked: "" },
	]);
	await loop.beforeAgentStart({ prompt: "PI_CLEANUP_GUARD: run cleanup for this code change", systemPrompt: "base" }, { cwd: root });
	await loop.toolCall({ toolName: "edit", input: { path: "src/foo.ts" } }, {});
	await loop.agentEnd({}, { cwd: root });
	assert(loop.sentUserMessages.length === 0, "cleanup guard should not recursively trigger itself");

	await runRealAgentsTaskLayerTest();
}
