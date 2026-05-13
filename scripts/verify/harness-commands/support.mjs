import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assert, loadExtension, root, withEnv } from "../harness.mjs";

export { assert, root, withEnv, join };

export const harnessCommands = loadExtension("extensions/harness-commands.ts");
export const homeRoot = homedir();
export const agentsRoot = process.env.AGENTS_SHARED_ROOT || join(homeRoot, ".agents");
export const agentsTasksRoot = join(agentsRoot, "tasks");

export const taskBindPayload = (overrides = {}) => ({ action: "created", bound: true, blocked: false, reason: "", task_id: "pi-task", project_root: root, ...overrides });
export const taskDiscoverPayload = (overrides = {}) => ({ task_api_version: 1, found: true, task_id: "pi-task", project_root: root, task_project_root: root, blocked: false, reason: "", ...overrides });
export const memoryReviewPayload = (overrides = {}) => ({ memory_api_version: 1, count: 0, skipped: 0, candidates: [], omitted: [], scope: { project: true, task: true, global: false, all: false }, warnings: [], ...overrides });
export const controlPlaneRoutePayload = (overrides = {}) => ({
	control_plane_api_version: 1,
	kind: "route",
	task: { shape: "coding", complexity: "standard", risk: "low" },
	project: { name: "project", root, type: "repo", bindable: true, reason: "project_path", registry_id: "project", registered: true, match_type: "cwd", steward: "project-steward", default_checks: ["make verify"], write_policy: "single_writer", coursework_policy: "none", local_instructions_required: true },
	run: { shape: "main_agent", summary: "front-door main agent remains accountable; recommended main agent" },
	delegation: [],
	gates: ["inspect repo/project state before edits", "verify with the narrowest meaningful local check"],
	evidence_required: ["commands/checks run", "files changed or confirmed unchanged"],
	human_decisions: [],
	stop_rules: ["stop if local instructions conflict with the request"],
	guidance: "## Orchestration Guidance\n- shape: coding; complexity: standard; risk: low\n- project: project (repo)\n- run: main_agent; front-door main agent remains accountable",
	reasons: ["deterministic heuristic route"],
	warnings: [],
	...overrides,
});
export const controlPlaneDecisionPayload = (overrides = {}) => {
	const baseRoute = controlPlaneRoutePayload();
	return {
		orchestration_api_version: 1,
		kind: "orchestration_decision",
		generated_at: "2026-05-08T00:00:00Z",
		cwd: root,
		read_only: true,
		decision_id: "decision123",
		task: baseRoute.task,
		project: baseRoute.project,
		route: { run: baseRoute.run, reasons: baseRoute.reasons },
		topology: { recommended: "single_agent_standard", name: "Single-agent standard", reason: "standard task fits main-agent execution with normal gates", description: "Main agent handles the work with normal verification gates.", advisory_only: true, allowed_roles: ["reviewer"], subagents: [] },
		gates: { ids: ["repo_clean_preflight", "narrow_verification", "diff_inspection", "no_hidden_memory_writes", "final_evidence_report"], preflight: [{ id: "repo_clean_preflight", description: "Inspect repository/project state before edits" }], execution: [{ id: "no_hidden_memory_writes", description: "Do not mutate durable memory without explicit request" }], verification: [{ id: "narrow_verification", description: "Run narrow verification" }, { id: "diff_inspection", description: "Inspect the final diff" }], final: [{ id: "final_evidence_report", description: "Report final evidence" }] },
		memory: { ambient_reads: "allowed", durable_writes: "explicit_only", reason: "bindable scoped project" },
		delegation_workflow: { authority: "main_agent_accountable", launch_policy: "manual_main_agent_only", auto_launch: false, recommended_pattern: "single_writer_optional_review", next_action: "main agent implements; optionally use blocker-only reviewer before final", allowed_roles: ["reviewer"], subagent_contracts: [{ role: "reviewer", mode: "read_only", when: "before final", may_write: false }], deferred_contracts: [], single_writer: { default: true, writer: "main_agent", parallel_writes_allowed: false }, coordination: { intercom: "need_decision_only_by_default", progress_updates: "disabled_unless_requested_or_plan_changes", completion_handoffs: "return_results_to_parent_not_routine_intercom" }, control: { needs_attention: "surface factual no-activity signals", interrupt: "soft-interrupt only when blocked", resume: "resume explicitly" }, tracking: { pairing_key: "decision_id", mismatch_policy: "explain chosen-vs-recommended differences before relying on the choice", stale_choice_policy: "treat unpaired choices as historical" }, guardrails: ["harness and control center must not auto-launch subagents"] },
		artifacts: { html: { publish_policy: "explicit_only", source_of_truth: "json_or_markdown", modes: [{ id: "html_report", section_policy: "suggested_not_required" }], auto_open: { enabled: true, when: "after_local_html_artifact_created", modes: ["html_report"], safety: ["local_file_only", "open_once_per_turn"] }, long_response: { enabled: true, chat_response: "concise_summary_plus_local_artifact_path_and_next_action" }, authoring: { default_voice: "professional_manager_ready", structure_policy: "content_first_flexible", title_style: "compact_first_screen_readable" }, template: { id: "benjamin_local_v1", path: `${agentsRoot}/shared/templates/html-artifacts/benjamin-local-template.html`, usage: "Use as a reusable visual system and component catalog.", theme_source: "https://benjamin-shih.github.io/", allowed_components: ["cards", "tabs", "range_sliders", "sortable_tables"] }, templates: [{ id: "benjamin_local_v1" }, { id: "benjamin_report_v1" }, { id: "benjamin_dashboard_v1" }, { id: "benjamin_article_v1" }], retention: { default_scope: "task_scoped", cleanup_strategy: "manifest_and_marker", delete_on_task_status: ["completed", "stale"], keep_on_task_status: ["created", "in_progress", "paused", "blocked"], marker: "agents-html-artifact", persistent_requires_explicit_user_request: true }, safety: ["no_raw_prompts_or_transcripts"] } },
		checks: ["make verify"],
		stop_conditions: ["stop if local instructions conflict with the request"],
		evidence_required: ["commands/checks run", "files changed or confirmed unchanged"],
		human_decisions: [],
		guidance: "## Orchestration Decision\n- mode: read-only recommendation; main/front-door agent remains accountable\n- task: coding; complexity standard; risk low\n- topology: single_agent_standard; standard task fits main-agent execution with normal gates",
		reasons: ["deterministic heuristic route", "topology=single_agent_standard"],
		warnings: [],
		notices: [],
		...overrides,
	};
};
export const controlPlaneDashboardPayload = (overrides = {}) => ({
	control_plane_api_version: 1,
	kind: "dashboard",
	generated_at: "2026-05-08T00:00:00Z",
	cwd: root,
	read_only: true,
	project: { name: "project", root, type: "repo", registry_id: "project", match_type: "cwd", steward: "project-steward", default_checks: ["make verify"], write_policy: "single_writer", coursework_policy: "none" },
	projects: { count: 1, matched: { id: "project", name: "project", root, type: "repo", match_type: "cwd" } },
	route: null,
	orchestration_decision: null,
	tasks: { available: true, scope: "project", project_scoped: true, summary: { task_packages_scoped: 3, active_tasks: 1, terminal_tasks: 2, stale_tasks: 0, blocked_tasks: 0, live_leases: 1, expired_leases: 0, stale_candidates: 0, artifact_records: 7, event_records: 12 }, active_task: { status: "in_progress", active: true, terminal: false, scope_match: true, lease_state: "live", events_count: 3, blockers_count: 0, recent_events: [{ timestamp: "2026-05-08T00:00:00Z", type: "checkpoint", summary: "checkpoint" }, { timestamp: "2026-05-08T00:01:00Z", type: "orchestration_chosen", summary: "chosen single_agent_standard" }], orchestration: { available: true, status: "mismatch", mismatch: true, explanation: "explicit choice differs from the paired recommendation; explain why before relying on it", recommended_action: "reconfirm topology or record a new choice", events: 2, recommended: { topology: "parallel_recon", gate_ids: ["repo_clean_preflight"] }, chosen: { topology: "single_agent_standard" } } }, orchestration: { available: true, status: "mismatch", mismatch: true, explanation: "explicit choice differs from the paired recommendation; explain why before relying on it", recommended_action: "reconfirm topology or record a new choice", events: 2, recommended: { topology: "parallel_recon", gate_ids: ["repo_clean_preflight"] }, chosen: { topology: "single_agent_standard" } }, warnings: [] },
	async_inbox: { available: true, scope: "project", count: 2, active_items: 1, summary: { by_status: { running: 1, queued: 1 }, by_project: { project: 2 }, active_by_project: { project: 1 }, queued_by_project: { project: 1 } }, warnings: [] },
	html_artifacts: { available: true, scope: "project", project_scoped: true, policy: { cleanup_strategy: "manifest_and_marker", marker: "agents-html-artifact", delete_on_task_status: ["completed", "stale"], destructive_actions: false }, summary: { task_packages_scanned: 3, tracked_html_artifacts: 2, managed_html_artifacts: 2, unmanaged_html_artifacts: 0, cleanup_candidates: 1, kept_active_or_blocked: 1, skipped_missing: 0, skipped_unmarked: 0, skipped_unsafe_path: 0, errors: 0 }, warnings: [] },
	memory: { available: true, count: 2, counts_by_state: { approved: 1, candidate: 1, deprecated: 0 }, skipped: 0, scope: { project: true, task: true, global: false, all: false }, warnings: [] },
	package_policy: { available: true, health: "ok", summary: { configured_packages: 4, approved_packages: 4, unapproved_packages: 0, unpinned_packages: 0, unknown_package_entries: 0, approved_manifest_entries: 4 }, policy: { default_action: "deny", requires_exact_pins: true, runtime_network_checks: false }, warnings: [] },
	project_instructions: { available: true, health: "ok", summary: { instruction_files_found: 2, thin_style_files: 2, dispatch_mentions: 0 }, warnings: [] },
	attention: ["memory candidates pending explicit review"],
	warnings: [],
	...overrides,
});
export const orchestrationPlanPayload = (overrides = {}) => ({
	orchestration_plan_api_version: 1,
	kind: "orchestration_plan",
	generated_at: "2026-05-13T00:00:00Z",
	read_only: true,
	mutating_actions: false,
	auto_launch: false,
	plan_id: "plan123",
	source: { prompt_recorded: true, prompt_digest: "digest", prompt_bytes: 42, raw_prompt_in_output: false, cwd_recorded: true, cwd_digest: "cwddigest", raw_cwd_in_output: false },
	project: { id: "project", name: "Project", type: "repo", registered: true, match_type: "cwd", bindable: true, write_policy: "single_writer", default_checks: ["make verify"], root_recorded: true, root_digest: "rootdigest", workspace: { matched: false } },
	task: { shape: "coding", complexity: "standard", risk: "low" },
	execution: { execution_intent: true, execution_intent_forced: false, profile: "software", overlays: [], summary: "profile software; overlays none", reasons: ["explicit execution intent detected"] },
	topology: { recommended: "single_agent_standard", name: "Single-agent standard", reason: "standard", pattern: "single_writer_optional_review", advisory_only: true },
	autonomy: { mode: "confirm", read_only_auto_run_eligible: false, confirmation_required: true, execute_low_risk_policy: "future adapter may auto-run only read-only role specs when explicitly configured", dashboard_mutations: false },
	private_input_policy: { request_text: "private_prompt_file_or_stdin_only", raw_argv_text_allowed: false, role_prompts: "compose from task_template plus private request context at launch time", worker_summaries: "private_to_parent_until_bounded_synthesis" },
	stages: [{ id: "parallel_recon", kind: "subagent_group", read_only: true, role_ids: ["code_context"] }, { id: "bounded_implementation", kind: "subagent_group", read_only: false, role_ids: ["bounded_implementation"] }, { id: "review", kind: "subagent_group", read_only: true, role_ids: ["implementation_review"] }],
	role_launch_plan: [
		{ id: "code_context", source: "execution_profile_template", phase: "parallel_recon", parallel_group: "recon", agent: "scout", role: "engineering_scout", profile: "software", overlays: [], mode: "read_only", may_write: false, requires_confirmation: false, cwd_policy: { source: "selected_project_root", project_id: "project", path_recorded: true, path_digest: "rootdigest", raw_path_in_output: false }, prompt_policy: "parent supplies request through private prompt file/stdin; do not echo raw request text", task_template: "Inspect code context.", expected_output: "findings", constraints: ["read-only unless a later explicit work order changes scope"] },
		{ id: "bounded_implementation", source: "execution_profile_template", phase: "implementation", parallel_group: "implementation", agent: "worker", role: "implementation_worker", profile: "software", overlays: [], mode: "bounded_write", may_write: true, requires_confirmation: true, cwd_policy: { source: "selected_project_root", project_id: "project", path_recorded: true, path_digest: "rootdigest", raw_path_in_output: false }, prompt_policy: "parent supplies request through private prompt file/stdin; do not echo raw request text", task_template: "Implement bounded code changes.", expected_output: "summary and verification", constraints: ["requires explicit bounded scope and main-agent verification before launch"] },
		{ id: "implementation_review", source: "execution_profile_template", phase: "review", parallel_group: "review", agent: "reviewer", role: "engineering_reviewer", profile: "software", overlays: [], mode: "read_only", may_write: false, requires_confirmation: false, cwd_policy: { source: "selected_project_root", project_id: "project", path_recorded: true, path_digest: "rootdigest", raw_path_in_output: false }, prompt_policy: "parent supplies request through private prompt file/stdin; do not echo raw request text", task_template: "Review implementation plan.", expected_output: "blockers", constraints: ["read-only unless a later explicit work order changes scope"] },
	],
	gates: { ids: ["repo_clean_preflight", "narrow_verification"] },
	checks: ["make verify"],
	evidence_required: ["commands/checks run"],
	human_decisions: [],
	stop_conditions: ["stop if local instructions conflict with the request"],
	next_actions: ["render this plan for the front-door operator"],
	warnings: [],
	notices: [],
	reasons: ["orchestration plan is read-only"],
	guidance: "## Orchestration Plan",
	...overrides,
});
export const executionRoutePayload = (overrides = {}) => ({ execution_route_api_version: 1, execution_intent: true, profile: "software", overlays: [], summary: "profile software; overlays none", guidance: "## Ambient Execution Protocol\nExecution intent was detected.", ...overrides });
export const taskLifecyclePayload = (overrides = {}) => ({
	task_api_version: 1,
	task_id: "pi-task",
	status: "in_progress",
	valid_status: true,
	terminal: false,
	active: true,
	runtime: "pi",
	owner: "tester",
	project_root: root,
	caller_project_root: root,
	scope_match: true,
	next_action: "Continue from latest checkpoint.",
	blockers_count: 0,
	closed_at: "",
	has_closure_reason: false,
	lease: { state: "live", runtime: "pi", owner: "tester", session: "session-1", expires_at: "2026-05-05T00:00:00Z" },
	route: { primary_runtime: "pi", review_runtime: "none", effort: "standard", handoff_required: false },
	events: { count: 3, last_type: "checkpoint", last_timestamp: "2026-05-05T00:00:00Z" },
	...overrides,
});
export const projectInstructionPayload = (overrides = {}) => ({
	instruction_doctor_api_version: 1,
	cwd: root,
	project_root: root,
	health: "ok",
	summary: {
		instruction_files_found: 2,
		thin_style_files: 2,
		dispatch_mentions: 0,
		launcher_mentions: 0,
		task_file_reading_lists: 0,
		duplicated_shared_blocks: 0,
		local_skills_index: false,
	},
	files: [
		{ path: `${root}/AGENTS.md`, exists: true, line_count: 42, has_shared_pointer: true, has_ambient_context: true, thin_style: true, stale: { dispatch_mentions: 0, launcher_mentions: 0, task_file_reading_lists: 0, duplicated_shared_blocks: 0 } },
		{ path: `${root}/CLAUDE.md`, exists: true, line_count: 24, has_shared_pointer: true, has_ambient_context: true, thin_style: true, stale: { dispatch_mentions: 0, launcher_mentions: 0, task_file_reading_lists: 0, duplicated_shared_blocks: 0 } },
	],
	warnings: [],
	...overrides,
});

