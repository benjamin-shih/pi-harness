import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

type ExecutionRoutePayload = {
	execution_route_api_version?: number;
	execution_intent?: boolean;
	profile?: ExecutionProfile | null;
	overlays?: ExecutionOverlay[];
	summary?: string;
	guidance?: string;
};

const SUPPORTED_EXECUTION_ROUTE_API_VERSION = 1;

export async function buildExecutionGuidance(pi: ExtensionAPI, cwd: string, prompt: string): Promise<ExecutionRoute | undefined> {
	try {
		return await withPrivateTempTextFile("pi-execution-route-", prompt, async (promptFile) => {
			const result = await pi.exec("bash", [agentsScriptPath("execution-route.sh"), "--prompt-file", promptFile, "--cwd", cwd], { cwd, timeout: 5_000 });
			if (result.code !== 0) return undefined;
			const payload = parseJson<ExecutionRoutePayload>(result.stdout);
			if (payload?.execution_route_api_version !== SUPPORTED_EXECUTION_ROUTE_API_VERSION) return undefined;
			if (!payload.execution_intent || !payload.profile || !payload.guidance?.trim()) return undefined;
			return {
				profile: payload.profile,
				overlays: payload.overlays ?? [],
				summary: payload.summary?.trim() || `profile ${payload.profile}; overlays ${payload.overlays?.length ? payload.overlays.join(", ") : "none"}`,
				guidance: payload.guidance,
			};
		});
	} catch {
		return undefined;
	}
}
