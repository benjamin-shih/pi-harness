import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DelegationWorkflow, HtmlArtifactDecision } from "./orchestration-guidance";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";
import { withPrivateTempTextFile } from "./private-temp";

export type ControlCenterHealth = "ok" | "warning" | "degraded";
export type ControlCenterStatus = "ready" | "script_error" | "invalid_json" | "unsupported_api" | "invalid_payload" | "exception";

export type ControlCenterRouteSummary = {
	task?: { shape?: string; complexity?: string; risk?: string };
	run?: { shape?: string; summary?: string };
};

export type ControlCenterDecisionSummary = {
	task?: { shape?: string; complexity?: string; risk?: string };
	route?: { run?: { shape?: string; summary?: string } };
	topology?: { recommended?: string; reason?: string; description?: string; advisory_only?: boolean; subagents?: Array<{ role?: string; mode?: string; when?: string }> };
	gates?: { ids?: string[]; preflight?: Array<{ id?: string }>; execution?: Array<{ id?: string }>; verification?: Array<{ id?: string }>; final?: Array<{ id?: string }> };
	memory?: { ambient_reads?: string; durable_writes?: string };
	delegation_workflow?: DelegationWorkflow;
	artifacts?: { html?: HtmlArtifactDecision };
	checks?: string[];
	evidence_required?: string[];
	stop_conditions?: string[];
	reasons?: string[];
};

export type ControlCenterOrchestrationTracking = {
	available?: boolean;
	status?: string;
	mismatch?: boolean;
	explanation?: string;
	recommended_action?: string;
	events?: number;
	recommended?: { topology?: string; timestamp?: string; gate_ids?: string[] } | null;
	chosen?: { topology?: string; timestamp?: string; reason?: string } | null;
};

export type ControlCenterTaskEvent = { timestamp?: string; type?: string; summary?: string };

export type ControlCenterOptions = { prompt?: string; taskId?: string; project?: string; projectRoot?: string };

export type ControlCenterPayload = {
	control_plane_api_version?: number;
	kind?: string;
	generated_at?: string;
	cwd?: string;
	read_only?: boolean;
	project?: {
		name?: string;
		root?: string;
		type?: string;
		registry_id?: string;
		match_type?: string;
		description?: string;
		tags?: string[];
		steward?: string;
		default_checks?: string[];
		write_policy?: string;
		coursework_policy?: string;
	};
	route?: ControlCenterRouteSummary | null;
	orchestration_decision?: ControlCenterDecisionSummary | null;
	tasks?: {
		available?: boolean;
		scope?: string;
		summary?: Record<string, number>;
		active_task?: { status?: string; active?: boolean; terminal?: boolean; scope_match?: boolean; lease_state?: string; events_count?: number; blockers_count?: number; recent_events?: ControlCenterTaskEvent[]; orchestration?: ControlCenterOrchestrationTracking } | null;
		orchestration?: ControlCenterOrchestrationTracking;
		warnings?: string[];
	};
	memory?: {
		available?: boolean;
		count?: number;
		counts_by_state?: Record<string, number>;
		skipped?: number;
		warnings?: string[];
	};
	package_policy?: {
		available?: boolean;
		health?: string;
		summary?: Record<string, number>;
		policy?: { default_action?: string; requires_exact_pins?: boolean; runtime_network_checks?: boolean };
		warnings?: string[];
	};
	project_instructions?: {
		available?: boolean;
		health?: string;
		summary?: Record<string, number | boolean>;
		warnings?: string[];
	};
	attention?: string[];
	warnings?: string[];
	notices?: string[];
};

export type ControlCenterState = {
	health: ControlCenterHealth;
	status: ControlCenterStatus;
	apiVersion?: number;
	summary: string;
	payload?: ControlCenterPayload;
};

const SUPPORTED_CONTROL_PLANE_API_VERSION = 1;

let webServer: { server: Server; url: string } | undefined;

