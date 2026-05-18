import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DelegationWorkflow, HtmlArtifactDecision } from "./orchestration-guidance";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";
import { withPrivateTempTextFile } from "./private-temp";

export type ControlCenterHealth = "ok" | "warning" | "degraded";
export type ControlCenterStatus = "ready" | "script_error" | "invalid_json" | "unsupported_api" | "invalid_payload" | "exception";

export type ControlCenterRouteSummary = {
	task?: { shape?: string; complexity?: string; risk?: string };
	run?: { shape?: string; summary?: string };
};

export type ControlCenterDecisionSummary = {
	task?: { shape?: string; complexity?: string; risk?: string };
	route?: { run?: { shape?: string; summary?: string } };
	topology?: { recommended?: string; reason?: string; description?: string; advisory_only?: boolean; subagents?: Array<{ role?: string; mode?: string; when?: string }> };
	gates?: { ids?: string[]; preflight?: Array<{ id?: string }>; execution?: Array<{ id?: string }>; verification?: Array<{ id?: string }>; final?: Array<{ id?: string }> };
	memory?: { ambient_reads?: string; durable_writes?: string };
	delegation_workflow?: DelegationWorkflow;
	artifacts?: { html?: HtmlArtifactDecision };
	checks?: string[];
	evidence_required?: string[];
	stop_conditions?: string[];
	reasons?: string[];
};

export type ControlCenterOrchestrationTracking = {
	available?: boolean;
	status?: string;
	mismatch?: boolean;
	explanation?: string;
	recommended_action?: string;
	events?: number;
	recommended?: { topology?: string; timestamp?: string; gate_ids?: string[] } | null;
	chosen?: { topology?: string; timestamp?: string; reason?: string } | null;
};

export type ControlCenterTaskEvent = { timestamp?: string; type?: string; summary?: string };

export type ControlCenterOptions = { prompt?: string; taskId?: string; project?: string; projectRoot?: string };

export type ControlCenterPayload = {
	control_plane_api_version?: number;
	kind?: string;
	generated_at?: string;
	cwd?: string;
	read_only?: boolean;
	project?: {
		name?: string;
		root?: string;
		type?: string;
		registry_id?: string;
		match_type?: string;
		description?: string;
		tags?: string[];
		steward?: string;
		default_checks?: string[];
		write_policy?: string;
		coursework_policy?: string;
	};
	route?: ControlCenterRouteSummary | null;
	orchestration_decision?: ControlCenterDecisionSummary | null;
	tasks?: {
		available?: boolean;
		scope?: string;
		summary?: Record<string, number>;
		active_task?: { status?: string; active?: boolean; terminal?: boolean; scope_match?: boolean; lease_state?: string; events_count?: number; blockers_count?: number; recent_events?: ControlCenterTaskEvent[]; orchestration?: ControlCenterOrchestrationTracking } | null;
		orchestration?: ControlCenterOrchestrationTracking;
		warnings?: string[];
	};
	async_inbox?: { available?: boolean; scope?: string; count?: number; active_items?: number; summary?: { by_status?: Record<string, number>; by_control_state?: Record<string, number>; by_cleanup_state?: Record<string, number>; by_project?: Record<string, number>; active_by_project?: Record<string, number>; queued_by_project?: Record<string, number>; review_by_project?: Record<string, number>; apply_by_project?: Record<string, number>; cleanup_by_project?: Record<string, number> }; warnings?: string[] };
	html_artifacts?: { available?: boolean; scope?: string; project_scoped?: boolean; summary?: Record<string, number>; policy?: { cleanup_strategy?: string; marker?: string; delete_on_task_status?: string[]; destructive_actions?: boolean }; warnings?: string[] };
	memory?: {
		available?: boolean;
		count?: number;
		counts_by_state?: Record<string, number>;
		skipped?: number;
		warnings?: string[];
	};
	package_policy?: {
		available?: boolean;
		health?: string;
		summary?: Record<string, number>;
		policy?: { default_action?: string; requires_exact_pins?: boolean; runtime_network_checks?: boolean };
		warnings?: string[];
	};
	project_instructions?: {
		available?: boolean;
		health?: string;
		summary?: Record<string, number | boolean>;
		warnings?: string[];
	};
	attention?: string[];
	warnings?: string[];
	notices?: string[];
};

