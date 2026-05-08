import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";
import { withPrivateTempTextFile } from "./private-temp";

export type OrchestrationTaskShape = "coding" | "research" | "release" | "maintenance" | "coursework" | "documentation" | "discussion" | "general";
export type OrchestrationComplexity = "trivial" | "standard" | "complex";
export type OrchestrationRisk = "low" | "medium" | "high";
export type OrchestrationRunShape = "direct_answer" | "main_agent" | "main_agent_plus_reviewer" | "parallel_recon" | "war_room";

export type OrchestrationRoute = {
	task: { shape: OrchestrationTaskShape; complexity: OrchestrationComplexity; risk: OrchestrationRisk };
	project: { name: string; root: string; type: string; bindable: boolean; reason: string };
	run: { shape: OrchestrationRunShape; summary: string };
	delegation: Array<{ role: string; when: string; cwd: string; mode: string; constraints?: string[] }>;
	gates: string[];
	evidence_required: string[];
	human_decisions: string[];
	stop_rules: string[];
	guidance: string;
	reasons: string[];
	warnings?: string[];
};

export type OrchestrationRouteStatus = "routed" | "trivial" | "script_error" | "invalid_json" | "unsupported_api" | "invalid_payload" | "exception";
export type OrchestrationRouteHealth = "ok" | "inactive" | "degraded";

export type OrchestrationRouteState = {
	health: OrchestrationRouteHealth;
	status: OrchestrationRouteStatus;
	apiVersion?: number;
	summary: string;
	route?: OrchestrationRoute;
};

type OrchestrationRoutePayload = OrchestrationRoute & {
	control_plane_api_version?: number;
	kind?: string;
};

const SUPPORTED_CONTROL_PLANE_API_VERSION = 1;

function state(health: OrchestrationRouteHealth, status: OrchestrationRouteStatus, summary: string, apiVersion?: number, route?: OrchestrationRoute): OrchestrationRouteState {
	return { health, status, summary, ...(apiVersion === undefined ? {} : { apiVersion }), ...(route ? { route } : {}) };
}

function summarize(route: OrchestrationRoute): string {
	return `${route.task.shape}/${route.task.complexity}/${route.task.risk}; ${route.run.shape}; project ${route.project.name}`;
}

function stateFromPayload(payload: OrchestrationRoutePayload | undefined): OrchestrationRouteState {
	if (!payload) return state("degraded", "invalid_json", "degraded · invalid_json");
	const apiVersion = payload.control_plane_api_version;
	if (apiVersion !== SUPPORTED_CONTROL_PLANE_API_VERSION) return state("degraded", "unsupported_api", "degraded · unsupported_api", apiVersion);
	if (payload.kind !== "route" || !payload.task || !payload.project || !payload.run || !payload.guidance?.trim()) return state("degraded", "invalid_payload", "degraded · invalid_payload", apiVersion);
	const route: OrchestrationRoute = {
		task: payload.task,
		project: payload.project,
		run: payload.run,
		delegation: payload.delegation ?? [],
		gates: payload.gates ?? [],
		evidence_required: payload.evidence_required ?? [],
		human_decisions: payload.human_decisions ?? [],
		stop_rules: payload.stop_rules ?? [],
		guidance: payload.guidance,
		reasons: payload.reasons ?? [],
		warnings: payload.warnings ?? [],
	};
	if (route.task.complexity === "trivial" || route.run.shape === "direct_answer") return state("inactive", "trivial", summarize(route), apiVersion, route);
	return state("ok", "routed", summarize(route), apiVersion, route);
}

export async function buildOrchestrationRouteState(pi: ExtensionAPI, cwd: string, prompt: string): Promise<OrchestrationRouteState> {
	try {
		return await withPrivateTempTextFile("pi-control-plane-route-", prompt, async (promptFile) => {
			const result = await pi.exec("bash", [agentsScriptPath("control-plane.sh"), "route", "--prompt-file", promptFile, "--cwd", cwd, "--json"], { cwd, timeout: 5_000 });
			if (result.code !== 0) return state("degraded", "script_error", "degraded · script_error");
			return stateFromPayload(parseJson<OrchestrationRoutePayload>(result.stdout));
		});
	} catch {
		return state("degraded", "exception", "degraded · exception");
	}
}

function listLine(label: string, items: string[]): string {
	return `- ${label}: ${items.length ? items.slice(0, 4).join("; ") : "none"}`;
}

export function formatRunCard(state: OrchestrationRouteState): string {
	if (!state.route) return ["## Run card", `- status: ${state.status}`, `- health: ${state.health}`, `- summary: ${state.summary}`].join("\n");
	const route = state.route;
	const delegation = route.delegation.length ? route.delegation.map((item) => `${item.role} (${item.mode}) when ${item.when}`).slice(0, 6) : ["none"];
	return [
		"## Run card",
		`- health: ${state.health} (${state.status}; v${state.apiVersion ?? "?"})`,
		`- task: ${route.task.shape}; complexity ${route.task.complexity}; risk ${route.task.risk}`,
		`- project: ${route.project.name} (${route.project.type})`,
		`- project root: ${route.project.root}`,
		`- run shape: ${route.run.shape}`,
		`- run summary: ${route.run.summary}`,
		listLine("delegation", delegation),
		listLine("gates", route.gates),
		listLine("evidence", route.evidence_required),
		listLine("human decisions", route.human_decisions),
		listLine("stop rules", route.stop_rules),
		listLine("warnings", route.warnings ?? []),
		"",
		route.guidance,
	].join("\n");
}