function state(health: ControlCenterHealth, status: ControlCenterStatus, summary: string, apiVersion?: number, payload?: ControlCenterPayload): ControlCenterState {
	return { health, status, summary, ...(apiVersion === undefined ? {} : { apiVersion }), ...(payload ? { payload } : {}) };
}

function payloadHealth(payload: ControlCenterPayload): ControlCenterHealth {
	if (payload.warnings?.length || payload.attention?.length) return "warning";
	if (payload.package_policy?.health === "warning" || payload.project_instructions?.health === "warning") return "warning";
	if (payload.tasks?.available === false || payload.package_policy?.available === false) return "warning";
	return "ok";
}

function summaryFromPayload(payload: ControlCenterPayload): string {
	const project = payload.project?.name || "unknown project";
	const attention = payload.attention?.length ?? 0;
	const route = payload.route?.task?.shape ? `${payload.route.task.shape}/${payload.route.task.complexity ?? "?"}/${payload.route.task.risk ?? "?"}` : "no route";
	const topology = payload.orchestration_decision?.topology?.recommended;
	return `${project}; ${route}${topology ? `; topology ${topology}` : ""}; ${attention} attention item(s)`;
}

function stateFromPayload(payload: ControlCenterPayload | undefined): ControlCenterState {
	if (!payload) return state("degraded", "invalid_json", "degraded · invalid_json");
	const apiVersion = payload.control_plane_api_version;
	if (apiVersion !== SUPPORTED_CONTROL_PLANE_API_VERSION) return state("degraded", "unsupported_api", "degraded · unsupported_api", apiVersion);
	if (payload.kind !== "dashboard" || payload.read_only !== true || !payload.project || !payload.tasks || !payload.memory || !payload.package_policy) return state("degraded", "invalid_payload", "degraded · invalid_payload", apiVersion);
	return state(payloadHealth(payload), "ready", summaryFromPayload(payload), apiVersion, payload);
}

function appendDashboardArgs(args: string[], options: ControlCenterOptions, promptFile?: string): string[] {
	if (promptFile) args.push("--prompt-file", promptFile);
	if (options.taskId) args.push("--task-id", options.taskId);
	if (options.project) args.push("--project", options.project);
	if (options.projectRoot) args.push("--project-root", options.projectRoot);
	return args;
}

export async function buildControlCenterState(pi: ExtensionAPI, cwd: string, options: ControlCenterOptions = {}): Promise<ControlCenterState> {
	try {
		const run = async (promptFile?: string) => {
			const args = appendDashboardArgs([agentsScriptPath("control-plane.sh"), "dashboard", "--cwd", cwd, "--json"], options, promptFile);
			const result = await pi.exec("bash", args, { cwd, timeout: 8_000 });
			if (result.code !== 0) return state("degraded", "script_error", "degraded · script_error");
			return stateFromPayload(parseJson<ControlCenterPayload>(result.stdout));
		};
		const prompt = options.prompt?.trim();
		return prompt ? await withPrivateTempTextFile("pi-control-center-prompt-", prompt, run) : await run();
	} catch {
		return state("degraded", "exception", "degraded · exception");
	}
}