export type ControlCenterState = {
	health: ControlCenterHealth;
	status: ControlCenterStatus;
	apiVersion?: number;
	summary: string;
	payload?: ControlCenterPayload;
};

const SUPPORTED_CONTROL_PLANE_API_VERSION = 1;

function state(health: ControlCenterHealth, status: ControlCenterStatus, summary: string, apiVersion?: number, payload?: ControlCenterPayload): ControlCenterState {
	return { health, status, summary, ...(apiVersion === undefined ? {} : { apiVersion }), ...(payload ? { payload } : {}) };
}

function payloadHealth(payload: ControlCenterPayload): ControlCenterHealth {
	if (payload.warnings?.length || payload.attention?.length || payload.html_artifacts?.warnings?.length) return "warning";
	if (payload.package_policy?.health === "warning" || payload.project_instructions?.health === "warning") return "warning";
	if (payload.tasks?.available === false || payload.async_inbox?.available === false || payload.html_artifacts?.available === false || payload.package_policy?.available === false) return "warning";
	return "ok";
}

function summaryFromPayload(payload: ControlCenterPayload): string {
	const project = payload.project?.name || "unknown project";
	const attention = payload.attention?.length ?? 0;
	const route = payload.route?.task?.shape ? `${payload.route.task.shape}/${payload.route.task.complexity ?? "?"}/${payload.route.task.risk ?? "?"}` : "no route";
	const topology = payload.orchestration_decision?.topology?.recommended;
	return `${project}; ${route}${topology ? `; topology ${topology}` : ""}; ${attention} attention item(s)`;
}

function stateFromPayload(payload: ControlCenterPayload | undefined): ControlCenterState {
	if (!payload) return state("degraded", "invalid_json", "degraded · invalid_json");
	const apiVersion = payload.control_plane_api_version;
	if (apiVersion !== SUPPORTED_CONTROL_PLANE_API_VERSION) return state("degraded", "unsupported_api", "degraded · unsupported_api", apiVersion);
	if (payload.kind !== "dashboard" || payload.read_only !== true || !payload.project || !payload.tasks || !payload.html_artifacts || !payload.memory || !payload.package_policy) return state("degraded", "invalid_payload", "degraded · invalid_payload", apiVersion);
	return state(payloadHealth(payload), "ready", summaryFromPayload(payload), apiVersion, payload);
}

function appendDashboardArgs(args: string[], options: ControlCenterOptions, promptFile?: string): string[] {
	if (promptFile) args.push("--prompt-file", promptFile);
	if (options.taskId) args.push("--task-id", options.taskId);
	if (options.project) args.push("--project", options.project);
	if (options.projectRoot) args.push("--project-root", options.projectRoot);
	return args;
}

export async function buildControlCenterState(pi: ExtensionAPI, cwd: string, options: ControlCenterOptions = {}): Promise<ControlCenterState> {
	try {
		const run = async (promptFile?: string) => {
			const args = appendDashboardArgs([agentsScriptPath("control-plane.sh"), "dashboard", "--cwd", cwd, "--json"], options, promptFile);
			const result = await pi.exec("bash", args, { cwd, timeout: 8_000 });
			if (result.code !== 0) return state("degraded", "script_error", "degraded · script_error");
			return stateFromPayload(parseJson<ControlCenterPayload>(result.stdout));
		};
		const prompt = options.prompt?.trim();
		return prompt ? await withPrivateTempTextFile("pi-control-center-prompt-", prompt, run) : await run();
	} catch {
		return state("degraded", "exception", "degraded · exception");
	}
}

