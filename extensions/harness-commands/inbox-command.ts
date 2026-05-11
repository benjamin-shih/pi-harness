import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseJson } from "../shared/json";
import { withPrivateTempTextFile } from "../shared/private-temp";
import { runScript } from "./task-layer-api";
import type { InboxEnqueuePayload, InboxItem, InboxLaunchSpec, InboxListPayload, InboxProject, InboxSchedulePayload } from "./inbox-types";
import { createInboxWorkerBridge } from "./inbox-worker-bridge";

function projectLabel(project: InboxProject | undefined): string {
	if (!project) return "unmatched";
	return project.id || project.name || "matched";
}

function formatCounts(counts: Record<string, number> | undefined): string {
	if (!counts || Object.keys(counts).length === 0) return "none";
	return Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatInboxList(payload: InboxListPayload): string {
	const lines = ["## Async inbox", `- total: ${payload.count ?? 0}`, `- returned: ${payload.returned ?? 0}`, `- statuses: ${formatCounts(payload.summary?.by_status)}`, `- projects: ${formatCounts(payload.summary?.by_project)}`, `- active lanes: ${formatCounts(payload.summary?.active_by_project)}`, `- queued lanes: ${formatCounts(payload.summary?.queued_by_project)}`];
	for (const item of payload.items ?? []) {
		lines.push(`- ${item.id || "unknown"}: ${item.status || "unknown"} · ${projectLabel(item.project)} · ${item.safe_title || "Untitled inbox request"}`);
	}
	return lines.join("\n");
}

function itemLine(item: InboxItem | undefined): string {
	return item ? `${item.id || "unknown"} · ${item.status || "unknown"} · ${projectLabel(item.project)} · ${item.safe_title || "Untitled inbox request"}` : "unknown";
}

function formatSchedule(schedule: InboxSchedulePayload, launchState: string): string[] {
	const first = schedule.items?.[0];
	const lines = [`- scheduler action: ${schedule.action || first?.action || "unknown"}`, `- scheduler reason: ${first?.reason || "none"}`];
	if (first?.item) lines.push(`- scheduled item: ${itemLine(first.item)}`);
	if (launchState) lines.push(`- worker launch: ${launchState}`);
	return lines;
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
	if (payload.warnings?.length) lines.push(`- warnings: ${payload.warnings.length}`);
	return lines.join("\n");
}

function errorMessage(action: string, code: number | undefined): string {
	return ["## Async inbox", `- result: ${action} failed`, `- reason: shared inbox API exited ${code ?? "unknown"}`].join("\n");
}

function firstLaunchSpec(schedule: InboxSchedulePayload): InboxLaunchSpec | undefined {
	return schedule.launch_specs?.[0] ?? schedule.items?.find((item) => item.launch_spec)?.launch_spec;
}

export function registerInboxCommand(pi: ExtensionAPI): void {
	const workerBridge = createInboxWorkerBridge(pi);
	pi.registerCommand("inbox", {
		description: "Submit or view async front-door inbox items",
		getArgumentCompletions: (prefix: string) => ["submit", "status", "list", "schedule"].filter((item) => item.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx: ExtensionContext) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status" || trimmed === "list") {
				const result = await runScript(pi, "inbox-list.sh", ["--limit", "12", "--json"], ctx.cwd, 5_000);
				if (result.code !== 0) return pi.sendMessage({ customType: "harness-inbox", content: errorMessage("list", result.code), display: true });
				const payload = parseJson<InboxListPayload>(result.stdout);
				return pi.sendMessage({ customType: "harness-inbox", content: formatInboxList(payload ?? {}), display: true });
			}
			if (trimmed === "schedule" || trimmed === "drain") {
				const scheduled = await runScript(pi, "inbox-schedule.sh", ["--runtime", "pi", "--session", ctx.sessionManager?.getSessionId?.() || "", "--cwd", ctx.cwd, "--json"], ctx.cwd, 8_000);
				if (scheduled.code !== 0) return pi.sendMessage({ customType: "harness-inbox", content: errorMessage("schedule", scheduled.code), display: true });
				const schedule = parseJson<InboxSchedulePayload>(scheduled.stdout) ?? {};
				const spec = firstLaunchSpec(schedule);
				let launchState = "none";
				if (spec && schedule.items?.[0]?.item?.id) {
					const launch = await workerBridge.launch(ctx, schedule.items[0].item.id, spec);
					launchState = `${launch.state}; ${launch.message}`;
				}
				return pi.sendMessage({ customType: "harness-inbox", content: ["## Async inbox", ...formatSchedule(schedule, launchState)].join("\n"), display: true });
			}
			const submitPrefix = "submit ";
			if (!trimmed.startsWith(submitPrefix)) return pi.sendMessage({ customType: "harness-inbox", content: ["## Async inbox", "- usage: /inbox submit <request>", "- usage: /inbox", "- usage: /inbox schedule"].join("\n"), display: true });
			const request = trimmed.slice(submitPrefix.length).trim();
			if (!request) return pi.sendMessage({ customType: "harness-inbox", content: ["## Async inbox", "- result: invalid request", "- reason: submit requires request text"].join("\n"), display: true });
			const result = await withPrivateTempTextFile("pi-inbox-request-", request, async (requestFile) => runScript(pi, "inbox-enqueue.sh", ["--request-file", requestFile, "--cwd", ctx.cwd, "--json"], ctx.cwd, 8_000));
			if (result.code !== 0) return pi.sendMessage({ customType: "harness-inbox", content: errorMessage("submit", result.code), display: true });
			const payload = parseJson<InboxEnqueuePayload>(result.stdout) ?? {};
			const itemId = payload.item?.id || "";
			let schedule: InboxSchedulePayload | undefined;
			let launchState = "";
			if (itemId) {
				const scheduled = await runScript(pi, "inbox-schedule.sh", ["--item-id", itemId, "--runtime", "pi", "--session", ctx.sessionManager?.getSessionId?.() || "", "--cwd", ctx.cwd, "--json"], ctx.cwd, 8_000);
				if (scheduled.code === 0) {
					schedule = parseJson<InboxSchedulePayload>(scheduled.stdout) ?? undefined;
					const spec = schedule ? firstLaunchSpec(schedule) : undefined;
					if (spec) {
						const launch = await workerBridge.launch(ctx, itemId, spec);
						launchState = `${launch.state}; ${launch.message}`;
					}
				} else {
					launchState = `schedule failed: exit ${scheduled.code}`;
				}
			}
			return pi.sendMessage({ customType: "harness-inbox", content: formatEnqueue(payload, schedule, launchState), display: true });
		},
	});
}
