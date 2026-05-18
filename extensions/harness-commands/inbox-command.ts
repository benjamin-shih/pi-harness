import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseJson } from "../shared/json";
import { withPrivateTempTextFile } from "../shared/private-temp";
import { runScript } from "../harness-task-layer/task-layer-api";
import type { InboxEnqueuePayload, InboxItem, InboxLaunchSpec, InboxListPayload, InboxProject, InboxSchedulePayload, InboxTickPayload } from "./inbox-types";
import { createInboxWorkerBridge } from "./inbox-worker-bridge";

function projectLabel(project: InboxProject | undefined): string {
	if (!project) return "unmatched";
	return project.id || project.name || "matched";
}

function formatCounts(counts: Record<string, number> | undefined): string {
	if (!counts || Object.keys(counts).length === 0) return "none";
	return Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ");
}

function controlStateLabel(item: InboxItem | undefined): string {
	return item?.control?.state || item?.status || "unknown";
}

function itemNextAction(item: InboxItem | undefined): string {
	const action = item?.control?.next_action;
	return action && action !== "none" ? ` · next ${action}` : "";
}

function formatInboxList(payload: InboxListPayload): string {
	const lines = ["## Async inbox", `- total: ${payload.count ?? 0}`, `- returned: ${payload.returned ?? 0}`, `- statuses: ${formatCounts(payload.summary?.by_status)}`, `- control states: ${formatCounts(payload.summary?.by_control_state)}`, `- cleanup states: ${formatCounts(payload.summary?.by_cleanup_state)}`, `- projects: ${formatCounts(payload.summary?.by_project)}`, `- active lanes: ${formatCounts(payload.summary?.active_by_project)}`, `- queued lanes: ${formatCounts(payload.summary?.queued_by_project)}`, `- review lanes: ${formatCounts(payload.summary?.review_by_project)}`, `- apply lanes: ${formatCounts(payload.summary?.apply_by_project)}`, `- cleanup diagnostics: ${formatCounts(payload.summary?.cleanup_by_project)}`];
	for (const item of payload.items ?? []) {
		lines.push(`- ${item.id || "unknown"}: ${controlStateLabel(item)} · ${projectLabel(item.project)}${itemNextAction(item)} · ${item.safe_title || "Untitled inbox request"}`);
	}
	return lines.join("\n");
}

function itemLine(item: InboxItem | undefined): string {
	return item ? `${item.id || "unknown"} · ${controlStateLabel(item)} · ${projectLabel(item.project)}${itemNextAction(item)} · ${item.safe_title || "Untitled inbox request"}` : "unknown";
}

function formatSchedule(schedule: InboxSchedulePayload, launchState: string): string[] {
	const first = schedule.items?.[0];
	const lines = [`- scheduler action: ${schedule.action || first?.action || "unknown"}`, `- scheduler reason: ${first?.reason || "none"}`];
	if (first?.item) lines.push(`- scheduled item: ${itemLine(first.item)}`);
	if (launchState) lines.push(`- worker launch: ${launchState}`);
	return lines;
}

function formatTick(tick: InboxTickPayload, launchState: string): string[] {
	const summary = tick.summary ?? {};
	return [
		`- tick mode: ${tick.dry_run ? "dry-run" : "execute"}`,
		`- mutating actions: ${tick.mutating_actions ? "yes" : "no"}`,
		`- worker launches by .agents: ${tick.worker_launches ? "yes" : "no"}`,
		`- launchable: ${summary.launchable_count ?? 0}; launch specs: ${summary.launch_spec_count ?? tick.launch_specs?.length ?? 0}; queued: ${summary.queued_count ?? 0}; needs user: ${summary.needs_user_count ?? 0}`,
		...formatSchedule(tick.schedule ?? {}, launchState),
	];
}

function formatEnqueue(payload: InboxEnqueuePayload, schedule?: InboxSchedulePayload, launchState = ""): string {
	const item = payload.item ?? {};
	const relation = item.relation?.kind || "new_task";
	const lines = [
		"## Inbox receipt",
		`- result: ${payload.enqueued ? "queued" : "unavailable"}`,
		`- item: ${item.id || "unknown"}`,
		`- project: ${projectLabel(item.project)}`,
		`- title: ${item.safe_title || "Untitled inbox request"}`,
		`- relation: ${relation}`,
	];
	if (item.relation?.target_item_id) lines.push(`- related item: ${item.relation.target_item_id}`);
	if (schedule) lines.push(...formatSchedule(schedule, launchState));
	else if (launchState) lines.push(`- worker launch: ${launchState}`);
	if (payload.warnings?.length) lines.push(`- warnings: ${payload.warnings.length}`);
	return lines.join("\n");
}

function errorMessage(action: string, code: number | undefined): string {
	return ["## Async inbox", `- result: ${action} failed`, `- reason: shared inbox API exited ${code ?? "unknown"}`].join("\n");
}

function firstLaunchSpec(schedule: InboxSchedulePayload): InboxLaunchSpec | undefined {
	return schedule.launch_specs?.[0] ?? schedule.items?.find((item) => item.launch_spec)?.launch_spec;
}

