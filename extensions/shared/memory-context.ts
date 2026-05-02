import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { agentsScriptPath } from "./config";

export type MemoryContextScope = {
	projectRoot?: string;
	taskId?: string;
};

export type MemoryContextResult = {
	content?: string;
	reason?: string;
	included: number;
	omitted: number;
};

type MemoryPayload = {
	memory_api_version?: number;
	context?: string;
	included?: unknown[];
	omitted?: unknown[];
};

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export async function buildMemoryContext(pi: ExtensionAPI, cwd: string, scope: MemoryContextScope): Promise<MemoryContextResult> {
	if (!scope.projectRoot) return { reason: "no scoped project root", included: 0, omitted: 0 };
	try {
		const args = [
			agentsScriptPath("memory-context.sh"),
			"--project-root", scope.projectRoot,
			"--cwd", cwd,
			"--max-records", "5",
			"--max-chars", "2000",
			"--json",
		];
		if (scope.taskId) args.push("--task-id", scope.taskId);
		const result = await pi.exec("bash", args, { cwd, timeout: 5_000 });
		if (result.code !== 0) return { reason: "memory API unavailable", included: 0, omitted: 0 };
		const payload = parseJson<MemoryPayload>(result.stdout);
		if (payload?.memory_api_version !== 1) return { reason: "memory API unavailable", included: 0, omitted: 0 };
		const content = payload.context?.trim() || undefined;
		const included = Array.isArray(payload.included) ? payload.included.length : 0;
		const omitted = Array.isArray(payload.omitted) ? payload.omitted.length : 0;
		return { content, reason: content ? undefined : "no approved scoped memory", included, omitted };
	} catch {
		return { reason: "memory API unavailable", included: 0, omitted: 0 };
	}
}
