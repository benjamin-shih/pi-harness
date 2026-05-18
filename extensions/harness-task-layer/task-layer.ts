import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { modelSummary } from "../session-continuity/context";
import { agentsRoot } from "../shared/config";
import { parseJson } from "../shared/json";
import { withPrivateTempTextFile } from "../shared/private-temp";
import type { FinalTaskVisibility } from "../shared/final-visibility";
import type { OrchestrationDecision } from "../shared/orchestration-guidance";
import type { TaskWeight } from "../shared/prompt-guidance";
import { candidateRoot, classifyTask, discoverTask, ensureTaskApi, runScript, shortError } from "./task-layer-api";
import { activityFromTool, pathArtifactFromTool, pathFromTool, verificationArtifactFromTool } from "./task-layer-artifacts";
import { retentionSection } from "./task-layer-retention";
import {
	HEARTBEAT_INTERVAL_MS,
	SUPPORTED_ARTIFACT_API_VERSION,
	SUPPORTED_TASK_API_VERSION,
	emptyActivity,
	supportsTaskArtifacts,
	supportsTaskClose,
	supportsTaskLifecycle,
	type ArtifactAddResult,
	type ArtifactListResult,
	type BindResult,
	type OrchestrationTrackingState,
	type TaskCloseResult,
	type TaskLayerState,
	type TaskLifecycleResult,
} from "./task-layer-types";
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
		artifactRecordedThisTurn: 0,
		artifactSkipped: 0,
		lastHeartbeatAt: 0,
	};
}
function resetSessionState(state: TaskLayerState): void {
	state.active = undefined;
	state.discovered = undefined;
	state.context = undefined;
	state.currentPromptWeight = "standard";
	state.currentBindingMode = "auto";
	state.currentPromptNeedsTask = false;
	state.meaningfulActivity = false;
	state.activity = emptyActivity();
	state.artifactCount = 0;
	state.artifactRecordedThisTurn = 0;
	state.artifactSkipped = 0;
	state.lastHeartbeatAt = 0;
	state.orchestration = undefined;
}
function resetPromptState(state: TaskLayerState, fallbackWeight: TaskWeight): void {
	state.active = undefined;
	state.discovered = undefined;
	state.context = undefined;
	state.currentPromptWeight = fallbackWeight;
	state.currentPromptNeedsTask = false;
	state.activity = emptyActivity();
	state.artifactCount = 0;
	state.artifactRecordedThisTurn = 0;
	state.artifactSkipped = 0;
	state.meaningfulActivity = false;
	state.orchestration = undefined;
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
function bindAutoCreateMode(state: TaskLayerState, suggested: "auto" | "never"): "auto" | "never" {
	if (state.currentBindingMode === "skip" || state.currentBindingMode === "reuse_only") return "never";
	if (state.currentPromptWeight === "trivial") return "never";
	return suggested;
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
				if (payload.blocked) {
					state.currentPromptNeedsTask = false;
					state.lastError = payload.reason;
				}
				return payload;
			}
			state.active = payload;
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
	async function refreshDiscoveredTaskScope(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
		if (state.active?.task_id) return;
		const payload = await discoverTask(pi, ctx.cwd, state.sessionId);
		if (payload?.found && !payload.blocked && payload.task_id) {
			state.discovered = { task_id: payload.task_id, project_root: payload.task_project_root || payload.project_root || ctx.cwd };
		} else {
			state.discovered = undefined;
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
			if (payload.recorded) {
				state.artifactCount++;
				state.artifactRecordedThisTurn++;
			} else state.artifactSkipped++;
		} catch {
			state.artifactSkipped++;
		}
	}
	function refreshOrchestrationMismatch(tracking: OrchestrationTrackingState): OrchestrationTrackingState {
		tracking.mismatch = Boolean(tracking.recommendedTopology && tracking.chosenTopology && tracking.recommendedTopology !== tracking.chosenTopology);
		return tracking;
	}
	function orchestrationStatusLine(): string | undefined {
		const tracking = state.orchestration;
		if (!tracking?.recommendedTopology && !tracking?.chosenTopology) return undefined;
		const recommended = tracking.recommendedTopology || "none";
		const chosen = tracking.chosenTopology || "none";
		const mismatch = tracking.mismatch ? "yes" : "no";
		return `- orchestration: recommended ${recommended}; chosen ${chosen}; mismatch ${mismatch}`;
	}
	function orchestrationSummaryLines(): string[] {
		const line = orchestrationStatusLine(), tracking = state.orchestration;
		if (!line || !tracking) return ["- orchestration: no session-local choice recorded"];
		let explanation = "latest recommendation has no explicit chosen topology", action = "follow the advisory recommendation or record an explicit choice";
		if (tracking.recommendedTopology && tracking.chosenTopology) {
			explanation = tracking.mismatch ? "explicit choice differs from the latest session-local recommendation" : "explicit choice matches the latest session-local recommendation";
			action = tracking.mismatch ? "reconfirm topology or record a new choice" : "proceed under the chosen topology";
		} else if (tracking.chosenTopology) {
			explanation = "chosen topology exists without a current session-local recommendation"; action = "refresh run-card before relying on the choice";
		}
		return [line, `- orchestration explanation: ${explanation}`, `- orchestration action: ${action}`, "- orchestration pairing: session-local view; use /control-center for decision-id stale-choice checks"];
	}
	function orchestrationEventArgs(decision: OrchestrationDecision): string[] {
		return [
			`decision_id=${JSON.stringify((decision as { decision_id?: string }).decision_id || "")}`,
			`recommended_topology=${JSON.stringify(decision.topology.recommended || "")}`,
			`task_shape=${JSON.stringify(decision.task.shape || "")}`,
			`complexity=${JSON.stringify(decision.task.complexity || "")}`,
			`risk=${JSON.stringify(decision.task.risk || "")}`,
			`gate_ids=${JSON.stringify((decision.gates.ids || []).slice(0, 12))}`,
		];
	}
	async function recordTaskEvent(pi: ExtensionAPI, ctx: ExtensionContext, eventType: string, args: string[]): Promise<boolean> {
		if (!state.active?.task_id) return false;
		try {
			const result = await runScript(pi, "task-event.sh", [state.active.task_id, eventType, ...args], ctx.cwd, 5_000);
			if (result.code !== 0) {
				state.lastError = shortError(result);
				return false;
			}
			return true;
		} catch (error) {
			state.lastError = error instanceof Error ? error.message : String(error);
			return false;
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
	function lifecycleLines(payload: TaskLifecycleResult): string[] {
		const lifecycleState = payload.terminal ? "terminal" : payload.active ? "active" : "inactive";
		const route = payload.route.primary_runtime
			? `${payload.route.primary_runtime} / review=${payload.route.review_runtime || "none"} / effort=${payload.route.effort || "?"} / handoff_required=${payload.route.handoff_required}`
			: "none";
		const lease = payload.lease.state;
		return [
			`- lifecycle API: ok (v${payload.task_api_version ?? "?"})`,
			`- lifecycle status: ${payload.status || "unknown"} (${lifecycleState}${payload.valid_status ? "" : ", invalid"})`,
			`- lifecycle lease: ${lease}`,
			`- lifecycle route: ${route}`,
			`- lifecycle events: ${payload.events.count} recorded${payload.events.last_type ? `; last ${payload.events.last_type} at ${payload.events.last_timestamp || "unknown"}` : ""}`,
			`- lifecycle blockers: ${payload.blockers_count}`,
			...(payload.next_action ? [`- lifecycle next action: ${payload.next_action}`] : []),
			...(payload.closed_at ? [`- lifecycle closed at: ${payload.closed_at}`] : []),
			...(payload.has_closure_reason ? ["- lifecycle closure reason: recorded"] : []),
		];
	}
	async function lifecycleSection(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string[]> {
		if (!state.active?.task_id) return ["- lifecycle API: no active task"];
		if (!supportsTaskLifecycle(state)) return ["- lifecycle API: unavailable (capability not advertised)"];
		try {
			const result = await runScript(pi, "task-lifecycle.sh", [state.active.task_id, "--cwd", ctx.cwd], ctx.cwd, 5_000);
			if (result.code !== 0) return ["- lifecycle API: unavailable (script_error)"];
			const payload = parseJson<TaskLifecycleResult>(result.stdout);
			if (payload?.task_api_version !== SUPPORTED_TASK_API_VERSION) return ["- lifecycle API: unavailable (unsupported API version)"];
			return lifecycleLines(payload);
		} catch {
			return ["- lifecycle API: unavailable (exception)"];
		}
	}
	function closeErrorSummary(result: { stderr?: string; stdout?: string; code?: number }): string {
		const text = `${result.stderr || ""} ${result.stdout || ""}`.toLowerCase();
		if (text.includes("credential")) return "closure text was rejected by policy";
		if (text.includes("terminal task")) return "task is already terminal";
		if (text.includes("lease")) return "close blocked by the active task lease";
		return `task-close failed (exit ${result.code ?? "unknown"})`;
	}
	async function closeTask(pi: ExtensionAPI, ctx: ExtensionContext, status: "completed" | "blocked", reason = ""): Promise<{ ok: boolean; lines: string[] }> {
		if (!(await ensureTaskApi(pi, state, ctx.cwd))) return { ok: false, lines: ["## Task close", "- result: unavailable", "- reason: task API unavailable"] };
		if (!supportsTaskClose(state)) return { ok: false, lines: ["## Task close", "- result: unavailable", "- reason: task-close capability not advertised"] };
		if (!state.active?.task_id) await refreshDiscoveredTaskScope(pi, ctx);
		const taskId = state.active?.task_id || state.discovered?.task_id;
		if (!taskId) return { ok: false, lines: ["## Task close", "- result: no active task", "- action: run a nontrivial task turn first or inspect /status"] };
		const args = [taskId, status, "--runtime", "pi", "--owner", process.env.USER || "unknown", "--session", state.sessionId, "--release"];
		const runClose = async (reasonFile?: string) => {
			if (reasonFile) args.push("--reason-file", reasonFile);
			return await runScript(pi, "task-close.sh", args, ctx.cwd, 8_000);
		};
		const result = reason.trim() ? await withPrivateTempTextFile("pi-task-close-reason-", reason.trim(), runClose) : await runClose();
		if (result.code !== 0) return { ok: false, lines: ["## Task close", "- result: blocked", `- reason: ${closeErrorSummary(result)}`] };
		const payload = parseJson<TaskCloseResult>(result.stdout);
		if (!payload?.status) return { ok: false, lines: ["## Task close", "- result: unavailable", "- reason: task-close returned invalid JSON"] };
		state.active = undefined;
		state.discovered = undefined;
		state.context = undefined;
		state.lastAction = "skipped";
		state.lastReason = `task ${payload.status}`;
		state.lastError = undefined;
		state.artifactCount = 0;
		state.artifactRecordedThisTurn = 0;
		state.artifactSkipped = 0;
		return {
			ok: true,
			lines: [
				"## Task close",
				`- result: ${payload.status}`,
				"- lease: release requested for the current Pi session",
				`- closure reason: ${payload.has_closure_reason || reason.trim() ? "recorded" : "none"}`,
				"- artifact cleanup: shared manifest-and-marker HTML cleanup may run for terminal task state",
			],
		};
	}
	function statusLines(): string[] {
		if (state.active?.task_id) {
			const skipped = state.artifactSkipped ? `, ${state.artifactSkipped} skipped` : "";
			return [
				`- active task: ${state.active.task_id} (${state.lastAction ?? "bound"})`,
				`- task project: ${state.active.project_root || "unknown"}`,
				`- task runtime/session: pi / ${state.sessionId}`,
				`- task artifacts: ${state.artifactCount} recorded${skipped}`,
				...(orchestrationStatusLine() ? [orchestrationStatusLine() as string] : []),
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
		async refresh(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
			if (state.apiChecked && !state.apiAvailable) await ensureTaskApi(pi, state, ctx.cwd);
			if (state.apiAvailable) await refreshDiscoveredTaskScope(pi, ctx);
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
					"--kind", pathArtifact.kind,
					"--title", pathArtifact.title,
					"--summary", pathArtifact.summary,
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
		async recordOrchestrationRecommended(pi: ExtensionAPI, ctx: ExtensionContext, decision?: OrchestrationDecision): Promise<boolean> {
			if (!decision) return false;
			state.orchestration = refreshOrchestrationMismatch({
				...(state.orchestration ?? {}),
				recommendedTopology: decision.topology.recommended,
				decisionId: decision.decision_id,
				gateIds: decision.gates.ids,
			});
			return await recordTaskEvent(pi, ctx, "orchestration_recommended", orchestrationEventArgs(decision));
		},
		async closeTask(pi: ExtensionAPI, ctx: ExtensionContext, status: "completed" | "blocked", reason = ""): Promise<{ ok: boolean; lines: string[] }> {
			return closeTask(pi, ctx, status, reason);
		},
		async recordOrchestrationChosen(pi: ExtensionAPI, ctx: ExtensionContext, topology: string, _reason = "explicit /choose-topology command"): Promise<boolean> {
			const chosen = topology.trim().replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
			if (!chosen) return false;
			state.orchestration = refreshOrchestrationMismatch({ ...(state.orchestration ?? {}), chosenTopology: chosen });
			const args = [`chosen_topology=${JSON.stringify(chosen)}`, "reason_code=explicit_choice"];
			if (state.orchestration?.decisionId) args.push(`decision_id=${JSON.stringify(state.orchestration.decisionId)}`);
			return await recordTaskEvent(pi, ctx, "orchestration_chosen", args);
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
		orchestrationSummaryLines,
		currentPromptWeight(): TaskWeight {
			return state.currentPromptWeight;
		},
		ambientScope(): { taskId?: string; projectRoot?: string } {
			return { taskId: state.active?.task_id || state.discovered?.task_id, projectRoot: state.active?.project_root || state.discovered?.project_root };
		},
		finalVisibility(): FinalTaskVisibility {
			const visibilityState: FinalTaskVisibility["state"] = state.active?.task_id ? "bound" : state.lastAction === "blocked" ? "blocked" : state.lastError ? "unavailable" : "not_bound";
			return {
				state: visibilityState,
				activity: { ...state.activity },
				artifacts: { recordedThisTurn: state.artifactRecordedThisTurn, skippedThisTurn: state.artifactSkipped },
			};
		},
		async doctorSection(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string> {
			return [
				"## AGENTS task binding",
				...statusLines(),
				...(!state.active?.task_id ? orchestrationSummaryLines() : []),
				`- task API: ${state.apiAvailable ? `v${state.apiInfo?.task_api_version ?? "?"}` : "unavailable"}`,
				`- agents root: ${state.apiInfo?.agents_shared_root ?? agentsRoot()}`,
				`- prompt task mode: ${state.currentPromptWeight}/${state.currentBindingMode}`,
				`- current turn activity: reads ${state.activity.reads}, writes ${state.activity.writes}, commands ${state.activity.commands}, errors ${state.activity.errors}`,
				`- artifact capture: ${state.artifactCount} recorded, ${state.artifactSkipped} skipped this turn`,
				...(state.lastError ? [`- last task-layer error: ${state.lastError}`] : []),
				"",
				"## AGENTS task lifecycle",
				...(await lifecycleSection(pi, ctx)),
				"",
				"## AGENTS task retention",
				...(await retentionSection(pi, ctx, state)),
			].join("\n");
		},
		health(): "ok" | "warning" {
			return state.lastError || state.lastAction === "blocked" ? "warning" : "ok";
		},
	};
}
