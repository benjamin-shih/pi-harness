import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";
import { withPrivateTempTextFile } from "./private-temp";

export type ExecutionProfile = "software" | "devops" | "research_ai_ml" | "empirical_data" | "documentation" | "general_execution";
export type ExecutionOverlay = "math_latex" | "release_changelog" | "python_uv" | "plotting" | "security_privacy" | "repo_cleanup" | "package_hygiene" | "subagent_orchestration";

export type ExecutionRoute = {
	profile: ExecutionProfile;
	overlays: ExecutionOverlay[];
	summary: string;
	guidance: string;
};

export type ExecutionRouteStatus = "routed" | "no_intent" | "not_checked" | "script_error" | "invalid_json" | "unsupported_api" | "invalid_payload" | "exception";
export type ExecutionRouteHealth = "ok" | "inactive" | "degraded";

export type ExecutionRouteState = {
	health: ExecutionRouteHealth;
	status: ExecutionRouteStatus;
	apiVersion?: number;
	summary: string;
	route?: ExecutionRoute;
};

type ExecutionRoutePayload = {
	execution_route_api_version?: number;
	execution_intent?: boolean;
	profile?: ExecutionProfile | null;
	overlays?: ExecutionOverlay[];
	summary?: string;
	guidance?: string;
};

const SUPPORTED_EXECUTION_ROUTE_API_VERSION = 1;

const EXECUTION_INTENT_RE = /\b(?:go ahead|continue|implement|ship|fix|debug|update|modify|edit|write|create|add|remove|delete|refactor|simplify|migrate|build|run|test|verify|commit|push|release|deploy|install|upgrade|configure|set up|put into|apply|do this|make this|cleanup|clean up|review|audit|investigate|benchmark|profile|analyze|research|plan)\b/i;
const DISCUSSION_ONLY_RE = /^\s*(?:what|why|how|when|where|who|is|are|can you explain|could you explain|tell me|summarize|compare)\b/i;

function state(health: ExecutionRouteHealth, status: ExecutionRouteStatus, summary: string, apiVersion?: number, route?: ExecutionRoute): ExecutionRouteState {
	return { health, status, summary, ...(apiVersion === undefined ? {} : { apiVersion }), ...(route ? { route } : {}) };
}

function routeSummary(profile: ExecutionProfile, overlays: ExecutionOverlay[] | undefined, summary: string | undefined): string {
	return summary?.trim() || `profile ${profile}; overlays ${overlays?.length ? overlays.join(", ") : "none"}`;
}

export function shouldCheckExecutionRoute(prompt: string): boolean {
	const text = prompt.trim();
	if (!text) return false;
	if (EXECUTION_INTENT_RE.test(text)) return true;
	if (DISCUSSION_ONLY_RE.test(text)) return false;
	return false;
}

export function deferredExecutionRouteState(): ExecutionRouteState {
	return state("inactive", "not_checked", "not active (cheap prompt gate)");
}

function stateFromPayload(payload: ExecutionRoutePayload | undefined): ExecutionRouteState {
	if (!payload) return state("degraded", "invalid_json", "degraded · invalid_json");
	const apiVersion = payload.execution_route_api_version;
	if (apiVersion !== SUPPORTED_EXECUTION_ROUTE_API_VERSION) return state("degraded", "unsupported_api", "degraded · unsupported_api", apiVersion);
	if (!payload.execution_intent) return state("inactive", "no_intent", "not active", apiVersion);
	if (!payload.profile || !payload.guidance?.trim()) return state("degraded", "invalid_payload", "degraded · invalid_payload", apiVersion);
	const overlays = payload.overlays ?? [];
	const summary = routeSummary(payload.profile, overlays, payload.summary);
	return state("ok", "routed", summary, apiVersion, { profile: payload.profile, overlays, summary, guidance: payload.guidance });
}

export async function buildExecutionRouteState(pi: ExtensionAPI, cwd: string, prompt: string): Promise<ExecutionRouteState> {
	if (!shouldCheckExecutionRoute(prompt)) return deferredExecutionRouteState();
	try {
		return await withPrivateTempTextFile("pi-execution-route-", prompt, async (promptFile) => {
			const result = await pi.exec("bash", [agentsScriptPath("execution-route.sh"), "--prompt-file", promptFile, "--cwd", cwd], { cwd, timeout: 5_000 });
			if (result.code !== 0) return state("degraded", "script_error", "degraded · script_error");
			return stateFromPayload(parseJson<ExecutionRoutePayload>(result.stdout));
		});
	} catch {
		return state("degraded", "exception", "degraded · exception");
	}
}

export async function buildExecutionGuidance(pi: ExtensionAPI, cwd: string, prompt: string): Promise<ExecutionRoute | undefined> {
	return (await buildExecutionRouteState(pi, cwd, prompt)).route;
}