export async function openControlCenterHtml(pi: ExtensionAPI, cwd: string, options: ControlCenterOptions = {}): Promise<{ path?: string; opened: boolean; error?: string }> {
	const prompt = options.prompt?.trim();
	const run = async (promptFile?: string) => {
		const args = appendDashboardArgs([agentsScriptPath("control-plane.sh"), "dashboard", "--cwd", cwd, "--html"], options, promptFile);
		const result = await pi.exec("bash", args, { cwd, timeout: 8_000 });
		if (result.code !== 0 || !result.stdout.trim()) return { opened: false, error: "dashboard html unavailable" };
		const dir = await mkdtemp(join(tmpdir(), "pi-control-center-"));
		const path = join(dir, "index.html");
		await writeFile(path, result.stdout, { encoding: "utf8", mode: 0o600 });
		const opened = await pi.exec("open", [path], { cwd, timeout: 5_000 });
		return { path, opened: opened.code === 0, ...(opened.code === 0 ? {} : { error: "open command failed" }) };
	};
	try {
		return prompt ? await withPrivateTempTextFile("pi-control-center-prompt-", prompt, run) : await run();
	} catch (error) {
		return { opened: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function listLine(label: string, items: string[] | undefined): string {
	return `- ${label}: ${items?.length ? items.slice(0, 5).join("; ") : "none"}`;
}

function countLine(label: string, value: unknown): string {
	return `- ${label}: ${typeof value === "number" ? value : 0}`;
}

function countMapLine(label: string, counts: Record<string, number> | undefined): string {
	const text = counts ? Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ") : "";
	return `- ${label}: ${text || "none"}`;
}

function taskEventLine(event: ControlCenterTaskEvent): string {
	const prefix = event.timestamp ? `${event.timestamp} ` : "";
	return `${prefix}${event.type || "event"}${event.summary ? ` (${event.summary})` : ""}`;
}

export function formatControlCenter(state: ControlCenterState): string {
	if (!state.payload) return ["## Agent Control Center v0", `- health: ${state.health} (${state.status})`, `- summary: ${state.summary}`].join("\n");
	const payload = state.payload;
	const project = payload.project ?? {};
	const route = payload.route;
	const decision = payload.orchestration_decision;
	const tasks = payload.tasks ?? {};
	const taskSummary = tasks.summary ?? {};
	const activeTask = tasks.active_task;
	const tracking = activeTask?.orchestration ?? tasks.orchestration;
	const asyncInbox = payload.async_inbox ?? {}, asyncInboxSummary = asyncInbox.summary ?? {};
	const htmlRetention = payload.html_artifacts ?? {}, htmlRetentionSummary = htmlRetention.summary ?? {}, htmlRetentionPolicy = htmlRetention.policy ?? {};
	const memory = payload.memory ?? {};
	const memoryCounts = memory.counts_by_state ?? {};
	const packagePolicy = payload.package_policy ?? {};
	const packageSummary = packagePolicy.summary ?? {};
	const instructions = payload.project_instructions ?? {};
	const instructionSummary = instructions.summary ?? {};
	const warnings = [...(payload.warnings ?? []), ...(tasks.warnings ?? []), ...(htmlRetention.warnings ?? []), ...(memory.warnings ?? []), ...(packagePolicy.warnings ?? []), ...(instructions.warnings ?? [])];
	const lines = [
		"## Agent Control Center v0",
		`- health: ${state.health} (${state.status}; v${state.apiVersion ?? "?"})`,
		`- generated: ${payload.generated_at ?? "unknown"}`,
		"- mode: read-only diagnostics; no task execution, package changes, memory writes, or cleanup actions",
		"",
		"## Project",
		`- name: ${project.name ?? "unknown"} (${project.type ?? "unknown"})`,
		`- root: ${project.root ?? "unknown"}`,
		`- registry: ${project.registry_id || "unregistered"}${project.match_type ? ` via ${project.match_type}` : ""}`,
		`- steward: ${project.steward || "none"}`,
		`- description: ${project.description || "none"}`,
		listLine("tags", project.tags),
		`- policy: write ${project.write_policy || "unknown"}; coursework ${project.coursework_policy || "none"}`,
		listLine("default checks", project.default_checks),
		"",
		"## Route",
		route?.task?.shape ? `- task: ${route.task.shape}; complexity ${route.task.complexity ?? "unknown"}; risk ${route.task.risk ?? "unknown"}` : "- task: no prompt route requested",
		route?.run?.shape ? `- run shape: ${route.run.shape}` : "- run shape: none",
		"",
		"## Orchestration",
		decision?.topology?.recommended ? `- topology: ${decision.topology.recommended}` : "- topology: no orchestration decision requested",
		decision?.topology?.recommended ? `- topology rationale: ${decision.topology.reason || "none"}` : "- topology rationale: none",
		decision?.topology?.recommended ? `- topology description: ${decision.topology.description || "none"}` : "- topology description: none",
		listLine("decision basis", decision?.reasons),
		`- project defaults: checks ${project.default_checks?.length ? project.default_checks.join("; ") : "none"}; write ${project.write_policy || "unknown"}; coursework ${project.coursework_policy || "none"}`,
		decision?.route?.run?.shape ? `- run shape: ${decision.route.run.shape}` : "- run shape: none",
		listLine("gate ids", decision?.gates?.ids),
		listLine("preflight gates", decision?.gates?.preflight?.map((gate) => gate.id || "")),
		listLine("execution gates", decision?.gates?.execution?.map((gate) => gate.id || "")),
		listLine("verification gates", decision?.gates?.verification?.map((gate) => gate.id || "")),
		listLine("final gates", decision?.gates?.final?.map((gate) => gate.id || "")),
		listLine("checks", decision?.checks),
		decision?.memory ? `- memory: ambient reads ${decision.memory.ambient_reads ?? "unknown"}; durable writes ${decision.memory.durable_writes ?? "explicit_only"}` : "- memory: no decision",
		decision?.delegation_workflow ? `- delegation launch: ${decision.delegation_workflow.launch_policy || "manual_main_agent_only"}; auto-launch ${decision.delegation_workflow.auto_launch ? "yes" : "no"}` : "- delegation launch: no decision",
		decision?.delegation_workflow ? `- delegation pattern: ${decision.delegation_workflow.recommended_pattern || "none"}` : "- delegation pattern: no decision",
		decision?.delegation_workflow ? `- delegation next action: ${decision.delegation_workflow.next_action || "none"}` : "- delegation next action: no decision",
		listLine("delegation subagents", decision?.delegation_workflow?.subagent_contracts?.map((item) => `${item.role || "unknown"} (${item.mode || "unknown"})`)),
		decision?.delegation_workflow ? `- delegation progress: ${decision.delegation_workflow.coordination?.progress_updates || "unknown"}` : "- delegation progress: no decision",
		listLine("html artifact modes", decision?.artifacts?.html?.modes?.map((mode) => mode.id || "")),
		decision?.artifacts?.html ? `- html template: ${decision.artifacts.html.template?.path || decision.artifacts.html.template?.id || "none"}` : "- html template: no decision",
		listLine("html templates", decision?.artifacts?.html?.templates?.map((item) => item.id || "")),
		listLine("html components", decision?.artifacts?.html?.template?.allowed_components),
		decision?.artifacts?.html ? `- html publish: ${decision.artifacts.html.publish_policy || "explicit_only"}; source ${decision.artifacts.html.source_of_truth || "json_or_markdown"}` : "- html publish: no decision",
		decision?.artifacts?.html ? `- html auto-open: ${decision.artifacts.html.auto_open?.enabled ? "enabled" : "disabled"}` : "- html auto-open: no decision",
		decision?.artifacts?.html ? `- html long responses: ${decision.artifacts.html.long_response?.enabled === false ? "disabled" : (decision.artifacts.html.long_response?.chat_response || "concise_summary_plus_local_artifact_path_and_next_action")}` : "- html long responses: no decision",
		decision?.artifacts?.html ? `- html structure: ${decision.artifacts.html.authoring?.structure_policy || "content_first_flexible"}; templates guide presentation, not a fixed outline` : "- html structure: no decision",
		decision?.artifacts?.html ? `- html title style: ${decision.artifacts.html.authoring?.title_style || "compact_first_screen_readable"}` : "- html title style: no decision",
		decision?.artifacts?.html ? `- html retention: ${decision.artifacts.html.retention?.cleanup_strategy || "manifest_and_marker"}; marker ${decision.artifacts.html.retention?.marker || "agents-html-artifact"}` : "- html retention: no decision",
		listLine("evidence", decision?.evidence_required),
		listLine("stop conditions", decision?.stop_conditions),
		"",
		"## Tasks",
		`- task diagnostics: ${tasks.available === false ? "unavailable" : "available"} (${tasks.scope ?? "project"})`,
		countLine("scoped task packages", taskSummary.task_packages_scoped),
		countLine("active tasks", taskSummary.active_tasks),
		countLine("terminal tasks", taskSummary.terminal_tasks),
		countLine("live leases", taskSummary.live_leases),
		countLine("stale candidates", taskSummary.stale_candidates),
		activeTask ? `- active task: status ${activeTask.status ?? "unknown"}; lease ${activeTask.lease_state ?? "unknown"}; scope match ${Boolean(activeTask.scope_match)}; events ${activeTask.events_count ?? 0}` : "- active task: none supplied",
		listLine("recent events", activeTask?.recent_events?.map(taskEventLine)),
		tracking?.available ? `- orchestration tracking: recommended ${tracking.recommended?.topology || "none"}; chosen ${tracking.chosen?.topology || "none"}; status ${tracking.status || "unknown"}; mismatch ${Boolean(tracking.mismatch)}` : "- orchestration tracking: none",
		tracking?.available ? `- orchestration tracking explanation: ${tracking.explanation || "none"}` : "- orchestration tracking explanation: none",
		tracking?.available ? `- orchestration tracking action: ${tracking.recommended_action || "none"}` : "- orchestration tracking action: none",
		"",
		"## Async inbox",
		`- inbox diagnostics: ${asyncInbox.available === false ? "unavailable" : "available"} (${asyncInbox.scope ?? "project"})`,
		countLine("items", asyncInbox.count),
		countLine("active items", asyncInbox.active_items),
		countMapLine("statuses", asyncInboxSummary.by_status),
		countMapLine("control states", asyncInboxSummary.by_control_state),
		countMapLine("cleanup states", asyncInboxSummary.by_cleanup_state),
		countMapLine("active lanes", asyncInboxSummary.active_by_project),
		countMapLine("queued lanes", asyncInboxSummary.queued_by_project),
		countMapLine("review lanes", asyncInboxSummary.review_by_project),
		countMapLine("apply lanes", asyncInboxSummary.apply_by_project),
		countMapLine("cleanup diagnostics", asyncInboxSummary.cleanup_by_project),
		"",
		"## HTML artifact retention",
		`- retention diagnostics: ${htmlRetention.available === false ? "unavailable" : "available"} (${htmlRetention.scope ?? "project"}; strategy ${htmlRetentionPolicy.cleanup_strategy || "manifest_and_marker"})`,
		`- html artifacts: tracked ${htmlRetentionSummary.tracked_html_artifacts ?? 0}; managed ${htmlRetentionSummary.managed_html_artifacts ?? 0}; cleanup candidates ${htmlRetentionSummary.cleanup_candidates ?? 0}`,
		`- html kept/skipped: active-blocked ${htmlRetentionSummary.kept_active_or_blocked ?? 0}; unmarked ${htmlRetentionSummary.skipped_unmarked ?? 0}; unsafe ${htmlRetentionSummary.skipped_unsafe_path ?? 0}`,
		"",
		"## Memory",
		`- scoped memory: ${memory.available === false ? "unavailable" : "available"}`,
		countLine("approved", memoryCounts.approved),
		countLine("candidates", memoryCounts.candidate),
		countLine("deprecated", memoryCounts.deprecated),
		countLine("skipped", memory.skipped),
		"",
		"## Pi package policy",
		`- health: ${packagePolicy.health ?? "unknown"}`,
		countLine("configured", packageSummary.configured_packages),
		countLine("approved", packageSummary.approved_packages),
		countLine("unapproved", packageSummary.unapproved_packages),
		countLine("unpinned", packageSummary.unpinned_packages),
		`- upstream checks: ${packagePolicy.policy?.runtime_network_checks ? "enabled by policy" : "disabled in harness/control center"}`,
		"",
		"## Project instructions",
		`- health: ${instructions.health ?? "unknown"}`,
		countLine("instruction files found", instructionSummary.instruction_files_found),
		countLine("thin-style files", instructionSummary.thin_style_files),
		countLine("dispatch mentions", instructionSummary.dispatch_mentions),
		"",
		"## Attention",
		listLine("items", payload.attention),
		listLine("warnings", warnings),
		listLine("notices", payload.notices),
	];
	return lines.join("\n");
}
