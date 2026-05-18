import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";

const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;

export type AgentsScriptResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

export type AgentsJsonOptions = {
	scriptName: string;
	args?: string[];
	cwd: string;
	timeout?: number;
	versionKey?: string;
	expectedVersion?: number | string;
};

export async function runAgentsScript(pi: ExtensionAPI, scriptName: string, args: string[], cwd: string, timeout = DEFAULT_SCRIPT_TIMEOUT_MS): Promise<AgentsScriptResult> {
	return pi.exec("bash", [agentsScriptPath(scriptName), ...args], { cwd, timeout });
}

export function shortAgentsScriptError(result: AgentsScriptResult): string {
	return (result.stderr || result.stdout || `exit ${result.code}`).replace(/\s+/g, " ").trim().slice(0, 500);
}

export function agentsJsonPayload<T extends JsonObject>(result: AgentsScriptResult, versionKey?: string, expectedVersion?: number | string): T | undefined {
	if (result.code !== 0) return undefined;
	const payload = parseJson<T>(result.stdout);
	if (!payload) return undefined;
	if (versionKey && expectedVersion !== undefined && payload[versionKey] !== expectedVersion) return undefined;
	return payload;
}

export async function runAgentsJson<T extends JsonObject>(pi: ExtensionAPI, options: AgentsJsonOptions): Promise<T | undefined> {
	const result = await runAgentsScript(pi, options.scriptName, options.args ?? [], options.cwd, options.timeout);
	return agentsJsonPayload<T>(result, options.versionKey, options.expectedVersion);
}
