import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";
import { withPrivateTempTextFile } from "./private-temp";

export type ControlCenterHealth = "ok" | "warning" | "degraded";
export type ControlCenterStatus = "ready" | "script_error" | "invalid_json" | "unsupported_api" | "invalid_payload" | "exception";

export type ControlCenterRouteSummary = {
	task?: { shape?: string; complexity?: string; risk?: string };
	run?: { shape?: string; summary?: string };
};

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
		steward?: string;
		default_checks?: string[];
		write_policy?: string;
		coursework_policy?: string;
	};
	route?: ControlCenterRouteSummary | null;
	tasks?: {
		available?: boolean;
		scope?: string;
		summary?: Record<string, number>;
		active_task?: { status?: string; active?: boolean; terminal?: boolean; scope_match?: boolean; lease_state?: string; events_count?: number; blockers_count?: number } | null;
		warnings?: string[];
	};
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
	if (payload.warnings?.length || payload.attention?.length) return "warning";
	if (payload.package_policy?.health === "warning" || payload.project_instructions?.health === "warning") return "warning";
	if (payload.tasks?.available === false || payload.memory?.available === false || payload.package_policy?.available === false) return "warning";
	return "ok";
}

function summaryFromPayload(payload: ControlCenterPayload): string {
	const project = payload.project?.name || "unknown project";
	const attention = payload.attention?.length ?? 0;
	const route = payload.route?.task?.shape ? `${payload.route.task.shape}/${payload.route.task.complexity ?? "?"}/${payload.route.task.risk ?? "?"}` : "no route";
	return `${project}; ${route}; ${attention} attention item(s)`;
}

function stateFromPayload(payload: ControlCenterPayload | undefined): ControlCenterState {
	if (!payload) return state("degraded", "invalid_json", "degraded · invalid_json");
	const apiVersion = payload.control_plane_api_version;
	if (apiVersion !== SUPPORTED_CONTROL_PLANE_API_VERSION) return state("degraded", "unsupported_api", "degraded · unsupported_api", apiVersion);
	if (payload.kind !== "dashboard" || payload.read_only !== true || !payload.project || !payload.tasks || !payload.memory || !payload.package_policy) return state("degraded", "invalid_payload", "degraded · invalid_payload", apiVersion);
	return state(payloadHealth(payload), "ready", summaryFromPayload(payload), apiVersion, payload);
}

export async function buildControlCenterState(pi: ExtensionAPI, cwd: string, options: { prompt?: string; taskId?: string } = {}): Promise<ControlCenterState> {
	try {
		const run = async (promptFile?: string) => {
			const args = [agentsScriptPath("control-plane.sh"), "dashboard", "--cwd", cwd, "--json"];
			if (promptFile) args.push("--prompt-file", promptFile);
			if (options.taskId) args.push("--task-id", options.taskId);
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

export async function openControlCenterHtml(pi: ExtensionAPI, cwd: string, options: { prompt?: string; taskId?: string } = {}): Promise<{ path?: string; opened: boolean; error?: string }> {
	const prompt = options.prompt?.trim();
	const run = async (promptFile?: string) => {
		const args = [agentsScriptPath("control-plane.sh"), "dashboard", "--cwd", cwd, "--html"];
		if (promptFile) args.push("--prompt-file", promptFile);
		if (options.taskId) args.push("--task-id", options.taskId);
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

export function formatControlCenter(state: ControlCenterState): string {
	if (!state.payload) return ["## Agent Control Center v0", `- health: ${state.health} (${state.status})`, `- summary: ${state.summary}`].join("\n");
	const payload = state.payload;
	const project = payload.project ?? {};
	const route = payload.route;
	const tasks = payload.tasks ?? {};
	const taskSummary = tasks.summary ?? {};
	const activeTask = tasks.active_task;
	const memory = payload.memory ?? {};
	const memoryCounts = memory.counts_by_state ?? {};
	const packagePolicy = payload.package_policy ?? {};
	const packageSummary = packagePolicy.summary ?? {};
	const instructions = payload.project_instructions ?? {};
	const instructionSummary = instructions.summary ?? {};
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
		`- policy: write ${project.write_policy || "unknown"}; coursework ${project.coursework_policy || "none"}`,
		listLine("default checks", project.default_checks),
		"",
		"## Route",
		route?.task?.shape ? `- task: ${route.task.shape}; complexity ${route.task.complexity ?? "unknown"}; risk ${route.task.risk ?? "unknown"}` : "- task: no prompt route requested",
		route?.run?.shape ? `- run shape: ${route.run.shape}` : "- run shape: none",
		"",
		"## Tasks",
		`- task diagnostics: ${tasks.available === false ? "unavailable" : "available"} (${tasks.scope ?? "project"})`,
		countLine("scoped task packages", taskSummary.task_packages_scoped),
		countLine("active tasks", taskSummary.active_tasks),
		countLine("terminal tasks", taskSummary.terminal_tasks),
		countLine("live leases", taskSummary.live_leases),
		countLine("stale candidates", taskSummary.stale_candidates),
		activeTask ? `- active task: status ${activeTask.status ?? "unknown"}; lease ${activeTask.lease_state ?? "unknown"}; scope match ${Boolean(activeTask.scope_match)}; events ${activeTask.events_count ?? 0}` : "- active task: none supplied",
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
		listLine("warnings", [...(payload.warnings ?? []), ...(tasks.warnings ?? []), ...(memory.warnings ?? []), ...(packagePolicy.warnings ?? []), ...(instructions.warnings ?? [])]),
	];
	return lines.join("\n");
}
