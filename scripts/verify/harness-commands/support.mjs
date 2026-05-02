import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assert, loadExtension, root, withEnv } from "../harness.mjs";

export { assert, root, withEnv, join };

export const harnessCommands = loadExtension("extensions/harness-commands.ts");
export const homeRoot = homedir();
export const agentsRoot = process.env.AGENTS_SHARED_ROOT || join(homeRoot, ".agents");
export const agentsTasksRoot = join(agentsRoot, "tasks");

export async function runRealAgentsTaskLayerTest() {
	const realAgentsRoot = agentsRoot;
	if (!existsSync(join(realAgentsRoot, "scripts", "task-api.sh"))) return;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-agents-task-layer-"));
	const tasksRoot = join(tempRoot, "tasks");
	const projectRoot = join(tempRoot, "project");
	mkdirSync(projectRoot, { recursive: true });
	writeFileSync(join(projectRoot, "AGENTS.md"), "# test project\n");
	writeFileSync(join(projectRoot, "README.md"), "hello\n");
	try {
		await withEnv({ AGENTS_SHARED_ROOT: realAgentsRoot, TASKS_ROOT: tasksRoot }, async () => {
			const handlers = new Map();
			harnessCommands({
				on: (event, handler) => handlers.set(event, handler),
				registerCommand: () => {},
				getAllTools: () => [],
				getActiveTools: () => ["read", "bash"],
				getThinkingLevel: () => "xhigh",
				exec: async (cmd, args, options) => {
					try {
						if (cmd === "git" && args.join(" ") === "rev-parse --show-toplevel") return { code: 0, stdout: `${projectRoot}\n`, stderr: "", killed: false };
						if (cmd === "git" && args.join(" ") === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "", killed: false };
						if (cmd === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=no") return { code: 0, stdout: "", stderr: "", killed: false };
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
		});
	} finally {
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
		if (key === "rev-parse HEAD") {
			return { code: 0, stdout: `${current.head ?? "HEAD0"}\n`, stderr: "" };
		}
		if (key.startsWith("diff --numstat ") && key.endsWith(" --") && key !== "diff --numstat HEAD --") {
			const range = args[2];
			return { code: 0, stdout: current.committedDiffs?.[range] ?? "", stderr: "" };
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

export function createHarness(snapshots) {
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

export function createTaskHarness({ bindPayload, bindPayloads, classifyPayload, classifyResult, artifactAddPayload, cwd = root }) {
	const handlers = new Map();
	const commands = new Map();
	const sentMessages = [];
	const execCalls = [];
	const queuedBindPayloads = [...(bindPayloads ?? [])];
	harnessCommands({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
		getAllTools: () => [],
		getActiveTools: () => ["read"],
		getThinkingLevel: () => "xhigh",
		exec: async (cmd, args, options) => {
			execCalls.push({ cmd, args, cwd: options?.cwd });
			if (cmd === "git" && args.join(" ") === "rev-parse --show-toplevel") return { code: 0, stdout: `${root}\n`, stderr: "" };
			if (cmd === "git" && args.join(" ") === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "" };
			if (cmd === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=no") return { code: 0, stdout: "", stderr: "" };
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
			if (cmd === "bash" && script.endsWith("task-artifact-add.sh")) return { code: 0, stdout: JSON.stringify(artifactAddPayload ?? { artifact_api_version: 1, task_id: args[1], recorded: true, artifact: { id: "artifact-1" } }), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-status.sh")) return { code: 0, stdout: "{}", stderr: "" };
			if (cmd === "bash" && script.endsWith("task-gc.sh")) return { code: 0, stdout: "released: pi-task", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
		sendUserMessage: () => {},
		sendMessage: (message) => sentMessages.push(message),
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
	return { handlers, commands, sentMessages, execCalls, ctx };
}
