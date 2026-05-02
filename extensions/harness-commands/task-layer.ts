import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { agentsRoot, agentsScriptPath } from "../shared/config";
export type TaskWeight = "trivial" | "standard" | "complex";
type BindAction = "created" | "claimed_existing" | "refreshed_existing" | "skipped" | "blocked" | "error";
type BindResult = {
	task_api_version?: number;
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
	task_api_version?: number;
	weight: TaskWeight;
	binding_mode: "auto" | "skip" | "reuse_only";
	reasons: string[];
};
type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type TaskApiInfo = {
	task_api_version: number;
	agents_shared_root: string;
	tasks_root: string;
	scripts_dir: string;
	capabilities: string[];
};
type ArtifactAddResult = {
	artifact_api_version?: number;
	recorded: boolean;
	reason?: string;
};
type ArtifactListResult = {
	artifact_api_version?: number;
	count: number;
};
type CandidateRootResult = {
	task_api_version: number;
	candidate: string;
	cwd: string;
	project_root: string;
	bindable: boolean;
	safe_to_auto_create: boolean;
	bootstrap_path: boolean;
	auto_create: "auto" | "never";
	reason: string;
};
type TaskLayerState = {
	sessionId: string;
	apiChecked: boolean;
	apiAvailable: boolean;
	apiInfo?: TaskApiInfo;
	currentPromptWeight: TaskWeight;
	currentBindingMode: TaskClassification["binding_mode"];
	currentPromptNeedsTask: boolean;
	meaningfulActivity: boolean;
	activity: { reads: number; writes: number; commands: number; errors: number };
	artifactCount: number;
	artifactSkipped: number;
	active?: BindResult;
	context?: string;
	lastAction?: BindAction;
	lastReason?: string;
	lastError?: string;
	lastHeartbeatAt: number;
};
const SUPPORTED_TASK_API_VERSION = 1;
const SUPPORTED_ARTIFACT_API_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 60_000;
const SCRIPT_TIMEOUT_MS = 10_000;
function emptyActivity() {
	return { reads: 0, writes: 0, commands: 0, errors: 0 };
}
function initialState(): TaskLayerState {
	return {
		sessionId: "pi-unknown-session",
		apiChecked: false,
		apiAvailable: false,
		currentPromptWeight: "standard",
		currentBindingMode: "auto",
		currentPromptNeedsTask: false,
		meaningfulActivity: false,
		activity: emptyActivity(),
		artifactCount: 0,
		artifactSkipped: 0,
		lastHeartbeatAt: 0,
	};
}
function resetSessionState(state: TaskLayerState): void {
	state.currentPromptWeight = "standard";
	state.currentBindingMode = "auto";
	state.currentPromptNeedsTask = false;
	state.meaningfulActivity = false;
	state.activity = emptyActivity();
	state.artifactCount = 0;
	state.artifactSkipped = 0;
	state.lastHeartbeatAt = 0;
}
function resetPromptState(state: TaskLayerState, fallbackWeight: TaskWeight): void {
	state.active = undefined;
	state.context = undefined;
	state.currentPromptWeight = fallbackWeight;
	state.activity = emptyActivity();
	state.artifactCount = 0;
	state.artifactSkipped = 0;
	state.meaningfulActivity = false;
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
function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}
async function runScript(pi: ExtensionAPI, scriptName: string, args: string[], cwd: string, timeout = SCRIPT_TIMEOUT_MS): Promise<ExecResult> {
	return pi.exec("bash", [agentsScriptPath(scriptName), ...args], { cwd, timeout });
}
async function ensureTaskApi(pi: ExtensionAPI, state: TaskLayerState, cwd: string): Promise<boolean> {
	if (state.apiChecked) return state.apiAvailable;
	state.apiChecked = true;
	try {
		const result = await runScript(pi, "task-api.sh", ["info"], cwd, 5_000);
		if (result.code !== 0) {
			state.lastError = shortError(result);
			return false;
		}
		const payload = parseJson<TaskApiInfo>(result.stdout);
		if (!payload || payload.task_api_version !== SUPPORTED_TASK_API_VERSION) {
			state.lastError = `unsupported AGENTS task API version: ${payload?.task_api_version ?? "unknown"}`;
			return false;
		}
		state.apiInfo = payload;
		state.apiAvailable = true;
		return true;
	} catch (error) {
		state.lastError = error instanceof Error ? error.message : String(error);
		return false;
	}
}
async function candidateRoot(pi: ExtensionAPI, candidate: string, cwd: string): Promise<CandidateRootResult | undefined> {
	try {
		const result = await runScript(pi, "task-candidate-root.sh", ["--candidate", candidate, "--cwd", cwd], cwd, 5_000);
		if (result.code !== 0) return undefined;
		const payload = parseJson<CandidateRootResult>(result.stdout);
		if (!payload || payload.task_api_version !== SUPPORTED_TASK_API_VERSION) return undefined;
		return payload;
	} catch {
		return undefined;
	}
}
async function classifyTask(pi: ExtensionAPI, prompt: string, cwd: string): Promise<TaskClassification | undefined> {
	try {
		const result = await runScript(pi, "task-classify.sh", ["--prompt-text", prompt, "--cwd", cwd], cwd, 5_000);
		if (result.code !== 0) return undefined;
		const payload = parseJson<TaskClassification>(result.stdout);
		if (!payload) return undefined;
		return payload.task_api_version === SUPPORTED_TASK_API_VERSION ? payload : undefined;
	} catch {
		return undefined;
	}
}
function bindAutoCreateMode(state: TaskLayerState, suggested: "auto" | "never"): "auto" | "never" {
	if (state.currentBindingMode === "skip" || state.currentBindingMode === "reuse_only") return "never";
	if (state.currentPromptWeight === "trivial") return "never";
	return suggested;
}
function shortError(result: ExecResult): string {
	return (result.stderr || result.stdout || `exit ${result.code}`).replace(/\s+/g, " ").trim().slice(0, 500);
}
function supportsTaskArtifacts(state: TaskLayerState): boolean {
	return Boolean(state.apiInfo?.capabilities?.includes("task_artifacts"));
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
function normalizeCandidatePath(candidate: string): string {
	let value = shellUnquote(candidate.trim()).replace(/\\([\\\s;&|])/g, "$1");
	if (value === "${HOME}") value = homedir();
	else if (value.startsWith("${HOME}/")) value = path.join(homedir(), value.slice(8));
	return value;
}
function pathFromTool(event: ToolResultEvent, fallbackCwd: string): string | undefined {
	const input = event.input ?? {};
	for (const key of ["path", "cwd"] as const) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return normalizeCandidatePath(value);
	}
	if (event.toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const cdMatch = command.match(/(?:^|[;&|])\s*cd\s+(?:--\s+)?((?:"[^"]+")|(?:'[^']+')|(?:\\.|[^\s;&|])+)/);
		if (cdMatch?.[1]) return normalizeCandidatePath(cdMatch[1]);
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
function pathArtifactFromTool(event: ToolResultEvent): { title: string; path: string } | undefined {
	if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
	if (event.isError) return undefined;
	const candidate = event.input?.path;
	if (typeof candidate !== "string" || !candidate.trim()) return undefined;
	return { title: event.toolName === "edit" ? "Edited path" : "Wrote path", path: normalizeCandidatePath(candidate) };
}
function verificationLabel(command: string): string | undefined {
	const normalized = command.replace(/\s+/g, " ").trim();
	if (/\bnpm\s+run\s+verify\b/.test(normalized)) return "npm verify";
	if (/\bnpm\s+run\s+harness:audit\b/.test(normalized)) return "harness audit";
	if (/\bnpm\s+run\s+skills:audit\b/.test(normalized)) return "skills audit";
	if (/\bmake\s+verify-(?:ci|local)\b/.test(normalized)) return "agents verify";
	if (/\bpython3?\s+-m\s+unittest\b/.test(normalized)) return "python unittest";
	if (/\bgit\s+diff\s+--check\b/.test(normalized)) return "git diff check";
	return undefined;
}
function verificationArtifactFromTool(event: ToolResultEvent): { title: string; summary: string } | undefined {
	if (event.toolName !== "bash") return undefined;
	const command = typeof event.input?.command === "string" ? event.input.command : "";
	const label = verificationLabel(command);
	if (!label) return undefined;
	const status = event.isError ? "failed" : "completed";
	return { title: `${label} ${status}`, summary: `Verification command ${status}.` };
}
export function createAgentsTaskLayer() {
	const state = initialState();
	async function bind(pi: ExtensionAPI, ctx: ExtensionContext, bindCwd: string, suggestedAutoCreate: "auto" | "never" = "auto"): Promise<BindResult | undefined> {
		const autoCreate = bindAutoCreateMode(state, suggestedAutoCreate);
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
			if (payload.task_api_version !== SUPPORTED_TASK_API_VERSION) {
				state.lastAction = "error";
				state.lastError = `task-bind returned unsupported API version: ${payload.task_api_version ?? "missing"}`;
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
			state.artifactSkipped = 0;
			await refreshArtifactCount(pi, ctx);
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
	async function refreshArtifactCount(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
		if (!state.active?.task_id || !supportsTaskArtifacts(state)) return;
		try {
			const result = await runScript(pi, "task-artifact-list.sh", [state.active.task_id, "--json", "--limit", "1"], ctx.cwd, 5_000);
			if (result.code !== 0) return;
			const payload = parseJson<ArtifactListResult>(result.stdout);
			if (payload?.artifact_api_version === SUPPORTED_ARTIFACT_API_VERSION) state.artifactCount = payload.count;
		} catch {
			// Artifact listing is best-effort; do not affect task binding.
		}
	}
	async function recordArtifact(pi: ExtensionAPI, ctx: ExtensionContext, args: string[]): Promise<void> {
		if (!state.active?.task_id || !supportsTaskArtifacts(state)) return;
		try {
			const result = await runScript(pi, "task-artifact-add.sh", [state.active.task_id, ...args, "--runtime", "pi", "--session", state.sessionId], ctx.cwd, 5_000);
			if (result.code !== 0) {
				state.artifactSkipped++;
				return;
			}
			const payload = parseJson<ArtifactAddResult>(result.stdout);
			if (payload?.artifact_api_version !== SUPPORTED_ARTIFACT_API_VERSION) {
				state.artifactSkipped++;
				return;
			}
			if (payload.recorded) state.artifactCount++;
			else state.artifactSkipped++;
		} catch {
			state.artifactSkipped++;
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
			const skipped = state.artifactSkipped ? `, ${state.artifactSkipped} skipped` : "";
			return [
				`- active task: ${state.active.task_id} (${state.lastAction ?? "bound"})`,
				`- task project: ${state.active.project_root || "unknown"}`,
				`- task runtime/session: pi / ${state.sessionId}`,
				`- task artifacts: ${state.artifactCount} recorded${skipped}`,
			];
		}
		if (state.lastAction === "skipped") return [`- active task: none (${state.lastReason || "binding skipped"})`];
		if (state.lastAction === "blocked") return [`- active task: blocked (${state.lastError || state.lastReason || "lease conflict"})`];
		if (state.lastError) return [`- active task: unavailable (${state.lastError})`];
		return ["- active task: none"];
	}
	return {
		async sessionStart(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
			state.sessionId = safeSessionId(ctx);
			resetSessionState(state);
			await ensureTaskApi(pi, state, ctx.cwd);
		},
		async beforeAgentStart(pi: ExtensionAPI, prompt: string, fallbackWeight: TaskWeight, ctx: ExtensionContext): Promise<string | undefined> {
			resetPromptState(state, fallbackWeight);
			if (!(await ensureTaskApi(pi, state, ctx.cwd))) return undefined;
			const classification = await classifyTask(pi, prompt, ctx.cwd);
			if (!classification) {
				state.lastError = "task-classify returned an unsupported AGENTS task API version";
				return undefined;
			}
			state.currentPromptWeight = classification.weight;
			state.currentBindingMode = classification.binding_mode;
			state.currentPromptNeedsTask = classification.binding_mode !== "skip" && classification.weight !== "trivial";
			if (!state.currentPromptNeedsTask) return undefined;
			const decision = await candidateRoot(pi, ctx.cwd, ctx.cwd);
			await bind(pi, ctx, decision?.project_root || ctx.cwd, decision?.auto_create || "never");
			return state.context ? contextBlock(state.context) : undefined;
		},
		async toolResult(pi: ExtensionAPI, event: ToolResultEvent, ctx: ExtensionContext): Promise<void> {
			activityFromTool(state, event);
			if (!state.active && state.currentPromptNeedsTask && state.apiAvailable) {
				const candidate = pathFromTool(event, ctx.cwd);
				const decision = candidate ? await candidateRoot(pi, candidate, ctx.cwd) : undefined;
				if (decision?.bindable) await bind(pi, ctx, decision.project_root, decision.auto_create);
			}
			const pathArtifact = pathArtifactFromTool(event);
			if (pathArtifact) {
				await recordArtifact(pi, ctx, [
					"--kind", "file_path",
					"--title", pathArtifact.title,
					"--summary", `${pathArtifact.title} during pi turn.`,
					"--path", pathArtifact.path,
					"--cwd", ctx.cwd,
				]);
			}
			const verificationArtifact = verificationArtifactFromTool(event);
			if (verificationArtifact) {
				await recordArtifact(pi, ctx, [
					"--kind", "verification_summary",
					"--title", verificationArtifact.title,
					"--summary", verificationArtifact.summary,
				]);
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
			const eventResult = await runScript(pi, "task-event.sh", args, ctx.cwd).catch((): undefined => undefined);
			if (eventResult && eventResult.code !== 0) state.lastError = shortError(eventResult);
			await runScript(pi, "task-status.sh", [state.active.task_id, "status=in_progress", "runtime=pi", `owner=${process.env.USER || "unknown"}`, "next_action=Continue from latest pi checkpoint."], ctx.cwd).catch((): undefined => undefined);
			await refreshContext(pi, ctx);
		},
		async sessionShutdown(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
			await runScript(pi, "task-gc.sh", ["--runtime", "pi", "--session", state.sessionId, "--cwd", ctx.cwd, "--no-sweep"], ctx.cwd, 8_000).catch((): undefined => undefined);
		},
		statusLines,
		currentPromptWeight(): TaskWeight {
			return state.currentPromptWeight;
		},
		ambientScope(): { taskId?: string; projectRoot?: string } {
			return { taskId: state.active?.task_id, projectRoot: state.active?.project_root };
		},
		doctorSection(): string {
			return [
				"## AGENTS task binding",
				...statusLines(),
				`- task API: ${state.apiAvailable ? `v${state.apiInfo?.task_api_version ?? "?"}` : "unavailable"}`,
				`- agents root: ${state.apiInfo?.agents_shared_root ?? agentsRoot()}`,
				`- prompt task mode: ${state.currentPromptWeight}/${state.currentBindingMode}`,
				`- current turn activity: reads ${state.activity.reads}, writes ${state.activity.writes}, commands ${state.activity.commands}, errors ${state.activity.errors}`,
				`- artifact capture: ${state.artifactCount} recorded, ${state.artifactSkipped} skipped this turn`,
				...(state.lastError ? [`- last task-layer error: ${state.lastError}`] : []),
			].join("\n");
		},
		health(): "ok" | "warning" {
			return state.lastError || state.lastAction === "blocked" ? "warning" : "ok";
		},
	};
}
