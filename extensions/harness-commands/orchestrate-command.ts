import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseJson } from "../shared/json";
import { withPrivateTempTextFile } from "../shared/private-temp";
import { runScript } from "./task-layer-api";

const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
const RESPONSE_TIMEOUT_MS = 5_000;

type EventBus = { on?: (event: string, handler: (data: unknown) => void) => (() => void) | void; emit?: (event: string, data: unknown) => void };
type LaunchResult = { state: "started" | "deferred" | "failed"; asyncId?: string; message: string };
type Mode = "plan" | "run";

type OrchestrationRole = {
	id?: string;
	role?: string;
	agent?: string;
	phase?: string;
	mode?: string;
	may_write?: boolean;
	requires_confirmation?: boolean;
	task_template?: string;
	expected_output?: string;
	constraints?: string[];
	profile?: string;
	overlays?: string[];
};

type OrchestrationPlan = {
	kind?: string;
	read_only?: boolean;
	mutating_actions?: boolean;
	auto_launch?: boolean;
	plan_id?: string;
	project?: { id?: string; name?: string; type?: string; registered?: boolean; write_policy?: string };
	task?: { shape?: string; complexity?: string; risk?: string };
	execution?: { profile?: string; overlays?: string[]; summary?: string };
	topology?: { recommended?: string; pattern?: string; reason?: string };
	autonomy?: { confirmation_required?: boolean; read_only_auto_run_eligible?: boolean };
	role_launch_plan?: OrchestrationRole[];
	checks?: string[];
	evidence_required?: string[];
	stop_conditions?: string[];
	warnings?: string[];
	notices?: string[];
};

type RoutePayload = { project?: { root?: string } };