function firstLaunchSpecFromTick(tick: InboxTickPayload): InboxLaunchSpec | undefined {
	return tick.launch_specs?.[0] ?? firstLaunchSpec(tick.schedule ?? {});
}

function firstLaunchItemIdFromTick(tick: InboxTickPayload): string {
	return tick.schedule?.items?.find((item) => item.action === "launch" && item.item?.id)?.item?.id || tick.schedule?.items?.[0]?.item?.id || "";
}

export function registerInboxCommand(pi: ExtensionAPI): void {
	const workerBridge = createInboxWorkerBridge(pi);
	pi.registerCommand("inbox", {
		description: "Submit or view async front-door inbox items",
		getArgumentCompletions: (prefix: string) => ["submit", "status", "list", "tick", "schedule", "drain"].filter((item) => item.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx: ExtensionContext) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status" || trimmed === "list") {
				const result = await runScript(pi, "inbox-list.sh", ["--limit", "12", "--json"], ctx.cwd, 5_000);
				if (result.code !== 0) return pi.sendMessage({ customType: "harness-inbox", content: errorMessage("list", result.code), display: true });
				const payload = parseJson<InboxListPayload>(result.stdout);
				return pi.sendMessage({ customType: "harness-inbox", content: formatInboxList(payload ?? {}), display: true });
			}
			if (trimmed === "tick") {
				const ticked = await runScript(pi, "inbox-tick.sh", ["--runtime", "pi", "--session", ctx.sessionManager?.getSessionId?.() || "", "--cwd", ctx.cwd, "--dry-run", "--json"], ctx.cwd, 8_000);
				if (ticked.code !== 0) return pi.sendMessage({ customType: "harness-inbox", content: errorMessage("tick", ticked.code), display: true });
				const tick = parseJson<InboxTickPayload>(ticked.stdout) ?? {};
				return pi.sendMessage({ customType: "harness-inbox", content: ["## Async inbox", ...formatTick(tick, "none")].join("\n"), display: true });
			}
			if (trimmed === "schedule" || trimmed === "drain") {
				const ticked = await runScript(pi, "inbox-tick.sh", ["--runtime", "pi", "--session", ctx.sessionManager?.getSessionId?.() || "", "--cwd", ctx.cwd, "--execute", "--json"], ctx.cwd, 8_000);
				if (ticked.code !== 0) return pi.sendMessage({ customType: "harness-inbox", content: errorMessage("tick", ticked.code), display: true });
				const tick = parseJson<InboxTickPayload>(ticked.stdout) ?? {};
				const spec = firstLaunchSpecFromTick(tick);
				let launchState = "none";
				const itemId = firstLaunchItemIdFromTick(tick);
				if (spec && itemId) {
					const launch = await workerBridge.launch(ctx, itemId, spec);
					launchState = `${launch.state}; ${launch.message}`;
				}
				return pi.sendMessage({ customType: "harness-inbox", content: ["## Async inbox", ...formatTick(tick, launchState)].join("\n"), display: true });
			}
			const submitPrefix = "submit ";
			if (!trimmed.startsWith(submitPrefix)) return pi.sendMessage({ customType: "harness-inbox", content: ["## Async inbox", "- usage: /inbox submit <request>", "- usage: /inbox", "- usage: /inbox tick", "- usage: /inbox schedule"].join("\n"), display: true });
			const request = trimmed.slice(submitPrefix.length).trim();
			if (!request) return pi.sendMessage({ customType: "harness-inbox", content: ["## Async inbox", "- result: invalid request", "- reason: submit requires request text"].join("\n"), display: true });
			const result = await withPrivateTempTextFile("pi-inbox-request-", request, async (requestFile) => runScript(pi, "inbox-enqueue.sh", ["--request-file", requestFile, "--cwd", ctx.cwd, "--json"], ctx.cwd, 8_000));
			if (result.code !== 0) return pi.sendMessage({ customType: "harness-inbox", content: errorMessage("submit", result.code), display: true });
			const payload = parseJson<InboxEnqueuePayload>(result.stdout) ?? {};
			const itemId = payload.item?.id || "";
			let schedule: InboxSchedulePayload | undefined;
			let launchState = "";
			if (itemId) {
				const ticked = await runScript(pi, "inbox-tick.sh", ["--item-id", itemId, "--runtime", "pi", "--session", ctx.sessionManager?.getSessionId?.() || "", "--cwd", ctx.cwd, "--execute", "--json"], ctx.cwd, 8_000);
				if (ticked.code === 0) {
					const tick = parseJson<InboxTickPayload>(ticked.stdout) ?? {};
					schedule = tick.schedule;
					const spec = firstLaunchSpecFromTick(tick);
					const launchItemId = firstLaunchItemIdFromTick(tick) || itemId;
					if (spec) {
						const launch = await workerBridge.launch(ctx, launchItemId, spec);
						launchState = `${launch.state}; ${launch.message}`;
					}
				} else {
					launchState = `tick failed: exit ${ticked.code}`;
				}
			}
			return pi.sendMessage({ customType: "harness-inbox", content: formatEnqueue(payload, schedule, launchState), display: true });
		},
	});
}
