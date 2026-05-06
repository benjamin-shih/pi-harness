import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { assembleAmbientContext, type AmbientContextAssembly, type AmbientContextLane } from "../shared/ambient-context";
import { decideAmbientPolicy, shouldIncludeMemoryContext, shouldIncludeRepoContext } from "../shared/ambient-policy";
import { buildExecutionRouteState, type ExecutionRouteState } from "../shared/execution-guidance";
import { buildMemoryContext, memoryAdminGuidance, memoryCandidateReminder, type MemoryContextResult } from "../shared/memory-context";
import {
	cleanupReminder,
	DISPLAY_MATH_RENDERING_INSTRUCTION,
	MARKDOWN_HEADING_RENDERING_INSTRUCTION,
	skillRoutingReminder,
	type TaskWeight,
} from "../shared/prompt-guidance";
import { buildRepoContextSummary, formatRepoContext, type RepoContextSummary } from "../shared/repo-context";
import { buildSubagentTopologyReminder } from "../shared/subagent-topology";
import { modeInstructions } from "./modes";

type AmbientTurnTaskScope = {
	taskId?: string;
	projectRoot?: string;
};

type AmbientTurnInput = {
	baseSystemPrompt: string;
	prompt: string;
	weight: TaskWeight;
	activeMode?: string;
	taskContext?: string;
	taskScope: AmbientTurnTaskScope;
};

type AmbientLaneInput = Pick<AmbientTurnInput, "prompt" | "weight" | "activeMode" | "taskContext"> & {
	memoryContext?: MemoryContextResult;
	executionRoute?: ExecutionRouteState;
	repoSummary?: RepoContextSummary;
};

function executionLaneReason(route: ExecutionRouteState | undefined): string {
	return route?.health === "degraded" ? `execution-route degraded: ${route.status}` : "no explicit execution intent";
}

function buildAmbientLanes(input: AmbientLaneInput): AmbientContextLane[] {
	const repoContext = input.repoSummary ? formatRepoContext(input.repoSummary) : undefined;
	return [
		{ id: "display_math", title: "Display math rendering", priority: 10, content: DISPLAY_MATH_RENDERING_INSTRUCTION },
		{ id: "markdown_heading", title: "Markdown heading rendering", priority: 20, content: MARKDOWN_HEADING_RENDERING_INSTRUCTION },
		{ id: "mode", title: "Active harness mode", priority: 30, content: modeInstructions(input.activeMode), reason: "no active mode override" },
		{ id: "skill_routing", title: "Skill routing", priority: 40, content: skillRoutingReminder(input.weight), reason: "trivial prompt" },
		{ id: "cleanup", title: "Post-change cleanup gate", priority: 50, content: cleanupReminder(input.prompt, input.weight), reason: "non-coding prompt" },
		{ id: "subagent_topology", title: "Subagent topology", priority: 55, content: buildSubagentTopologyReminder(input.prompt, input.weight), reason: "not a detailed subagent-worthy prompt" },
		{ id: "agents_task", title: "Active AGENTS task context", priority: 60, content: input.taskContext, reason: "no scoped active task context" },
		{ id: "memory", title: "Approved scoped memory", priority: 65, content: input.memoryContext?.content, reason: input.memoryContext?.reason ?? "memory disabled" },
		{ id: "memory_candidates", title: "Durable memory candidates", priority: 66, content: memoryCandidateReminder(input.weight !== "trivial"), reason: "trivial prompt" },
		{ id: "memory_admin", title: "Explicit memory admin", priority: 67, content: memoryAdminGuidance(input.prompt), reason: "no explicit memory admin request" },
		{
			id: "execution",
			title: "Ambient execution protocol",
			priority: 68,
			content: input.executionRoute?.route?.guidance,
			publicSummary: input.executionRoute?.route?.summary,
			reason: executionLaneReason(input.executionRoute),
			executionRouteState: input.executionRoute,
		},
		{ id: "repo", title: "Repo metadata", priority: 70, content: repoContext, reason: input.repoSummary?.summary ?? "trivial prompt" },
	];
}

export async function buildAmbientTurn(pi: ExtensionAPI, ctx: ExtensionContext, input: AmbientTurnInput): Promise<AmbientContextAssembly> {
	const policy = decideAmbientPolicy(input.weight);
	const repoSummary = shouldIncludeRepoContext(policy) ? await buildRepoContextSummary(pi, ctx.cwd) : undefined;
	const memoryProjectRoot = input.taskScope.projectRoot || repoSummary?.root;
	const memoryContext = shouldIncludeMemoryContext(policy) ? await buildMemoryContext(pi, ctx.cwd, { projectRoot: memoryProjectRoot, taskId: input.taskScope.taskId }) : undefined;
	const executionRoute = await buildExecutionRouteState(pi, ctx.cwd, input.prompt);
	return assembleAmbientContext(input.baseSystemPrompt, input.weight, buildAmbientLanes({
		...input,
		memoryContext,
		executionRoute,
		repoSummary,
	}), policy);
}
