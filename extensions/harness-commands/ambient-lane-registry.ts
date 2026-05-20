import type { AmbientContextLane } from "../shared/ambient-context";
import { formatExecutionFactCard, type ExecutionRouteState } from "../shared/execution-guidance";
import { largeResponseHtmlGuidance } from "../shared/large-response-html";
import { memoryAdminGuidance, memoryCandidateReminder, type MemoryContextResult } from "../shared/memory-context";
import {
	cleanupReminder,
	DISPLAY_MATH_RENDERING_INSTRUCTION,
	gitPushReminder,
	MARKDOWN_HEADING_RENDERING_INSTRUCTION,
	qmdRetrievalGuidance,
	skillRoutingReminder,
	type TaskWeight,
} from "../shared/prompt-guidance";
import { formatRepoContext, type RepoContextSummary } from "../shared/repo-context";
import { buildSubagentTopologyReminder } from "../shared/subagent-topology";
import { modeInstructions } from "./modes";

export type AmbientLaneBuildInput = {
	prompt: string;
	weight: TaskWeight;
	activeMode?: string;
	taskContext?: string;
	memoryContext?: MemoryContextResult;
	executionRoute?: ExecutionRouteState;
	repoSummary?: RepoContextSummary;
};

type AmbientLaneParts = Omit<AmbientContextLane, "id" | "title" | "priority">;

export type AmbientLaneDefinition = {
	id: string;
	title: string;
	priority: number;
	build: (input: AmbientLaneBuildInput) => AmbientContextLane;
};

function lane(id: string, title: string, priority: number, build: (input: AmbientLaneBuildInput) => AmbientLaneParts): AmbientLaneDefinition {
	return { id, title, priority, build: (input) => ({ id, title, priority, ...build(input) }) };
}

function executionLaneReason(route: ExecutionRouteState | undefined): string {
	return route?.health === "degraded" ? `execution-route degraded: ${route.status}` : "no explicit execution intent";
}

export const AMBIENT_LANE_REGISTRY = [
	lane("display_math", "Display math rendering", 10, () => ({ content: DISPLAY_MATH_RENDERING_INSTRUCTION })),
	lane("markdown_heading", "Markdown heading rendering", 20, () => ({ content: MARKDOWN_HEADING_RENDERING_INSTRUCTION })),
	lane("mode", "Active harness mode", 30, (input) => ({ content: modeInstructions(input.activeMode), reason: "no active mode override" })),
	lane("skill_routing", "Skill routing", 40, (input) => ({ content: skillRoutingReminder(input.weight), reason: "trivial prompt" })),
	lane("qmd_retrieval", "QMD Markdown retrieval", 45, (input) => ({ content: qmdRetrievalGuidance(input.prompt, input.weight), reason: "not a markdown-heavy retrieval prompt" })),
	lane("cleanup", "Post-change cleanup gate", 50, (input) => ({ content: cleanupReminder(input.prompt, input.weight), reason: "non-coding prompt" })),
	lane("git_push", "Git push default", 52, (input) => ({ content: gitPushReminder(input.prompt, input.weight), reason: "non-coding prompt" })),
	lane("subagent_topology", "Subagent topology", 55, (input) => ({ content: buildSubagentTopologyReminder(input.prompt, input.weight), reason: "not a detailed subagent-worthy prompt" })),
	lane("large_response_html", "Large response HTML medium", 58, (input) => ({ content: largeResponseHtmlGuidance(input.prompt, input.weight, input.taskContext), reason: "not a long/structured report-style deliverable" })),
	lane("agents_task", "Active AGENTS task context", 60, (input) => ({ content: input.taskContext, reason: "no scoped active task context" })),
	lane("memory", "Approved scoped memory", 65, (input) => ({ content: input.memoryContext?.content, reason: input.memoryContext?.reason ?? "memory disabled" })),
	lane("memory_candidates", "Durable memory candidates", 66, (input) => ({ content: memoryCandidateReminder(input.weight !== "trivial"), reason: "trivial prompt" })),
	lane("memory_admin", "Explicit memory admin", 67, (input) => ({ content: memoryAdminGuidance(input.prompt), reason: "no explicit memory admin request" })),
	lane("execution", "Ambient execution route", 68, (input) => ({
		content: formatExecutionFactCard(input.executionRoute),
		publicSummary: input.executionRoute?.route?.summary,
		reason: executionLaneReason(input.executionRoute),
		executionRouteState: input.executionRoute,
	})),
	lane("repo", "Repo metadata", 70, (input) => ({ content: input.repoSummary ? formatRepoContext(input.repoSummary) : undefined, reason: input.repoSummary?.summary ?? "trivial prompt" })),
];

export function buildAmbientLanes(input: AmbientLaneBuildInput): AmbientContextLane[] {
	return AMBIENT_LANE_REGISTRY.map((definition) => definition.build(input));
}