export async function openControlCenterHtml(pi: ExtensionAPI, cwd: string, options: ControlCenterOptions = {}): Promise<{ path?: string; opened: boolean; error?: string }> {
	const prompt = options.prompt?.trim();
	const run = async (promptFile?: string) => {
		const args = appendDashboardArgs([agentsScriptPath("control-plane.sh"), "dashboard", "--cwd", cwd, "--html"], options, promptFile);
		const result = await pi.exec("bash", args, { cwd, timeout: 8_000 });
		if (result.code !== 0 || !result.stdout.trim()) return { opened: false, error: "dashboard html unavailable" };
		const dir = await mkdtemp(join(tmpdir(), "pi-control-center-"));
		const path = join(dir, "index.html");
		await writeFile(path, result.stdout, { encoding: "utf8", mode: 0o600 });
		const opened = await pi.exec("open", [path], { cwd, timeout: 5_000 });
		return { path, opened: opened.code === 0, ...(opened.code === 0 ? {} : { error: "open command failed" }) };
	};
	try {
		return prompt ? await withPrivateTempTextFile("pi-control-center-prompt-", prompt, run) : await run();
	} catch (error) {
		return { opened: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function stopControlCenterWeb(): Promise<boolean> {
	if (!webServer) return false;
	const { server } = webServer;
	webServer = undefined;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return true;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, string>> {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > 12_000) return {};
	}
	try {
		const parsed = JSON.parse(body || "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>;
	} catch {
		return {};
	}
}

function webValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function webShell(token: string): string {
	const base = `/${token}/`;
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Agent Control Center</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:2rem;line-height:1.45;background:#fbfbfb;color:#1f2328}header{display:flex;justify-content:space-between;gap:1rem;align-items:center}button{padding:.45rem .8rem;border:1px solid #ccc;border-radius:8px;background:white}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}section{background:white;border:1px solid #ddd;border-radius:12px;padding:1rem}h1,h2{margin-top:0}.muted{color:#666}.warn{color:#9a6700}.bad{color:#b42318}li{margin:.2rem 0}code{background:#f0f0f0;padding:.1rem .25rem;border-radius:4px}</style>
</head><body><header><div><h1>Agent Control Center</h1><p class="muted">Read-only local dashboard · refreshes every 15s while this Pi session is alive.</p></div><button id="refresh">Refresh</button></header><p id="status" class="muted">Loading...</p><section><h2>Project / prompt</h2><p><input id="project" placeholder="project alias" style="width:14rem"> <input id="prompt" placeholder="prompt text for routing" style="width:32rem"> <button id="apply">Apply</button></p><p class="muted">Optional; values only request a read-only dashboard decision.</p></section><main id="cards"></main>
<script>
const cards = document.getElementById('cards');
const status = document.getElementById('status');
function esc(v){return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function list(items){return (items && items.length) ? '<ul>' + items.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul>' : '<p class="muted">None</p>';}
function count(obj,key){return Number((obj || {})[key] || 0);}
function section(title, body){return '<section><h2>' + esc(title) + '</h2>' + body + '</section>';}
function dashboardRequest(){
  return JSON.stringify({
    project: document.getElementById('project').value.trim(),
    prompt: document.getElementById('prompt').value.trim()
  });
}
async function load(){
  const res = await fetch('${base}api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: dashboardRequest(), cache: 'no-store' });
  const state = await res.json();
  const p = state.payload || {};
  const project = p.project || {}, tasks = p.tasks || {}, taskSummary = tasks.summary || {}, activeTask = tasks.active_task || {}, tracking = (activeTask.orchestration || tasks.orchestration || {}), memory = p.memory || {}, mem = memory.counts_by_state || {}, pkg = p.package_policy || {}, pkgSummary = pkg.summary || {}, instr = p.project_instructions || {}, instrSummary = instr.summary || {}, route = p.route || {}, decision = p.orchestration_decision || {}, topology = decision.topology || {}, gates = decision.gates || {}, delegation = decision.delegation_workflow || {}, html = ((decision.artifacts || {}).html || {});
  status.textContent = 'Health: ' + state.health + ' · ' + (p.generated_at || 'unknown') + ' · ' + state.summary;
  status.className = state.health === 'ok' ? 'muted' : 'warn';
  cards.innerHTML = [
    section('Project', '<p><b>' + esc(project.name) + '</b> (' + esc(project.type) + ')</p><p><code>' + esc(project.root) + '</code></p><p>Registry: ' + esc(project.registry_id || 'unregistered') + ' via ' + esc(project.match_type || 'unknown') + '</p><p>Policy: write ' + esc(project.write_policy) + '; coursework ' + esc(project.coursework_policy || 'none') + '</p><p>Default checks: ' + esc((project.default_checks || []).join(', ') || 'none') + '</p>'),
    section('Route', route.task ? '<p>Task: ' + esc(route.task.shape) + ' · ' + esc(route.task.complexity) + ' · risk ' + esc(route.task.risk) + '</p><p>Run: ' + esc((route.run || {}).shape || 'none') + '</p>' : '<p class="muted">No prompt route requested.</p>'),
    section('Orchestration', topology.recommended ? '<p>Topology: <b>' + esc(topology.recommended) + '</b></p><p>Rationale: ' + esc(topology.reason || '') + '</p><p>Description: ' + esc(topology.description || 'none') + '</p><p>Decision basis: ' + esc((decision.reasons || []).join(', ') || 'none') + '</p><p>Project defaults: checks ' + esc((project.default_checks || []).join(', ') || 'none') + '; write ' + esc(project.write_policy || 'unknown') + '</p><p>Preflight: ' + esc((gates.preflight || []).map(g => g.id).join(', ') || 'none') + '</p><p>Execution: ' + esc((gates.execution || []).map(g => g.id).join(', ') || 'none') + '</p><p>Verification: ' + esc((gates.verification || []).map(g => g.id).join(', ') || 'none') + '</p><p>Final: ' + esc((gates.final || []).map(g => g.id).join(', ') || 'none') + '</p><p>Memory: ' + esc(((decision.memory || {}).ambient_reads) || 'unknown') + ' reads; writes ' + esc(((decision.memory || {}).durable_writes) || 'explicit_only') + '</p>' : '<p class="muted">No orchestration decision requested.</p>'),
    section('Delegation workflow', delegation.launch_policy ? '<p>Launch: ' + esc(delegation.launch_policy) + ' · auto-launch ' + esc(Boolean(delegation.auto_launch)) + '</p><p>Pattern: ' + esc(delegation.recommended_pattern || 'none') + '</p><p>Next: ' + esc(delegation.next_action || 'none') + '</p><p>Subagents: ' + esc((delegation.subagent_contracts || []).map(s => s.role + ' (' + s.mode + ')').join(', ') || 'none') + '</p><p>Progress: ' + esc(((delegation.coordination || {}).progress_updates) || 'unknown') + '</p>' : '<p class="muted">No delegation workflow decision.</p>'),
    section('HTML artifacts', (html.modes || []).length ? '<p>Modes: ' + esc((html.modes || []).map(m => m.id).join(', ')) + '</p><p>Publish: ' + esc(html.publish_policy || 'explicit_only') + ' · source: ' + esc(html.source_of_truth || 'json_or_markdown') + '</p><p>Auto-open: ' + esc(((html.auto_open || {}).enabled) ? 'enabled' : 'disabled') + '</p><p>Safety: ' + esc((html.safety || []).slice(0,6).join(', ')) + '</p>' : '<p class="muted">No HTML artifact recommendation.</p>'),
    section('Chosen vs recommended', tracking.available ? '<p>Recommended: ' + esc(((tracking.recommended || {}).topology) || 'none') + '</p><p>Chosen: ' + esc(((tracking.chosen || {}).topology) || 'none') + '</p><p>Status: ' + esc(tracking.status || 'unknown') + ' · mismatch ' + esc(Boolean(tracking.mismatch)) + '</p><p>Explanation: ' + esc(tracking.explanation || '') + '</p><p>Action: ' + esc(tracking.recommended_action || '') + '</p>' : '<p class="muted">No orchestration tracking events.</p>'),
    section('Tasks', '<p>Scoped packages: ' + count(taskSummary,'task_packages_scoped') + '</p><p>Active: ' + count(taskSummary,'active_tasks') + ' · Terminal: ' + count(taskSummary,'terminal_tasks') + ' · Live leases: ' + count(taskSummary,'live_leases') + '</p><p>Stale candidates: ' + count(taskSummary,'stale_candidates') + '</p><h3>Recent events</h3>' + list((activeTask.recent_events || []).map(e => (e.timestamp ? e.timestamp + ' ' : '') + (e.type || 'event') + (e.summary ? ' (' + e.summary + ')' : '')))),
    section('Memory', '<p>Available: ' + esc(memory.available !== false) + '</p><p>Approved: ' + count(mem,'approved') + ' · Candidates: ' + count(mem,'candidate') + ' · Deprecated: ' + count(mem,'deprecated') + '</p>'),
    section('Pi package policy', '<p>Health: ' + esc(pkg.health || 'unknown') + '</p><p>Configured: ' + count(pkgSummary,'configured_packages') + ' · Approved: ' + count(pkgSummary,'approved_packages') + ' · Unapproved: ' + count(pkgSummary,'unapproved_packages') + ' · Unpinned: ' + count(pkgSummary,'unpinned_packages') + '</p>'),
    section('Project instructions', '<p>Health: ' + esc(instr.health || 'unknown') + '</p><p>Files: ' + count(instrSummary,'instruction_files_found') + ' · Thin style: ' + count(instrSummary,'thin_style_files') + '</p>'),
    section('Attention', list(p.attention || [])),
    section('Warnings', list(p.warnings || [])),
    section('Notices', list(p.notices || []))
  ].join('');
}
document.getElementById('refresh').onclick = () => load().catch(e => { status.textContent = 'Refresh failed: ' + e; status.className = 'bad'; });
document.getElementById('apply').onclick = () => load().catch(e => { status.textContent = 'Refresh failed: ' + e; status.className = 'bad'; });
load().catch(e => { status.textContent = 'Load failed: ' + e; status.className = 'bad'; });
setInterval(() => load().catch(() => {}), 15000);
</script></body></html>`;
}

export async function startControlCenterWeb(pi: ExtensionAPI, cwd: string, options: ControlCenterOptions = {}): Promise<{ url: string; opened: boolean; reused: boolean; error?: string }> {
	await stopControlCenterWeb();
	const token = randomBytes(12).toString("hex");
	const server = createServer(async (req, res) => {
		try {
			const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
			const path = parsedUrl.pathname;
			if (path === `/${token}/` || path === `/${token}`) {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				res.end(webShell(token));
				return;
			}
			if (path === `/${token}/api/dashboard`) {
				const body = req.method === "POST" ? await readJsonBody(req) : {};
				const requestOptions = {
					...options,
					prompt: webValue(body.prompt) ?? options.prompt,
					project: webValue(body.project) ?? options.project,
					projectRoot: webValue(body.projectRoot) ?? options.projectRoot,
				};
				const dashboard = await buildControlCenterState(pi, cwd, requestOptions);
				res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(JSON.stringify(dashboard));
				return;
			}
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("not found");
		} catch (error) {
			res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify({ health: "degraded", status: "exception", summary: error instanceof Error ? error.message : String(error) }));
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	server.unref();
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const url = `http://127.0.0.1:${port}/${token}/`;
	webServer = { server, url };
	const opened = await pi.exec("open", [url], { cwd, timeout: 5_000 });
	return { url, opened: opened.code === 0, reused: false, ...(opened.code === 0 ? {} : { error: "open command failed" }) };
}

function listLine(label: string, items: string[] | undefined): string {
	return `- ${label}: ${items?.length ? items.slice(0, 5).join("; ") : "none"}`;
}

function countLine(label: string, value: unknown): string {
	return `- ${label}: ${typeof value === "number" ? value : 0}`;
}

function taskEventLine(event: ControlCenterTaskEvent): string {
	const prefix = event.timestamp ? `${event.timestamp} ` : "";
	return `${prefix}${event.type || "event"}${event.summary ? ` (${event.summary})` : ""}`;
}

export function formatControlCenter(state: ControlCenterState): string {
	if (!state.payload) return ["## Agent Control Center v0", `- health: ${state.health} (${state.status})`, `- summary: ${state.summary}`].join("\n");
	const payload = state.payload;
	const project = payload.project ?? {};
	const route = payload.route;
	const decision = payload.orchestration_decision;
	const tasks = payload.tasks ?? {};
	const taskSummary = tasks.summary ?? {};
	const activeTask = tasks.active_task;
	const tracking = activeTask?.orchestration ?? tasks.orchestration;
	const memory = payload.memory ?? {};
	const memoryCounts = memory.counts_by_state ?? {};
	const packagePolicy = payload.package_policy ?? {};
	const packageSummary = packagePolicy.summary ?? {};
	const instructions = payload.project_instructions ?? {};
	const instructionSummary = instructions.summary ?? {};
	const warnings = [...(payload.warnings ?? []), ...(tasks.warnings ?? []), ...(memory.warnings ?? []), ...(packagePolicy.warnings ?? []), ...(instructions.warnings ?? [])];
	const lines = [
		"## Agent Control Center v0",
		`- health: ${state.health} (${state.status}; v${state.apiVersion ?? "?"})`,
		`- generated: ${payload.generated_at ?? "unknown"}`,
		"- mode: read-only diagnostics; no task execution, package changes, memory writes, or cleanup actions",
		"",
		"## Project",
		`- name: ${project.name ?? "unknown"} (${project.type ?? "unknown"})`,
		`- root: ${project.root ?? "unknown"}`,
		`- registry: ${project.registry_id || "unregistered"}${project.match_type ? ` via ${project.match_type}` : ""}`,
		`- steward: ${project.steward || "none"}`,
		`- description: ${project.description || "none"}`,
		listLine("tags", project.tags),
		`- policy: write ${project.write_policy || "unknown"}; coursework ${project.coursework_policy || "none"}`,
		listLine("default checks", project.default_checks),
		"",
		"## Route",
		route?.task?.shape ? `- task: ${route.task.shape}; complexity ${route.task.complexity ?? "unknown"}; risk ${route.task.risk ?? "unknown"}` : "- task: no prompt route requested",
		route?.run?.shape ? `- run shape: ${route.run.shape}` : "- run shape: none",
		"",
		"## Orchestration",
		decision?.topology?.recommended ? `- topology: ${decision.topology.recommended}` : "- topology: no orchestration decision requested",
		decision?.topology?.recommended ? `- topology rationale: ${decision.topology.reason || "none"}` : "- topology rationale: none",
		decision?.topology?.recommended ? `- topology description: ${decision.topology.description || "none"}` : "- topology description: none",
		listLine("decision basis", decision?.reasons),
		`- project defaults: checks ${project.default_checks?.length ? project.default_checks.join("; ") : "none"}; write ${project.write_policy || "unknown"}; coursework ${project.coursework_policy || "none"}`,
		decision?.route?.run?.shape ? `- run shape: ${decision.route.run.shape}` : "- run shape: none",
		listLine("gate ids", decision?.gates?.ids),
		listLine("preflight gates", decision?.gates?.preflight?.map((gate) => gate.id || "")),
		listLine("execution gates", decision?.gates?.execution?.map((gate) => gate.id || "")),
		listLine("verification gates", decision?.gates?.verification?.map((gate) => gate.id || "")),
		listLine("final gates", decision?.gates?.final?.map((gate) => gate.id || "")),
		listLine("checks", decision?.checks),
		decision?.memory ? `- memory: ambient reads ${decision.memory.ambient_reads ?? "unknown"}; durable writes ${decision.memory.durable_writes ?? "explicit_only"}` : "- memory: no decision",
		decision?.delegation_workflow ? `- delegation launch: ${decision.delegation_workflow.launch_policy || "manual_main_agent_only"}; auto-launch ${decision.delegation_workflow.auto_launch ? "yes" : "no"}` : "- delegation launch: no decision",
		decision?.delegation_workflow ? `- delegation pattern: ${decision.delegation_workflow.recommended_pattern || "none"}` : "- delegation pattern: no decision",
		decision?.delegation_workflow ? `- delegation next action: ${decision.delegation_workflow.next_action || "none"}` : "- delegation next action: no decision",
		listLine("delegation subagents", decision?.delegation_workflow?.subagent_contracts?.map((item) => `${item.role || "unknown"} (${item.mode || "unknown"})`)),
		decision?.delegation_workflow ? `- delegation progress: ${decision.delegation_workflow.coordination?.progress_updates || "unknown"}` : "- delegation progress: no decision",
		listLine("html artifact modes", decision?.artifacts?.html?.modes?.map((mode) => mode.id || "")),
		decision?.artifacts?.html ? `- html publish: ${decision.artifacts.html.publish_policy || "explicit_only"}; source ${decision.artifacts.html.source_of_truth || "json_or_markdown"}` : "- html publish: no decision",
		decision?.artifacts?.html ? `- html auto-open: ${decision.artifacts.html.auto_open?.enabled ? "enabled" : "disabled"}` : "- html auto-open: no decision",
		listLine("evidence", decision?.evidence_required),
		listLine("stop conditions", decision?.stop_conditions),
		"",
		"## Tasks",
		`- task diagnostics: ${tasks.available === false ? "unavailable" : "available"} (${tasks.scope ?? "project"})`,
		countLine("scoped task packages", taskSummary.task_packages_scoped),
		countLine("active tasks", taskSummary.active_tasks),
		countLine("terminal tasks", taskSummary.terminal_tasks),
		countLine("live leases", taskSummary.live_leases),
		countLine("stale candidates", taskSummary.stale_candidates),
		activeTask ? `- active task: status ${activeTask.status ?? "unknown"}; lease ${activeTask.lease_state ?? "unknown"}; scope match ${Boolean(activeTask.scope_match)}; events ${activeTask.events_count ?? 0}` : "- active task: none supplied",
		listLine("recent events", activeTask?.recent_events?.map(taskEventLine)),
		tracking?.available ? `- orchestration tracking: recommended ${tracking.recommended?.topology || "none"}; chosen ${tracking.chosen?.topology || "none"}; status ${tracking.status || "unknown"}; mismatch ${Boolean(tracking.mismatch)}` : "- orchestration tracking: none",
		tracking?.available ? `- orchestration tracking explanation: ${tracking.explanation || "none"}` : "- orchestration tracking explanation: none",
		tracking?.available ? `- orchestration tracking action: ${tracking.recommended_action || "none"}` : "- orchestration tracking action: none",
		"",
		"## Memory",
		`- scoped memory: ${memory.available === false ? "unavailable" : "available"}`,
		countLine("approved", memoryCounts.approved),
		countLine("candidates", memoryCounts.candidate),
		countLine("deprecated", memoryCounts.deprecated),
		countLine("skipped", memory.skipped),
		"",
		"## Pi package policy",
		`- health: ${packagePolicy.health ?? "unknown"}`,
		countLine("configured", packageSummary.configured_packages),
		countLine("approved", packageSummary.approved_packages),
		countLine("unapproved", packageSummary.unapproved_packages),
		countLine("unpinned", packageSummary.unpinned_packages),
		`- upstream checks: ${packagePolicy.policy?.runtime_network_checks ? "enabled by policy" : "disabled in harness/control center"}`,
		"",
		"## Project instructions",
		`- health: ${instructions.health ?? "unknown"}`,
		countLine("instruction files found", instructionSummary.instruction_files_found),
		countLine("thin-style files", instructionSummary.thin_style_files),
		countLine("dispatch mentions", instructionSummary.dispatch_mentions),
		"",
		"## Attention",
		listLine("items", payload.attention),
		listLine("warnings", warnings),
		listLine("notices", payload.notices),
	];
	return lines.join("\n");
}
