import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseJson } from "../shared/json";
import { withPrivateTempTextFile } from "../shared/private-temp";
import { runScript } from "./task-layer-api";

type InboxProject = { id?: string; name?: string; match_type?: string } | null;
type InboxItem = {
	id?: string;
	status?: string;
	priority?: string;
	safe_title?: string;
	project?: InboxProject;
	relation?: { kind?: string; target_item_id?: string; reason?: string };
	route?: { confidence?: number; match_type?: string };
};
type InboxListPayload = { inbox_api_version?: number; count?: number; returned?: number; summary?: { by_status?: Record<string, number>; by_project?: Record<string, number> }; items?: InboxItem[] };
type InboxEnqueuePayload = { inbox_api_version?: number; enqueued?: boolean; item?: InboxItem; warnings?: string[] };

function projectLabel(project: InboxProject | undefined): string {
	if (!project) return "unmatched";
	return project.id || project.name || "matched";
}

function formatCounts(counts: Record<string, number> | undefined): string {
	if (!counts || Object.keys(counts).length === 0) return "none";
	return Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatInboxList(payload: InboxListPayload): string {
	const lines = ["## Async inbox", `- total: ${payload.count ?? 0}`, `- returned: ${payload.returned ?? 0}`, `- statuses: ${formatCounts(payload.summary?.by_status)}`, `- projects: ${formatCounts(payload.summary?.by_project)}`];
	for (const item of payload.items ?? []) {
		lines.push(`- ${item.id || "unknown"}: ${item.status || "unknown"} · ${projectLabel(item.project)} · ${item.safe_title || "Untitled inbox request"}`);
	}
	lines.push("- worker launch: not enabled in this slice; inbox records are queued only");
	return lines.join("\n");
}

function formatEnqueue(payload: InboxEnqueuePayload): string {
	const item = payload.item ?? {};
	const relation = item.relation?.kind || "new_task";
	const lines = [
		"## Inbox receipt",
		`- result: ${payload.enqueued ? "queued" : "unavailable"}`,
		`- item: ${item.id || "unknown"}`,
		`- project: ${projectLabel(item.project)}`,
		`- title: ${item.safe_title || "Untitled inbox request"}`,
		`- relation: ${relation}`,
		"- worker launch: not yet enabled; this is a queue/status checkpoint",
	];
	if (item.relation?.target_item_id) lines.push(`- related item: ${item.relation.target_item_id}`);
	if (payload.warnings?.length) lines.push(`- warnings: ${payload.warnings.length}`);
	return lines.join("\n");
}

function errorMessage(action: string, code: number | undefined): string {
	return ["## Async inbox", `- result: ${action} failed`, `- reason: shared inbox API exited ${code ?? "unknown"}`].join("\n");
}

export function registerInboxCommand(pi: ExtensionAPI): void {
	pi.registerCommand("inbox", {
		description: "Submit or view async front-door inbox items",
		getArgumentCompletions: (prefix: string) => ["submit", "status"].filter((item) => item.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx: ExtensionContext) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status" || trimmed === "list") {
				const result = await runScript(pi, "inbox-list.sh", ["--limit", "12", "--json"], ctx.cwd, 5_000);
				if (result.code !== 0) return pi.sendMessage({ customType: "harness-inbox", content: errorMessage("list", result.code), display: true });
				const payload = parseJson<InboxListPayload>(result.stdout);
				return pi.sendMessage({ customType: "harness-inbox", content: formatInboxList(payload ?? {}), display: true });
			}
			const submitPrefix = "submit ";
			if (!trimmed.startsWith(submitPrefix)) {
				return pi.sendMessage({ customType: "harness-inbox", content: ["## Async inbox", "- usage: /inbox submit <request>", "- usage: /inbox"].join("\n"), display: true });
			}
			const request = trimmed.slice(submitPrefix.length).trim();
			if (!request) return pi.sendMessage({ customType: "harness-inbox", content: ["## Async inbox", "- result: invalid request", "- reason: submit requires request text"].join("\n"), display: true });
			const result = await withPrivateTempTextFile("pi-inbox-request-", request, async (requestFile) => runScript(pi, "inbox-enqueue.sh", ["--request-file", requestFile, "--cwd", ctx.cwd, "--json"], ctx.cwd, 8_000));
			if (result.code !== 0) return pi.sendMessage({ customType: "harness-inbox", content: errorMessage("submit", result.code), display: true });
			const payload = parseJson<InboxEnqueuePayload>(result.stdout);
			return pi.sendMessage({ customType: "harness-inbox", content: formatEnqueue(payload ?? {}), display: true });
		},
	});
}
