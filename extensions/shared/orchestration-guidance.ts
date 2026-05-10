import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";
import { withPrivateTempTextFile } from "./private-temp";

export type OrchestrationTaskShape = "coding" | "research" | "release" | "maintenance" | "coursework" | "documentation" | "discussion" | "general";
export type OrchestrationComplexity = "trivial" | "standard" | "complex";
export type OrchestrationRisk = "low" | "medium" | "high";
export type OrchestrationRunShape = "direct_answer" | "main_agent" | "main_agent_plus_reviewer" | "parallel_recon" | "war_room";
export type OrchestrationDecisionStatus = "routed" | "trivial" | "script_error" | "invalid_json" | "unsupported_api" | "invalid_payload" | "exception";
export type OrchestrationDecisionHealth = "ok" | "inactive" | "degraded";

export type OrchestrationProject = {
	name: string;
	root: string;
	type: string;
	bindable?: boolean;
	reason?: string;
	registry_id?: string;
	registered?: boolean;
	match_type?: string;
	steward?: string;
	default_checks?: string[];
	write_policy?: string;
	coursework_policy?: string;
	local_instructions_required?: boolean;
};

export type OrchestrationSubagent = { role: string; when: string; cwd: string; mode: string; constraints?: string[] };

export type HtmlArtifactDecision = {
	publish_policy?: string;
	source_of_truth?: string;
	recommended?: Array<{ mode?: string; reason?: string }>;
	modes?: Array<{ id?: string; name?: string; description?: string; section_policy?: string }>;
	auto_open?: { enabled?: boolean; when?: string; modes?: string[]; safety?: string[] };
	long_response?: { enabled?: boolean; trigger?: string; preferred_modes?: string[]; preferred_templates?: string[]; chat_response?: string; guidance?: string[] };
	authoring?: { default_voice?: string; structure_policy?: string; template_role?: string; title_style?: string; style_rules?: string[]; avoid_phrasing?: string[] };
	template?: { id?: string; path?: string; usage?: string; theme_source?: string; theme_notes?: string[]; allowed_components?: string[] };
	templates?: Array<{ id?: string; path?: string; usage?: string; allowed_components?: string[] }>;
	retention?: { default_scope?: string; cleanup_strategy?: string; delete_on_task_status?: string[]; keep_on_task_status?: string[]; marker?: string; persistent_requires_explicit_user_request?: boolean };
	safety?: string[];
	constraints?: string[];
};

export type DelegationWorkflow = {
	authority?: string;
	launch_policy?: string;
	auto_launch?: boolean;
	recommended_pattern?: string;
	next_action?: string;
	allowed_roles?: string[];
	subagent_contracts?: Array<{ role?: string; mode?: string; when?: string; may_write?: boolean; requires_explicit_scope?: boolean }>;
	deferred_contracts?: Array<{ role?: string; mode?: string; when?: string }>;
	single_writer?: { default?: boolean; writer?: string; worker_allowed_after_explicit_scope?: boolean; parallel_writes_allowed?: boolean };
	coordination?: { intercom?: string; progress_updates?: string; completion_handoffs?: string };
	control?: { needs_attention?: string; interrupt?: string; resume?: string };
	tracking?: { pairing_key?: string; mismatch_policy?: string; stale_choice_policy?: string };
	guardrails?: string[];
};

export type OrchestrationDecision = {
	decision_id?: string;
	task: { shape: OrchestrationTaskShape; complexity: OrchestrationComplexity; risk: OrchestrationRisk };
	project: OrchestrationProject;
	route: { run: { shape: OrchestrationRunShape; summary: string }; reasons?: string[] };
	topology: { recommended: string; name?: string; reason: string; description?: string; advisory_only: boolean; allowed_roles?: string[]; subagents: OrchestrationSubagent[] };
	gates: { ids: string[]; preflight: Array<{ id: string; description?: string }>; execution: Array<{ id: string; description?: string }>; verification: Array<{ id: string; description?: string }>; final: Array<{ id: string; description?: string }> };
	memory: { ambient_reads: "allowed" | "skipped" | "unavailable"; durable_writes: "explicit_only"; reason?: string };
	delegation_workflow?: DelegationWorkflow;
	artifacts?: { html?: HtmlArtifactDecision };
	checks: string[];
	stop_conditions: string[];
	evidence_required: string[];
	human_decisions: string[];
	guidance: string;
	reasons: string[];
	warnings?: string[];
	notices?: string[];
};

