import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { agentsScriptPath } from "../shared/config";
import { parseJson } from "../shared/json";
import { withPrivateTempTextFile } from "../shared/private-temp";
import {
	SUPPORTED_TASK_API_VERSION,
	type CandidateRootResult,
	type ExecResult,
	type TaskApiInfo,
	type TaskClassification,
	type TaskLayerState,
} from "./task-layer-types";

const SCRIPT_TIMEOUT_MS = 10_000;

export async function runScript(pi: ExtensionAPI, scriptName: string, args: string[], cwd: string, timeout = SCRIPT_TIMEOUT_MS): Promise<ExecResult> {
	return pi.exec("bash", [agentsScriptPath(scriptName), ...args], { cwd, timeout });
}

export function shortError(result: ExecResult): string {
	return (result.stderr || result.stdout || `exit ${result.code}`).replace(/\s+/g, " ").trim().slice(0, 500);
}

export async function ensureTaskApi(pi: ExtensionAPI, state: TaskLayerState, cwd: string): Promise<boolean> {
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

export async function candidateRoot(pi: ExtensionAPI, candidate: string, cwd: string): Promise<CandidateRootResult | undefined> {
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

export async function classifyTask(pi: ExtensionAPI, prompt: string, cwd: string): Promise<TaskClassification | undefined> {
	try {
		return await withPrivateTempTextFile("pi-task-classify-", prompt, async (promptFile) => {
			const result = await runScript(pi, "task-classify.sh", ["--prompt-file", promptFile, "--cwd", cwd], cwd, 5_000);
			if (result.code !== 0) return undefined;
			const payload = parseJson<TaskClassification>(result.stdout);
			if (!payload) return undefined;
			return payload.task_api_version === SUPPORTED_TASK_API_VERSION ? payload : undefined;
		});
	} catch {
		return undefined;
	}
}