function eventBus(pi: ExtensionAPI): EventBus | undefined {
	return (pi as unknown as { events?: EventBus }).events;
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asyncIdFromResponse(data: unknown): { requestId?: string; asyncId?: string; isError?: boolean } {
	if (!data || typeof data !== "object") return {};
	const raw = data as { requestId?: unknown; isError?: unknown; result?: { details?: { asyncId?: unknown; runId?: unknown } } };
	return { requestId: textOf(raw.requestId), asyncId: textOf(raw.result?.details?.asyncId || raw.result?.details?.runId), isError: raw.isError === true };
}

function splitArgs(args: string): { mode: Mode; includeWorkers: boolean; request: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let mode: Mode = "plan";
	let includeWorkers = false;
	if (parts[0] === "run" || parts[0] === "execute") {
		mode = "run";
		parts.shift();
	} else if (parts[0] === "plan" || parts[0] === "preview") {
		parts.shift();
	}
	const requestParts: string[] = [];
	for (const part of parts) {
		if (part === "--workers" || part === "--include-workers") includeWorkers = true;
		else requestParts.push(part);
	}
	return { mode, includeWorkers, request: requestParts.join(" ").trim() };
}

function roleLabel(role: OrchestrationRole): string {
	const agent = role.agent || "agent";
	const name = role.role || agent;
	const mode = role.may_write ? "bounded_write" : role.mode || "read_only";
	return `${name}→${agent} (${mode})`;
}

function planSafetyError(plan: OrchestrationPlan): string {
	if (plan.kind !== "orchestration_plan") return "unsupported plan kind";
	if (plan.read_only !== true || plan.mutating_actions !== false || plan.auto_launch !== false) return "plan failed read-only safety preflight";
	return "";
}

function workerSafetyError(role: OrchestrationRole): string {
	if (!role.may_write) return "";
	if (role.mode !== "bounded_write") return "write role is not marked bounded_write";
	if (role.requires_confirmation !== true) return "write role does not require confirmation";
	const constraints = (role.constraints ?? []).join(" ").toLowerCase();
	if (!constraints.includes("bounded") && !constraints.includes("scope")) return "write role lacks bounded scope constraints";
	return "";
}

function formatPlan(plan: OrchestrationPlan, launchSummary = ""): string {
	const roles = plan.role_launch_plan ?? [];
	const lines = [
		"## Orchestration plan",
		`- profile: ${plan.execution?.profile || "unknown"}; overlays: ${(plan.execution?.overlays ?? []).join(", ") || "none"}`,
		`- topology: ${plan.topology?.recommended || "unknown"}; pattern: ${plan.topology?.pattern || "unknown"}`,
		`- task: ${plan.task?.shape || "unknown"}; risk ${plan.task?.risk || "unknown"}; complexity ${plan.task?.complexity || "unknown"}`,
		`- project: ${plan.project?.id || plan.project?.name || "unmatched"}`,
		`- roles: ${roles.length ? roles.map(roleLabel).join(", ") : "none"}`,
		`- confirmation required: ${plan.autonomy?.confirmation_required ? "yes" : "no"}`,
		`- read-only plan: ${plan.read_only === false ? "no" : "yes"}; auto-launch by .agents: ${plan.auto_launch ? "yes" : "no"}`,
	];
	if (launchSummary) lines.push(`- launch: ${launchSummary}`);
	if (plan.warnings?.length) lines.push(`- warnings: ${plan.warnings.length}`);
	return lines.join("\n");
}

function buildRoleTask(plan: OrchestrationPlan, role: OrchestrationRole, request: string, includeWorkers: boolean): string {
	const constraints = (role.constraints ?? []).map((item) => `- ${item}`).join("\n") || "- return concise findings to the parent";
	const checks = (plan.checks ?? []).slice(0, 5).join("; ") || "none registered";
	const evidence = (plan.evidence_required ?? []).slice(0, 5).join("; ") || "concise result and residual risks";
	const workerLine = role.may_write ? `\nThis is a bounded write-capable worker handoff. It was launched only because the operator used --workers: ${includeWorkers ? "yes" : "no"}. Keep scope narrow, use one writer, avoid unrelated files, and run focused verification.` : "\nThis is a read-only/advisory helper. Do not edit files unless the parent later gives an explicit bounded work order.";
	return [
		`You are role ${role.role || role.agent || "helper"} for a supervised orchestration plan.`,
		`Plan id: ${plan.plan_id || "unknown"}. Project: ${plan.project?.id || plan.project?.name || "unmatched"}. Profile: ${plan.execution?.profile || role.profile || "unknown"}.`,
		`Role task: ${role.task_template || "Contribute bounded findings for the parent orchestrator."}`,
		workerLine,
		"\nPrivate user request for this role:",
		request,
		"\nConstraints:",
		constraints,
		`\nChecks: ${checks}`,
		`Evidence expected: ${evidence}`,
		"\nParent owns orchestration and synthesis. Do not launch subagents. Do not expose secrets or raw command output. Summarize only what the parent needs to decide next.",
	].join("\n");
}

async function launchRole(pi: ExtensionAPI, plan: OrchestrationPlan, role: OrchestrationRole, request: string, cwd: string, includeWorkers: boolean): Promise<LaunchResult> {
	const bus = eventBus(pi);
	if (!bus?.emit || !bus?.on) return { state: "failed", message: "subagent bridge unavailable" };
	if (role.may_write && !includeWorkers) return { state: "deferred", message: "worker requires --workers" };
	const workerError = workerSafetyError(role);
	if (workerError) return { state: "failed", message: workerError };
	const requestId = `orchestrate-${randomUUID().slice(0, 8)}`;
	return await new Promise<LaunchResult>((resolve) => {
		const unsubscribe = bus.on?.(SLASH_SUBAGENT_RESPONSE_EVENT, (data: unknown) => {
			const response = asyncIdFromResponse(data);
			if (response.requestId !== requestId) return;
			unsubscribe?.();
			clearTimeout(timer);
			if (response.isError) return resolve({ state: "failed", message: "subagent bridge returned an error" });
			if (!response.asyncId) return resolve({ state: "failed", message: "subagent bridge did not return an async id" });
			return resolve({ state: "started", asyncId: response.asyncId, message: "accepted" });
		});
		const timer = setTimeout(() => {
			unsubscribe?.();
			resolve({ state: "failed", message: "subagent bridge timed out" });
		}, RESPONSE_TIMEOUT_MS);
		try {
			bus.emit?.(SLASH_SUBAGENT_REQUEST_EVENT, {
				requestId,
				params: { agent: role.agent || "delegate", task: buildRoleTask(plan, role, request, includeWorkers), cwd, async: true, context: "fresh" },
			});
		} catch {
			unsubscribe?.();
			clearTimeout(timer);
			resolve({ state: "failed", message: "subagent bridge launch failed" });
		}
	});
}

async function resolveLaunchCwd(pi: ExtensionAPI, ctx: ExtensionContext, requestFile: string): Promise<string> {
	try {
		const result = await runScript(pi, "control-plane.sh", ["route", "--prompt-file", requestFile, "--cwd", ctx.cwd, "--json"], ctx.cwd, 8_000);
		if (result.code !== 0) return ctx.cwd;
		const payload = parseJson<RoutePayload>(result.stdout);
		return payload?.project?.root || ctx.cwd;
	} catch {
		return ctx.cwd;
	}
}

export function registerOrchestrateCommand(pi: ExtensionAPI): void {
	pi.registerCommand("orchestrate", {
		description: "Plan or run a supervised natural-language subagent workflow",
		getArgumentCompletions: (prefix: string) => ["plan", "run", "run --workers"].filter((item) => item.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx: ExtensionContext) => {
			const parsed = splitArgs(args);
			if (!parsed.request) {
				return pi.sendMessage({ customType: "harness-orchestrate", content: ["## Orchestration plan", "- usage: /orchestrate <request>", "- usage: /orchestrate run <request>", "- usage: /orchestrate run --workers <request>", "- note: run launches read-only helpers; --workers is required for bounded write-capable workers"].join("\n"), display: true });
			}
			const planned = await withPrivateTempTextFile("pi-orchestration-plan-", parsed.request, async (requestFile) => {
				const result = await runScript(pi, "orchestration-plan.sh", ["--prompt-file", requestFile, "--cwd", ctx.cwd, "--json"], ctx.cwd, 8_000);
				if (result.code !== 0) return { plan: undefined, launchCwd: ctx.cwd };
				return { plan: parseJson<OrchestrationPlan>(result.stdout), launchCwd: await resolveLaunchCwd(pi, ctx, requestFile) };
			});
			const plan = planned.plan;
			const safetyError = plan ? planSafetyError(plan) : "missing plan";
			if (!plan || safetyError) return pi.sendMessage({ customType: "harness-orchestrate", content: ["## Orchestration plan", "- result: planning failed", `- reason: ${safetyError || "shared orchestration-plan API unavailable or returned an unsupported payload"}`].join("\n"), display: true });
			if (parsed.mode === "plan") return pi.sendMessage({ customType: "harness-orchestrate", content: formatPlan(plan), display: true });

			const roles = plan.role_launch_plan ?? [];
			let started = 0;
			let deferred = 0;
			let failed = 0;
			for (const role of roles) {
				if (!parsed.includeWorkers && role.may_write) {
					deferred++;
					continue;
				}
				const launched = await launchRole(pi, plan, role, parsed.request, planned.launchCwd, parsed.includeWorkers);
				if (launched.state === "started") started++;
				else if (launched.state === "deferred") deferred++;
				else failed++;
			}
			const workerNote = parsed.includeWorkers ? "workers included by explicit --workers" : "write-capable workers deferred; add --workers to launch them";
			return pi.sendMessage({ customType: "harness-orchestrate", content: formatPlan(plan, `started=${started}, deferred=${deferred}, failed=${failed}; ${workerNote}`), display: true });
		},
	});
}
