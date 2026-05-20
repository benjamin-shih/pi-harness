import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assembleAmbientContext, type AmbientContextAssembly } from "../shared/ambient-context";
import { decideAmbientPolicy, shouldIncludeMemoryContext, shouldIncludeRepoContext } from "../shared/ambient-policy";
import { buildExecutionRouteState } from "../shared/execution-guidance";
import { buildMemoryContext } from "../shared/memory-context";
import type { TaskWeight } from "../shared/prompt-guidance";
import { buildRepoContextSummary } from "../shared/repo-context";
import { buildAmbientLanes } from "./ambient-lane-registry";

export type AmbientTurnTaskScope = {
	taskId?: string;
	projectRoot?: string;
};

export type AmbientTurnInput = {
	baseSystemPrompt: string;
	prompt: string;
	weight: TaskWeight;
	activeMode?: string;
	taskContext?: string;
	taskScope: AmbientTurnTaskScope;
};

export type AmbientTurnResult = AmbientContextAssembly;

export async function buildAmbientTurn(pi: ExtensionAPI, ctx: ExtensionContext, input: AmbientTurnInput): Promise<AmbientTurnResult> {
	const policy = decideAmbientPolicy(input.weight);
	const includeRepo = shouldIncludeRepoContext(policy);
	const includeMemory = shouldIncludeMemoryContext(policy);
	const repoSummaryPromise = includeRepo ? buildRepoContextSummary(pi, ctx.cwd) : Promise.resolve(undefined);
	const executionPromise = buildExecutionRouteState(pi, ctx.cwd, input.prompt);
	const memoryPromise = includeMemory && input.taskScope.projectRoot
		? buildMemoryContext(pi, ctx.cwd, { projectRoot: input.taskScope.projectRoot, taskId: input.taskScope.taskId })
		: repoSummaryPromise.then((repoSummary) => {
			const memoryProjectRoot = input.taskScope.projectRoot || repoSummary?.root;
			return includeMemory ? buildMemoryContext(pi, ctx.cwd, { projectRoot: memoryProjectRoot, taskId: input.taskScope.taskId }) : undefined;
		});
	const [repoSummary, memoryContext, executionRoute] = await Promise.all([repoSummaryPromise, memoryPromise, executionPromise]);
	return assembleAmbientContext(input.baseSystemPrompt, input.weight, buildAmbientLanes({
		...input,
		memoryContext,
		executionRoute,
		repoSummary,
	}), policy);
}