export const piPackagePolicyPayload = (overrides = {}) => ({
	pi_package_policy_api_version: 1,
	approval_policy_version: 1,
	approval_manifest: join(agentsRoot, "policy", "pi-packages-approved.json"),
	settings_path: join(homeRoot, ".pi", "agent", "settings.json"),
	policy: { default_action: "deny", requires_exact_pins: true, runtime_network_checks: false },
	summary: {
		configured_packages: 4,
		approved_packages: 4,
		unapproved_packages: 0,
		unpinned_packages: 0,
		unknown_package_entries: 0,
		approved_manifest_entries: 4,
		attestation: { verified: 2, mismatch: 0, missing: 0, skipped: 2, unapproved: 0, cache_hit: 2, cache_miss: 0, cache_disabled: 0 },
	},
	packages: [
		{ index: 0, source: "./packages/ben-pi-harness", display_source: "./packages/ben-pi-harness", source_type: "local", pinned: true, approved: true, approval: "trusted_local", reason: "approved" },
		{ index: 1, source: "npm:pi-subagents@0.24.2", display_source: "npm:pi-subagents@0.24.2", source_type: "npm", package: "pi-subagents", version: "0.24.2", pinned: true, approved: true, approval: "quarantine_reviewed", reason: "approved" },
	],
	...overrides,
});

