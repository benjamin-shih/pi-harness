import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@mariozechner/pi-coding-agent";

export type TaskWeight = "trivial" | "standard" | "complex";

type BindAction = "created" | "claimed_existing" | "refreshed_existing" | "skipped" | "blocked" | "error";

type BindResult = {
	action: BindAction;
	bound: boolean;
	created: boolean;
	blocked: boolean;
	reason: string;
	task_id: string;
	task_dir: string;
	runtime: string;
	session: string;
	project_root: string;
};

type TaskClassification = {
	weight: TaskWeight;
	binding_mode: "auto" | "skip" | "reuse_only";
	reasons: string[];
};

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

type TaskLayerState = {
	sessionId: string;
	currentPromptWeight: TaskWeight;
	currentBindingMode: TaskClassification["binding_mode"];
	currentPromptNeedsTask: boolean;
	meaningfulActivity: boolean;
	activity: { reads: number; writes: number; commands: number; errors: number };
	active?: BindResult;
	context?: string;
	lastAction?: BindAction;
	lastReason?: string;
	lastError?: string;
	lastHeartbeatAt: number;
};

const AGENTS_ROOT = "/Users/benjaminshih/.agents";
const SCRIPTS_DIR = path.join(AGENTS_ROOT, "scripts");
const HOME = path.dirname(AGENTS_ROOT);
const HEARTBEAT_INTERVAL_MS = 60_000;
const SCRIPT_TIMEOUT_MS = 10_000;

function emptyActivity() {
	return { reads: 0, writes: 0, commands: 0, errors: 0 };
}

function initialState(): TaskLayerState {
	return {
		sessionId: "pi-unknown-session",
		currentPromptWeight: "standard",
		currentBindingMode: "auto",
		currentPromptNeedsTask: false,
		meaningfulActivity: false,
		activity: emptyActivity(),
		lastHeartbeatAt: 0,
	};
}

function scriptPath(name: string): string {
	return path.join(SCRIPTS_DIR, name);
}