export type OrchestrationDecisionState = {
	health: OrchestrationDecisionHealth;
	status: OrchestrationDecisionStatus;
	apiVersion?: number;
	summary: string;
	decision?: OrchestrationDecision;
};

type OrchestrationDecisionPayload = OrchestrationDecision & {
	orchestration_api_version?: number;
	kind?: string;
	read_only?: boolean;
};

const SUPPORTED_ORCHESTRATION_API_VERSION = 1;

function state(health: OrchestrationDecisionHealth, status: OrchestrationDecisionStatus, summary: string, apiVersion?: number, decision?: OrchestrationDecision): OrchestrationDecisionState {
	return { health, status, summary, ...(apiVersion === undefined ? {} : { apiVersion }), ...(decision ? { decision } : {}) };
}

function summarize(decision: OrchestrationDecision): string {
	return `${decision.task.shape}/${decision.task.complexity}/${decision.task.risk}; ${decision.topology.recommended}; project ${decision.project.name}`;
}

function stateFromPayload(payload: OrchestrationDecisionPayload | undefined): OrchestrationDecisionState {
	if (!payload) return state("degraded", "invalid_json", "degraded · invalid_json");
	const apiVersion = payload.orchestration_api_version;
	if (apiVersion !== SUPPORTED_ORCHESTRATION_API_VERSION) return state("degraded", "unsupported_api", "degraded · unsupported_api", apiVersion);
	if (payload.kind !== "orchestration_decision" || payload.read_only !== true || !payload.task || !payload.project || !payload.route || !payload.topology || !payload.gates || !payload.guidance?.trim()) return state("degraded", "invalid_payload", "degraded · invalid_payload", apiVersion);
	const decision: OrchestrationDecision = {
		decision_id: payload.decision_id,
		task: payload.task,
		project: payload.project,
		route: payload.route,
		topology: { ...payload.topology, subagents: payload.topology.subagents ?? [] },
		gates: payload.gates,
		memory: payload.memory ?? { ambient_reads: "unavailable", durable_writes: "explicit_only" },
		delegation_workflow: payload.delegation_workflow,
		artifacts: payload.artifacts,
		checks: payload.checks ?? [],
		stop_conditions: payload.stop_conditions ?? [],
		evidence_required: payload.evidence_required ?? [],
		human_decisions: payload.human_decisions ?? [],
		guidance: payload.guidance,
		reasons: payload.reasons ?? [],
		warnings: payload.warnings ?? [],
		notices: payload.notices ?? [],
	};
	if (decision.task.complexity === "trivial" || decision.route.run.shape === "direct_answer") return state("inactive", "trivial", summarize(decision), apiVersion, decision);
	return state("ok", "routed", summarize(decision), apiVersion, decision);
}

export async function buildOrchestrationDecisionState(pi: ExtensionAPI, cwd: string, prompt: string): Promise<OrchestrationDecisionState> {
	try {
		return await withPrivateTempTextFile("pi-orchestration-decision-", prompt, async (promptFile) => {
			const result = await pi.exec("bash", [agentsScriptPath("orchestration-decision.sh"), "--prompt-file", promptFile, "--cwd", cwd, "--json"], { cwd, timeout: 5_000 });
			if (result.code !== 0) return state("degraded", "script_error", "degraded · script_error");
			return stateFromPayload(parseJson<OrchestrationDecisionPayload>(result.stdout));
		});
	} catch {
		return state("degraded", "exception", "degraded · exception");
	}
}

function listLine(label: string, items: string[]): string {
	return `- ${label}: ${items.length ? items.slice(0, 6).join("; ") : "none"}`;
}

function projectDetailLines(project: OrchestrationProject): string[] {
	const lines = [
		`- project: ${project.name} (${project.type})`,
		`- project root: ${project.root}`,
	];
	if (project.registry_id || project.match_type) lines.push(`- registry: ${project.registry_id || "unregistered"}${project.match_type ? ` via ${project.match_type}` : ""}`);
	if (project.steward) lines.push(`- steward: ${project.steward}`);
	if (project.write_policy || project.coursework_policy) lines.push(`- policy: write ${project.write_policy || "unknown"}; coursework ${project.coursework_policy || "none"}`);
	if (project.default_checks?.length) lines.push(listLine("default checks", project.default_checks));
	return lines;
}

function gateDescriptions(decision: OrchestrationDecision): string[] {
	const all = [...decision.gates.preflight, ...decision.gates.execution, ...decision.gates.verification, ...decision.gates.final];
	return all.map((gate) => `${gate.id}${gate.description ? `: ${gate.description}` : ""}`);
}