function inboxLaunchSpecPayload() {
	return { backend: "pi_subagents_async", worker_run_id: "iw_submit", params: { agent: "worker", task: "Private request file: /tmp/request", cwd: root, async: true, context: "fresh" } };
}

function inboxTickPayload(args) {
	const executing = args.includes("--execute");
	const launchSpecs = executing ? [inboxLaunchSpecPayload()] : [];
	return {
		inbox_api_version: 1,
		kind: "inbox_tick",
		dry_run: args.includes("--dry-run"),
		mutating_actions: executing,
		worker_launches: false,
		reconcile: executing ? { updated: 0, warnings: [] } : { executed: false, reason: "dry_run" },
		summary: { checked: 1, launchable_count: 1, launch_spec_count: launchSpecs.length, queued_count: 0, needs_user_count: 0, noop_count: 0 },
		schedule: { inbox_api_version: 1, kind: "inbox_schedule", action: "launch", items: [{ action: "launch", reason: "project lane is available", item: { id: "inq_submit", status: executing ? "launching" : "queued", safe_title: "Build Kalshi tool", project: { id: "kalshi", name: "Kalshi" } } }], launch_specs: launchSpecs, warnings: [] },
		launch_specs: launchSpecs,
		warnings: [],
	};
}

export const taskRetentionPayload = (overrides = {}) => ({
	task_api_version: 1,
	dry_run: true,
	scope: "project",
	project_scoped: true,
	thresholds: { stale_hours: 48, terminal_days: 30, artifact_index_warn_bytes: 1048576 },
	policy: { destructive_actions: false, delete_supported: false, archive_supported: true, archive_delete_supported: true },
	summary: {
		task_packages_total: 5,
		task_packages_scoped: 3,
		active_tasks: 1,
		terminal_tasks: 2,
		stale_tasks: 1,
		completed_tasks: 1,
		blocked_tasks: 0,
		live_leases: 1,
		expired_leases: 1,
		missing_leases: 1,
		malformed_status_files: 0,
		malformed_lease_files: 0,
		stale_candidates: 1,
		terminal_retention_candidates: 1,
		artifact_indexes: 2,
		artifact_records: 7,
		artifact_index_bytes: 512,
		oversized_artifact_indexes: 0,
		malformed_artifact_lines: 0,
		event_ledgers: 3,
		event_records: 12,
		event_log_bytes: 2048,
		malformed_event_lines: 0,
		lock_files: 1,
		archive_candidates: 1,
		archived_task_packages_total: 4,
		archived_task_packages_scoped: 2,
		archive_delete_candidates: 1,
		archive_delete_skipped_malformed: 0,
		archive_delete_skipped_checksum: 0,
		archive_delete_skipped_active_slot: 0,
		archive_delete_skipped_blocked: 1,
	},
	...overrides,
});