function modelSummary(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function safeSessionId(ctx: ExtensionContext): string {
	try {
		const id = ctx.sessionManager.getSessionId();
		if (id) return `pi-${id}`;
	} catch {
		// Fall back below.
	}
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (sessionFile) return `pi-${path.basename(sessionFile).replace(/[^A-Za-z0-9_-]/g, "-")}`;
	return `pi-${process.pid}`;
}

function isHomePath(candidate: string): boolean {
	return path.resolve(candidate) === path.resolve(HOME);
}

function isInsidePath(candidate: string, parent: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isBootstrapPath(candidate: string): boolean {
	const resolved = path.resolve(candidate);
	return (
		resolved === path.join(HOME, "CLAUDE.md") ||
		resolved === path.join(HOME, ".pi", "agent", "AGENTS.md") ||
		isInsidePath(resolved, path.join(HOME, ".claude")) ||
		isInsidePath(resolved, path.join(HOME, ".agents", "skills")) ||
		isInsidePath(resolved, path.join(HOME, ".agents", "shared"))
	);
}

function fallbackClassification(weight: TaskWeight): TaskClassification {
	return { weight, binding_mode: weight === "trivial" ? "skip" : "auto", reasons: ["pi harness fallback classification"] };
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

async function runScript(pi: ExtensionAPI, scriptName: string, args: string[], cwd: string, timeout = SCRIPT_TIMEOUT_MS): Promise<ExecResult> {
	return pi.exec("bash", [scriptPath(scriptName), ...args], { cwd, timeout });
}

async function classifyTask(pi: ExtensionAPI, prompt: string, cwd: string, fallbackWeight: TaskWeight): Promise<TaskClassification> {
	try {
		const result = await runScript(pi, "task-classify.sh", ["--prompt-text", prompt, "--cwd", cwd], cwd, 5_000);
		if (result.code !== 0) return fallbackClassification(fallbackWeight);
		return parseJson<TaskClassification>(result.stdout) ?? fallbackClassification(fallbackWeight);
	} catch {
		return fallbackClassification(fallbackWeight);
	}
}

async function resolveProjectRoot(pi: ExtensionAPI, candidate: string, cwd: string): Promise<string | undefined> {
	try {
		const result = await runScript(pi, "resolve-project-root.sh", [candidate], cwd, 5_000);
		if (result.code !== 0) return undefined;
		return result.stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

function bindAutoCreateMode(state: TaskLayerState, bindCwd: string): "auto" | "never" {
	if (state.currentBindingMode === "skip" || state.currentBindingMode === "reuse_only") return "never";
	if (state.currentPromptWeight === "trivial") return "never";
	return isHomePath(bindCwd) ? "never" : "auto";
}

function shortError(result: ExecResult): string {
	return (result.stderr || result.stdout || `exit ${result.code}`).replace(/\s+/g, " ").trim().slice(0, 500);
}

function contextBlock(context: string): string {
	return [
		"## Active AGENTS Task Context",
		context,
		"",
		"Harness guidance:",
		"- Treat the active `.agents/tasks/<task-id>/` package as canonical operational state for this work.",
		"- Do not create parallel task notes when this context is present; use the existing task and let the harness checkpoint automatically.",
		"- If durable decisions, questions, lessons, or repo-convention candidates arise, mention them clearly in the final response so they can be promoted or captured in the next artifact layer.",
	].join("\n");
}

function shellUnquote(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

function normalizeCandidatePath(candidate: string, cwd: string): string {
	let p = shellUnquote(candidate.trim());
	if (p === "~") p = HOME;
	else if (p.startsWith("~/")) p = path.join(HOME, p.slice(2));
	else if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
	return p;
}

function pathFromTool(event: ToolResultEvent, fallbackCwd: string): string | undefined {
	const input = event.input ?? {};
	for (const key of ["path", "cwd"] as const) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return normalizeCandidatePath(value, fallbackCwd);
	}
	if (event.toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const cdMatch = command.match(/(?:^|[;&|])\s*cd\s+((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)/);
		if (cdMatch?.[1]) return normalizeCandidatePath(cdMatch[1], fallbackCwd);
	}
	return fallbackCwd;
}

function activityFromTool(state: TaskLayerState, event: ToolResultEvent): void {
	if (event.toolName === "read" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") state.activity.reads++;
	else if (event.toolName === "edit" || event.toolName === "write") state.activity.writes++;
	else if (event.toolName === "bash") state.activity.commands++;
	if (event.isError) state.activity.errors++;
	state.meaningfulActivity ||= Boolean(state.activity.reads || state.activity.writes || state.activity.commands || state.activity.errors);
}

export function createAgentsTaskLayer() {
	const state = initialState();

	async function bind(pi: ExtensionAPI, ctx: ExtensionContext, bindCwd: string): Promise<BindResult | undefined> {
		const autoCreate = bindAutoCreateMode(state, bindCwd);
		try {
			const args = [
				"--runtime", "pi",
				"--session", state.sessionId,
				"--owner", process.env.USER || "unknown",
				"--cwd", bindCwd,
				"--task-weight", state.currentPromptWeight,
				"--auto-create", autoCreate,
			];
			const model = modelSummary(ctx);
			if (model) args.push("--model", model);
			const result = await runScript(pi, "task-bind.sh", args, ctx.cwd);
			if (result.code !== 0) {
				state.lastAction = "error";
				state.lastError = shortError(result);
				return undefined;
			}
			const payload = parseJson<BindResult>(result.stdout);
			if (!payload) {
				state.lastAction = "error";
				state.lastError = "task-bind returned invalid JSON";
				return undefined;
			}
			state.lastAction = payload.action;
			state.lastReason = payload.reason;
			state.lastError = undefined;
			if (!payload.bound) {
				if (payload.blocked) state.lastError = payload.reason;
				return payload;
			}
			state.active = payload;
			await refreshContext(pi, ctx, payload.task_id, bindCwd);
			return payload;
		} catch (error) {
			state.lastAction = "error";
			state.lastError = error instanceof Error ? error.message : String(error);
			return undefined;
		}
	}

	async function refreshContext(pi: ExtensionAPI, ctx: ExtensionContext, taskId = state.active?.task_id, cwd = ctx.cwd): Promise<void> {
		if (!taskId) return;
		try {
			const result = await runScript(pi, "task-context.sh", ["--task-id", taskId, "--cwd", cwd, "--max-events", "5"], ctx.cwd);
			if (result.code === 0) state.context = result.stdout.trim();
			else state.lastError = shortError(result);
		} catch (error) {
			state.lastError = error instanceof Error ? error.message : String(error);
		}
	}

	async function heartbeat(pi: ExtensionAPI, ctx: ExtensionContext, force = false): Promise<void> {
		if (!state.active?.task_id) return;
		const now = Date.now();
		if (!force && now - state.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
		state.lastHeartbeatAt = now;
		try {
			await runScript(pi, "task-heartbeat.sh", [state.active.task_id, "--session", state.sessionId], ctx.cwd, 5_000);
		} catch {
			// Heartbeat is best-effort; do not block the user turn.
		}
	}

	function statusLines(): string[] {
		if (state.active?.task_id) {
			return [
				`- active task: ${state.active.task_id} (${state.lastAction ?? "bound"})`,
				`- task project: ${state.active.project_root || "unknown"}`,
				`- task runtime/session: pi / ${state.sessionId}`,
			];
		}
		if (state.lastAction === "skipped") return [`- active task: none (${state.lastReason || "binding skipped"})`];
		if (state.lastAction === "blocked") return [`- active task: blocked (${state.lastError || state.lastReason || "lease conflict"})`];
		if (state.lastError) return [`- active task: unavailable (${state.lastError})`];
		return ["- active task: none"];
	}

	return {
		async sessionStart(_pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
			state.sessionId = safeSessionId(ctx);
			state.currentPromptWeight = "standard";
			state.currentBindingMode = "auto";
			state.currentPromptNeedsTask = false;
			state.meaningfulActivity = false;
			state.activity = emptyActivity();
			state.lastHeartbeatAt = 0;
		},

		async beforeAgentStart(pi: ExtensionAPI, prompt: string, fallbackWeight: TaskWeight, ctx: ExtensionContext): Promise<string | undefined> {
			state.active = undefined;
			state.context = undefined;
			state.currentPromptWeight = fallbackWeight;
			state.activity = emptyActivity();
			state.meaningfulActivity = false;
			const classification = await classifyTask(pi, prompt, ctx.cwd, fallbackWeight);
			state.currentPromptWeight = classification.weight;
			state.currentBindingMode = classification.binding_mode;
			state.currentPromptNeedsTask = classification.binding_mode !== "skip" && classification.weight !== "trivial";
			if (!state.currentPromptNeedsTask) return undefined;
			await bind(pi, ctx, ctx.cwd);
			return state.context ? contextBlock(state.context) : undefined;
		},

		async toolResult(pi: ExtensionAPI, event: ToolResultEvent, ctx: ExtensionContext): Promise<void> {
			activityFromTool(state, event);
			if (!state.active && state.currentPromptNeedsTask) {
				const candidate = pathFromTool(event, ctx.cwd);
				if (candidate && !isBootstrapPath(candidate)) {
					const projectRoot = await resolveProjectRoot(pi, candidate, ctx.cwd);
					if (projectRoot && !isHomePath(projectRoot)) await bind(pi, ctx, projectRoot);
				}
			}
			await heartbeat(pi, ctx);
		},

		async agentEnd(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
			if (!state.active?.task_id || !state.meaningfulActivity) return;
			await heartbeat(pi, ctx, true);
			const args = [
				state.active.task_id,
				"checkpoint",
				"runtime=pi",
				`session=${state.sessionId}`,
				"note=pi agent turn completed",
				`reads=${state.activity.reads}`,
				`writes=${state.activity.writes}`,
				`commands=${state.activity.commands}`,
				`errors=${state.activity.errors}`,
			];
			const eventResult = await runScript(pi, "task-event.sh", args, ctx.cwd).catch(() => undefined);
			if (eventResult && eventResult.code !== 0) state.lastError = shortError(eventResult);
			await runScript(pi, "task-status.sh", [state.active.task_id, "status=in_progress", "runtime=pi", `owner=${process.env.USER || "unknown"}`, "next_action=Continue from latest pi checkpoint."], ctx.cwd).catch(() => undefined);
			await refreshContext(pi, ctx);
		},

		async sessionShutdown(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
			await runScript(pi, "task-gc.sh", ["--runtime", "pi", "--session", state.sessionId, "--cwd", ctx.cwd, "--no-sweep"], ctx.cwd, 8_000).catch(() => undefined);
		},

		statusLines,

		doctorSection(): string {
			return [
				"## AGENTS task binding",
				...statusLines(),
				`- prompt task mode: ${state.currentPromptWeight}/${state.currentBindingMode}`,
				`- current turn activity: reads ${state.activity.reads}, writes ${state.activity.writes}, commands ${state.activity.commands}, errors ${state.activity.errors}`,
				...(state.lastError ? [`- last task-layer error: ${state.lastError}`] : []),
			].join("\n");
		},

		health(): "ok" | "warning" {
			return state.lastError || state.lastAction === "blocked" ? "warning" : "ok";
		},
	};
}