function delegationWorkflowLines(decision: OrchestrationDecision): string[] {
	const workflow = decision.delegation_workflow;
	if (!workflow) return ["- delegation launch: no decision"];
	const contracts = workflow.subagent_contracts?.map((item) => `${item.role || "unknown"} (${item.mode || "unknown"})`).filter(Boolean) ?? [];
	return [
		`- delegation launch: ${workflow.launch_policy || "manual_main_agent_only"}; auto-launch ${workflow.auto_launch ? "yes" : "no"}`,
		`- delegation pattern: ${workflow.recommended_pattern || "none"}`,
		`- delegation next action: ${workflow.next_action || "none"}`,
		listLine("delegation contracts", contracts),
		`- delegation coordination: progress ${workflow.coordination?.progress_updates || "unknown"}; intercom ${workflow.coordination?.intercom || "unknown"}`,
		`- delegation tracking: ${workflow.tracking?.mismatch_policy || "no mismatch policy"}`,
	];
}

function htmlArtifactLines(decision: OrchestrationDecision): string[] {
	const html = decision.artifacts?.html;
	if (!html) return ["- html artifacts: none"];
	const modes = html.modes?.map((mode) => mode.id || "").filter(Boolean) ?? [];
	const safety = html.safety ?? [];
	const components = html.template?.allowed_components ?? [];
	const templates = html.templates?.map((item) => item.id || "").filter(Boolean) ?? [];
	const autoOpen = html.auto_open?.enabled ? "enabled for local files after creation" : "disabled";
	const longResponse = html.long_response?.enabled === false ? "disabled" : (html.long_response?.chat_response || "concise_summary_plus_local_artifact_path_and_next_action");
	const structure = html.authoring?.structure_policy || "content_first_flexible";
	const titleStyle = html.authoring?.title_style || "compact_first_screen_readable";
	return [
		`- html artifacts: ${modes.length ? modes.slice(0, 4).join(", ") : "none"}`,
		`- html template: ${html.template?.path || html.template?.id || "none"}`,
		listLine("html templates", templates),
		listLine("html components", components),
		`- html publish: ${html.publish_policy || "explicit_only"}; source of truth ${html.source_of_truth || "json_or_markdown"}`,
		`- html auto-open: ${autoOpen}`,
		`- html long responses: ${longResponse}`,
		`- html structure: ${structure}; templates guide presentation, not a fixed outline`,
		`- html title style: ${titleStyle}`,
		`- html retention: ${html.retention?.cleanup_strategy || "manifest_and_marker"}; delete marked task-scoped artifacts on ${(html.retention?.delete_on_task_status ?? ["completed", "stale"]).join("/")}`,
		listLine("html safety", safety),
	];
}

export function formatRunCard(state: OrchestrationDecisionState): string {
	if (!state.decision) return ["## Run card", `- status: ${state.status}`, `- health: ${state.health}`, `- summary: ${state.summary}`].join("\n");
	const decision = state.decision;
	const subagents = decision.topology.subagents.length ? decision.topology.subagents.map((item) => `${item.role} (${item.mode}) when ${item.when}`).slice(0, 6) : ["none"];
	return [
		"## Run card",
		`- health: ${state.health} (${state.status}; v${state.apiVersion ?? "?"})`,
		"- mode: read-only orchestration decision; main/front-door agent remains accountable",
		`- task: ${decision.task.shape}; complexity ${decision.task.complexity}; risk ${decision.task.risk}`,
		...projectDetailLines(decision.project),
		`- topology: ${decision.topology.recommended}; ${decision.topology.reason}`,
		`- run shape: ${decision.route.run.shape}`,
		`- run summary: ${decision.route.run.summary}`,
		`- memory: ambient reads ${decision.memory.ambient_reads}; durable writes ${decision.memory.durable_writes}`,
		...delegationWorkflowLines(decision),
		...htmlArtifactLines(decision),
		listLine("subagents", subagents),
		listLine("gate ids", decision.gates.ids),
		listLine("gates", gateDescriptions(decision)),
		listLine("checks", decision.checks),
		listLine("evidence", decision.evidence_required),
		listLine("human decisions", decision.human_decisions),
		listLine("stop conditions", decision.stop_conditions),
		listLine("warnings", decision.warnings ?? []),
		listLine("notices", decision.notices ?? []),
		"",
		decision.guidance,
	].join("\n");
}