export async function runRealAgentsTaskLayerTest() {
	const realAgentsRoot = agentsRoot;
	if (!existsSync(join(realAgentsRoot, "scripts", "task-api.sh"))) return;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-agents-task-layer-"));
	const tasksRoot = join(tempRoot, "tasks");
	const projectRoot = join(tempRoot, "project");
	mkdirSync(projectRoot, { recursive: true });
	writeFileSync(join(projectRoot, "AGENTS.md"), "# test project\n");
	writeFileSync(join(projectRoot, "README.md"), "hello\n");
	try {
		await withEnv({ AGENTS_SHARED_ROOT: realAgentsRoot, TASKS_ROOT: tasksRoot }, async () => {
			const handlers = new Map();
			harnessCommands({
				on: (event, handler) => handlers.set(event, handler),
				registerCommand: () => {},
				getAllTools: () => [],
				getActiveTools: () => ["read", "bash"],
				getThinkingLevel: () => "xhigh",
				exec: async (cmd, args, options) => {
					try {
						if (cmd === "git" && args.join(" ") === "rev-parse --show-toplevel") return { code: 0, stdout: `${projectRoot}\n`, stderr: "", killed: false };
						if (cmd === "git" && args.join(" ") === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "", killed: false };
						if (cmd === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=no") return { code: 0, stdout: "", stderr: "", killed: false };
						const stdout = execFileSync(cmd, args, { cwd: options?.cwd || projectRoot, env: process.env, encoding: "utf8", timeout: options?.timeout || 10_000 });
						return { code: 0, stdout, stderr: "", killed: false };
					} catch (error) {
						return { code: error.status ?? 1, stdout: String(error.stdout || ""), stderr: String(error.stderr || error.message || ""), killed: false };
					}
				},
				sendUserMessage: () => {},
			});
			const ctx = {
				cwd: projectRoot,
				model: { provider: "test", id: "model" },
				getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
				sessionManager: {
					getBranch: () => [],
					getSessionId: () => "real-script-session",
					getSessionFile: () => join(tempRoot, "session.jsonl"),
					getLeafId: () => undefined,
				},
			};
			await handlers.get("session_start")({ reason: "startup" }, ctx);
			const result = await handlers.get("before_agent_start")({ prompt: "Analyze real AGENTS task layer integration", systemPrompt: "base" }, ctx);
			assert(result?.systemPrompt.includes("## Active AGENTS Task Context"), "real .agents task-layer test should inject task context");
			await handlers.get("tool_result")({ toolName: "read", input: { path: join(projectRoot, "README.md") }, isError: false }, ctx);
			await handlers.get("agent_end")({}, ctx);
			await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
			const taskDirs = readdirSync(tasksRoot).filter((name) => !name.startsWith("."));
			assert(taskDirs.length === 1, "real .agents task-layer test should create exactly one temp task");
			const taskDir = join(tasksRoot, taskDirs[0]);
			const events = readFileSync(join(taskDir, "events.jsonl"), "utf8");
			assert(events.includes('"type": "checkpoint"'), "real .agents task-layer test should checkpoint through real scripts");
			const lease = JSON.parse(readFileSync(join(taskDir, "lease.json"), "utf8"));
			assert(Boolean(lease.released_at), "real .agents task-layer test should release the temp task lease on shutdown");
		});
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function execSnapshots(snapshots) {
	let index = 0;
	let current = snapshots[0] ?? {};
	return async (_cmd, args) => {
		const key = args.join(" ");
		if (key === "diff --numstat HEAD --") {
			current = snapshots[Math.min(index, Math.max(0, snapshots.length - 1))] ?? {};
			index++;
			return { code: 0, stdout: current.diff ?? "", stderr: "" };
		}
		if (key === "rev-parse HEAD") {
			return { code: 0, stdout: `${current.head ?? "HEAD0"}\n`, stderr: "" };
		}
		if (key.startsWith("diff --numstat ") && key.endsWith(" --") && key !== "diff --numstat HEAD --") {
			const range = args[2];
			return { code: 0, stdout: current.committedDiffs?.[range] ?? "", stderr: "" };
		}
		if (key === "ls-files --others --exclude-standard") {
			return { code: 0, stdout: current.untracked ?? "", stderr: "" };
		}
		if (key.startsWith("diff --numstat --no-index")) {
			const file = args.at(-1);
			return { code: 1, stdout: current.untrackedNumstat?.[file] ?? "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "" };
	};
}

export function createHarness(snapshots) {
	const handlers = new Map();
	const sentUserMessages = [];
	harnessCommands({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: () => {},
		getAllTools: () => [],
		exec: execSnapshots(snapshots),
		sendUserMessage: (message, options) => sentUserMessages.push({ message, options }),
	});
	return {
		beforeAgentStart: handlers.get("before_agent_start"),
		toolCall: handlers.get("tool_call"),
		agentEnd: handlers.get("agent_end"),
		sentUserMessages,
	};
}

export function createTaskHarness({ scriptResults = {}, bindPayload, bindPayloads, taskDiscoverPayload: discoverPayload, classifyPayload, classifyResult, executionPayload, controlPlanePayload, controlPlaneDecisionPayload: decisionPayload, controlPlaneDashboardPayload: dashboardPayload, orchestrationPlanPayload: planPayload, artifactAddPayload, lifecyclePayload, retentionPayload, piPackagePolicyPayload: packagePolicyPayload, memoryContextPayload, memoryStatsPayload, memoryReviewPayload: reviewPayload, cwd = root, gitRoot = root, eventBus, execHook } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const sentMessages = [];
	const execCalls = [];
	const notifications = [];
	const sessionNames = [];
	let sessionName = "parent-session";
	const eventHandlers = new Map();
	const events = eventBus ?? {
		on: (event, handler) => { eventHandlers.set(event, handler); return () => eventHandlers.delete(event); },
		emit: (event, data) => eventHandlers.get(event)?.(data),
		handlers: eventHandlers,
	};
	const queuedBindPayloads = [...(bindPayloads ?? [])];
	const queuedScriptResults = new Map(Object.entries(scriptResults).map(([scriptName, value]) => [scriptName, Array.isArray(value) ? [...value] : value]));
	const scriptResult = (scriptName, call) => {
		if (!queuedScriptResults.has(scriptName)) return undefined;
		const value = queuedScriptResults.get(scriptName);
		const result = Array.isArray(value) ? value.shift() : value;
		return typeof result === "function" ? result(call) : result;
	};
	harnessCommands({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerTool: (tool) => tools.set(tool.name, tool),
		getAllTools: () => [],
		getActiveTools: () => ["read"],
		events,
		getSessionName: () => sessionName,
		setSessionName: (name) => { sessionName = name; sessionNames.push(name); },
		getThinkingLevel: () => "xhigh",
		exec: async (cmd, args, options) => {
			execCalls.push({ cmd, args, cwd: options?.cwd });
			const hooked = await execHook?.(cmd, args, options, execCalls);
			if (hooked !== undefined) return hooked;
			if (cmd === "git" && args.join(" ") === "rev-parse --show-toplevel") return gitRoot ? { code: 0, stdout: `${gitRoot}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "not a git repo" };
			if (cmd === "git" && args.join(" ") === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "" };
			if (cmd === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=no") return { code: 0, stdout: "", stderr: "" };
			if (cmd === "open") return { code: 0, stdout: "", stderr: "" };
			const script = args[0] || "";
			const scriptName = script.split(/[\\/]/).at(-1) || "";
			if (cmd === "bash") {
				const overridden = scriptResult(scriptName, { cmd, args, options });
				if (overridden !== undefined) return overridden;
			}
			if (cmd === "bash" && script.endsWith("task-api.sh")) return { code: 0, stdout: JSON.stringify({ task_api_version: 1, agents_shared_root: agentsRoot, tasks_root: agentsTasksRoot, scripts_dir: join(agentsRoot, "scripts"), capabilities: ["candidate_root_policy", "task_artifacts", "task_lifecycle", "task_close", "task_retention_diagnostics", "task_archive", "html_artifact_cleanup", "project_route", "async_inbox"] }), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-classify.sh")) {
				if (classifyResult) return classifyResult;
				const promptFileIndex = args.indexOf("--prompt-file");
				const promptFile = promptFileIndex >= 0 ? args[promptFileIndex + 1] : undefined;
				if (promptFileIndex >= 0 && (!promptFile || !existsSync(promptFile))) return { code: 1, stdout: "", stderr: "prompt file missing" };
				return { code: 0, stdout: JSON.stringify({ task_api_version: 1, ...(classifyPayload ?? { weight: "standard", binding_mode: "auto" }) }), stderr: "" };
			}
			if (cmd === "bash" && script.endsWith("execution-route.sh")) {
				const promptFileIndex = args.indexOf("--prompt-file");
				const promptFile = promptFileIndex >= 0 ? args[promptFileIndex + 1] : undefined;
				if (promptFileIndex >= 0 && (!promptFile || !existsSync(promptFile))) return { code: 1, stdout: "", stderr: "prompt file missing" };
				return { code: 0, stdout: JSON.stringify(executionPayload ?? { execution_route_api_version: 1, execution_intent: false, profile: null, overlays: [], summary: "", guidance: "", reasons: ["no explicit execution intent"] }), stderr: "" };
			}
			if (cmd === "bash" && script.endsWith("orchestration-plan.sh")) {
				const promptFileIndex = args.indexOf("--prompt-file");
				const promptFile = promptFileIndex >= 0 ? args[promptFileIndex + 1] : undefined;
				if (promptFileIndex >= 0 && (!promptFile || !existsSync(promptFile))) return { code: 1, stdout: "", stderr: "prompt file missing" };
				return { code: 0, stdout: JSON.stringify(planPayload ?? orchestrationPlanPayload()), stderr: "" };
			}
			if (cmd === "bash" && (script.endsWith("control-plane.sh") || script.endsWith("orchestration-decision.sh"))) {
				const promptFileIndex = args.indexOf("--prompt-file");
				const promptFile = promptFileIndex >= 0 ? args[promptFileIndex + 1] : undefined;
				if (promptFileIndex >= 0 && (!promptFile || !existsSync(promptFile))) return { code: 1, stdout: "", stderr: "prompt file missing" };
				if (script.endsWith("orchestration-decision.sh") || args.includes("decision")) return { code: 0, stdout: JSON.stringify(decisionPayload ?? controlPlaneDecisionPayload()), stderr: "" };
				if (args.includes("dashboard")) return { code: 0, stdout: args.includes("--html") ? "<!doctype html><title>Agent Control Center v0</title>" : JSON.stringify(dashboardPayload ?? controlPlaneDashboardPayload()), stderr: "" };
				return { code: 0, stdout: JSON.stringify(controlPlanePayload ?? controlPlaneRoutePayload()), stderr: "" };
			}
			if (cmd === "bash" && script.endsWith("task-candidate-root.sh")) {
				const candidate = args[args.indexOf("--candidate") + 1] || cwd;
				const candidateCwd = args[args.indexOf("--cwd") + 1] || cwd;
				const target = candidate === "~" ? homeRoot : (candidate.startsWith("~/") ? join(homeRoot, candidate.slice(2)) : (candidate.startsWith("/") ? candidate : join(candidateCwd, candidate)));
				const isBootstrap = target === join(homeRoot, "CLAUDE.md") || target.startsWith(join(homeRoot, ".claude")) || target.startsWith(join(agentsRoot, "skills")) || target.startsWith(join(agentsRoot, "shared"));
				const isProject = target.startsWith(root);
				return { code: 0, stdout: JSON.stringify({ task_api_version: 1, candidate: target, cwd: candidateCwd, project_root: isProject ? root : homeRoot, bindable: isProject && !isBootstrap, safe_to_auto_create: isProject && !isBootstrap, bootstrap_path: isBootstrap, auto_create: isProject && !isBootstrap ? "auto" : "never", reason: isProject && !isBootstrap ? "project_path" : (isBootstrap ? "bootstrap_path" : "home_root") }), stderr: "" };
			}
			if (cmd === "bash" && script.endsWith("task-bind.sh")) return { code: 0, stdout: JSON.stringify({ task_api_version: 1, ...(queuedBindPayloads.length ? queuedBindPayloads.shift() : bindPayload) }), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-discover.sh")) return { code: 0, stdout: JSON.stringify(discoverPayload ?? taskDiscoverPayload()), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-context.sh")) return { code: 0, stdout: "Active task context\n- task_id: pi-task\n- next_action: Continue", stderr: "" };
			if (cmd === "bash" && script.endsWith("memory-context.sh")) return { code: 0, stdout: JSON.stringify(memoryContextPayload ?? { memory_api_version: 1, included: [], omitted: [], context: "" }), stderr: "" };
			if (cmd === "bash" && script.endsWith("memory-stats.sh")) return { code: 0, stdout: JSON.stringify(memoryStatsPayload ?? { memory_api_version: 1, counts_by_state: { candidate: 0, approved: 0, deprecated: 0 }, skipped: 0 }), stderr: "" };
			if (cmd === "bash" && script.endsWith("memory-review.sh")) return { code: 0, stdout: JSON.stringify(reviewPayload ?? memoryReviewPayload()), stderr: "" };
			if (cmd === "bash" && script.endsWith("memory-add.sh")) return { code: 0, stdout: JSON.stringify({ memory_api_version: 1, recorded: true, record: { id: "mem_candidate_1", state: "candidate", title: "Memory candidate", scope: { type: args.includes("--scope") ? args[args.indexOf("--scope") + 1] : "project" } } }), stderr: "" };
			if (cmd === "bash" && script.endsWith("inbox-list.sh")) return { code: 0, stdout: JSON.stringify({ inbox_api_version: 1, kind: "inbox_list", count: 1, returned: 1, summary: { by_status: { queued: 1 }, by_project: { kalshi: 1 }, active_by_project: {}, queued_by_project: { kalshi: 1 } }, items: [{ id: "inq_test", status: "queued", safe_title: "Build Kalshi tool", project: { id: "kalshi", name: "Kalshi" }, relation: { kind: "new_task" } }] }), stderr: "" };
			if (cmd === "bash" && script.endsWith("inbox-enqueue.sh")) return { code: 0, stdout: JSON.stringify({ inbox_api_version: 1, kind: "inbox_enqueue", enqueued: true, item: { id: "inq_submit", status: "queued", safe_title: "Build Kalshi tool", project: { id: "kalshi", name: "Kalshi" }, relation: { kind: "new_parallel_candidate", target_item_id: "inq_existing" } }, warnings: [] }), stderr: "" };
			if (cmd === "bash" && script.endsWith("inbox-tick.sh")) return { code: 0, stdout: JSON.stringify(inboxTickPayload(args)), stderr: "" };
			if (cmd === "bash" && script.endsWith("inbox-worker-start.sh")) return { code: 0, stdout: JSON.stringify({ inbox_api_version: 1, kind: "inbox_worker_update", updated: true, item: { id: "inq_submit", status: "running", safe_title: "Build Kalshi tool" }, warnings: [] }), stderr: "" };
			if (cmd === "bash" && script.endsWith("inbox-worker-complete.sh")) return { code: 0, stdout: JSON.stringify({ inbox_api_version: 1, kind: "inbox_worker_update", updated: true, item: { id: "inq_submit", status: "completed", safe_title: "Build Kalshi tool" }, warnings: [] }), stderr: "" };
			if (cmd === "bash" && script.endsWith("memory-promote.sh")) return { code: 0, stdout: JSON.stringify({ memory_api_version: 1, promoted: true, record: { id: args[1], state: "approved", title: "Promoted memory", scope: { type: "task" } } }), stderr: "" };
			if (cmd === "bash" && script.endsWith("memory-forget.sh")) return { code: 0, stdout: JSON.stringify({ memory_api_version: 1, forgotten: true, record: { id: args[1], state: "deprecated", title: "Forgotten memory", scope: { type: "task" } } }), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-lifecycle.sh")) return { code: 0, stdout: JSON.stringify(taskLifecyclePayload({ task_id: args[1], ...(lifecyclePayload ?? {}) })), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-close.sh")) return { code: 0, stdout: JSON.stringify({ task_api_version: 1, status: args[2] || "completed", closed_at: "2026-05-08T00:00:00Z", has_next_action: true, has_closure_reason: args.includes("--reason-file") }), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-retention.sh")) return { code: 0, stdout: JSON.stringify(taskRetentionPayload(retentionPayload ?? {})), stderr: "" };
			if (cmd === "bash" && script.endsWith("pi-package-doctor.sh")) return { code: 0, stdout: JSON.stringify(piPackagePolicyPayload(packagePolicyPayload ?? {})), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-heartbeat.sh")) return { code: 0, stdout: "", stderr: "" };
			if (cmd === "bash" && script.endsWith("task-event.sh")) return { code: 0, stdout: JSON.stringify({ type: args[1] || "checkpoint" }), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-artifact-list.sh")) return { code: 0, stdout: JSON.stringify({ artifact_api_version: 1, task_id: args[1], count: 0, artifacts: [] }), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-artifact-add.sh")) return { code: 0, stdout: JSON.stringify(artifactAddPayload ?? { artifact_api_version: 1, task_id: args[1], recorded: true, artifact: { id: "artifact-1" } }), stderr: "" };
			if (cmd === "bash" && script.endsWith("task-status.sh")) return { code: 0, stdout: "{}", stderr: "" };
			if (cmd === "bash" && script.endsWith("task-gc.sh")) return { code: 0, stdout: "released: pi-task", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
		sendUserMessage: () => {},
		sendMessage: (message) => sentMessages.push(message),
	});
	const ctx = {
		cwd,
		model: { provider: "test", id: "model" },
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "session-1",
			getSessionFile: () => join(root, ".test-session.jsonl"),
			getLeafId: () => undefined,
		},
		ui: {
			notify: (message, level = "info") => notifications.push({ message, level }),
		},
	};
	return { handlers, commands, tools, sentMessages, execCalls, ctx, events, notifications, sessionNames, getSessionName: () => sessionName };
}
