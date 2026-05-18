import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsJsonPayload, runAgentsJson, runAgentsScript, shortAgentsScriptError } from "../shared/agents-client";
import { withPrivateTempTextFile } from "../shared/private-temp";
import {
	SUPPORTED_TASK_API_VERSION,
	type CandidateRootResult,
	type ExecResult,
	type TaskDiscoverResult,
	type TaskApiInfo,
	type TaskClassification,
	type TaskLayerState,
} from "./task-layer-types";

export const runScript = runAgentsScript;
export const shortError = shortAgentsScriptError;

export function scriptJsonPayload<T extends Record<string, unknown>>(result: ExecResult, versionKey?: string, expectedVersion?: number | string): T | undefined {
	return agentsJsonPayload<T>(result, versionKey, expectedVersion);
}

export async function ensureTaskApi(pi: ExtensionAPI, state: TaskLayerState, cwd: string): Promise<boolean> {
	if (state.apiChecked && state.apiAvailable) return true;
	state.apiChecked = true;
	state.apiAvailable = false;
	state.apiInfo = undefined;
	try {
		const result = await runScript(pi, "task-api.sh", ["info"], cwd, 5_000);
		if (result.code !== 0) {
			state.lastError = shortError(result);
			return false;
		}
		const payload = scriptJsonPayload<TaskApiInfo>(result, "task_api_version", SUPPORTED_TASK_API_VERSION);
		if (!payload) {
			state.lastError = "unsupported AGENTS task API version or invalid JSON";
			return false;
		}
		state.apiInfo = payload;
		state.apiAvailable = true;
		state.lastError = undefined;
		return true;
	} catch (error) {
		state.lastError = error instanceof Error ? error.message : String(error);
		return false;
	}
}

export async function candidateRoot(pi: ExtensionAPI, candidate: string, cwd: string): Promise<CandidateRootResult | undefined> {
	try {
		return await runAgentsJson<CandidateRootResult>(pi, { scriptName: "task-candidate-root.sh", args: ["--candidate", candidate, "--cwd", cwd], cwd, timeout: 5_000, versionKey: "task_api_version", expectedVersion: SUPPORTED_TASK_API_VERSION });
	} catch {
		return undefined;
	}
}

export async function discoverTask(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<TaskDiscoverResult | undefined> {
	try {
		return await runAgentsJson<TaskDiscoverResult>(pi, { scriptName: "task-discover.sh", args: ["--cwd", cwd, "--runtime", "pi", "--session", sessionId], cwd, timeout: 5_000, versionKey: "task_api_version", expectedVersion: SUPPORTED_TASK_API_VERSION });
	} catch {
		return undefined;
	}
}

export async function classifyTask(pi: ExtensionAPI, prompt: string, cwd: string): Promise<TaskClassification | undefined> {
	try {
		return await withPrivateTempTextFile("pi-task-classify-", prompt, async (promptFile) => runAgentsJson<TaskClassification>(pi, { scriptName: "task-classify.sh", args: ["--prompt-file", promptFile, "--cwd", cwd], cwd, timeout: 5_000, versionKey: "task_api_version", expectedVersion: SUPPORTED_TASK_API_VERSION }));
	} catch {
		return undefined;
	}
}
