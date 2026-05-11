import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withPrivateTempTextFile } from "../shared/private-temp";
import { runScript } from "./task-layer-api";
import type { InboxLaunchSpec } from "./inbox-types";

const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const RESPONSE_TIMEOUT_MS = 5_000;

type EventBus = { on?: (event: string, handler: (data: unknown) => void) => (() => void) | void; emit?: (event: string, data: unknown) => void };
type LaunchResult = { state: "started" | "degraded" | "failed"; asyncId?: string; asyncDir?: string; message: string };

type PendingLaunch = { itemId: string; spec: InboxLaunchSpec; ctx: ExtensionContext };

async function recordLifecycleStatus(pi: ExtensionAPI, ctx: ExtensionContext, itemId: string, status: "failed" | "blocked", message: string): Promise<boolean> {
	try {
		const runComplete = async (summaryFile: string) => runScript(pi, "inbox-worker-complete.sh", ["--item-id", itemId, "--status", status, "--summary-file", summaryFile, "--json"], ctx.cwd, 8_000);
		const result = await withPrivateTempTextFile("pi-inbox-lifecycle-", message, runComplete);
		return result.code === 0;
	} catch {
		return false;
	}
}

function eventBus(pi: ExtensionAPI): EventBus | undefined {
	return (pi as unknown as { events?: EventBus }).events;
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asyncIdFromResponse(data: unknown): { requestId?: string; asyncId?: string; asyncDir?: string; isError?: boolean } {
	if (!data || typeof data !== "object") return {};
	const raw = data as { requestId?: unknown; isError?: unknown; result?: { details?: { asyncId?: unknown; runId?: unknown; asyncDir?: unknown } } };
	return {
		requestId: textOf(raw.requestId),
		asyncId: textOf(raw.result?.details?.asyncId || raw.result?.details?.runId),
		asyncDir: textOf(raw.result?.details?.asyncDir),
		isError: raw.isError === true,
	};
}

function completionData(data: unknown): { asyncId?: string; success?: boolean; summary?: string; artifactPath?: string } {
	if (!data || typeof data !== "object") return {};
	const raw = data as { id?: unknown; runId?: unknown; success?: unknown; summary?: unknown; results?: Array<{ output?: unknown; error?: unknown; success?: unknown; artifactPaths?: { outputPath?: unknown } }> };
	const first = Array.isArray(raw.results) ? raw.results[0] : undefined;
	return {
		asyncId: textOf(raw.id || raw.runId),
		success: typeof first?.success === "boolean" ? first.success : typeof raw.success === "boolean" ? raw.success : undefined,
		summary: textOf(first?.output || first?.error || raw.summary),
		artifactPath: textOf(first?.artifactPaths?.outputPath),
	};
}

export function createInboxWorkerBridge(pi: ExtensionAPI) {
	const bus = eventBus(pi);
	const pending = new Map<string, PendingLaunch>();
	const byAsyncId = new Map<string, PendingLaunch>();
	const responseWaiters = new Map<string, (result: LaunchResult) => void>();

	bus?.on?.(SLASH_SUBAGENT_RESPONSE_EVENT, (data: unknown) => {
		const response = asyncIdFromResponse(data);
		if (!response.requestId) return;
		const waiter = responseWaiters.get(response.requestId);
		const pendingLaunch = pending.get(response.requestId);
		responseWaiters.delete(response.requestId);
		if (!waiter) return;
		if (response.isError) {
			waiter({ state: "failed", message: "subagent bridge returned an error" });
			pending.delete(response.requestId);
			return;
		}
		if (!response.asyncId) {
			waiter({ state: "degraded", message: "subagent bridge response did not include an async run id" });
			pending.delete(response.requestId);
			return;
		}
		if (pendingLaunch) byAsyncId.set(response.asyncId, pendingLaunch);
		waiter({ state: "started", asyncId: response.asyncId, asyncDir: response.asyncDir, message: "worker launch accepted" });
		pending.delete(response.requestId);
	});

	bus?.on?.(SUBAGENT_ASYNC_COMPLETE_EVENT, (data: unknown) => {
		const complete = completionData(data);
		if (!complete.asyncId) return;
		const launch = byAsyncId.get(complete.asyncId);
		byAsyncId.delete(complete.asyncId);
		void (async () => {
			try {
				const cwd = launch?.ctx.cwd || process.cwd();
				const runComplete = async (summaryFile?: string) => {
					const args = ["--backend-run-id", complete.asyncId || "", "--status", complete.success === false ? "failed" : "completed"];
					if (summaryFile) args.push("--summary-file", summaryFile);
					if (complete.artifactPath) args.push("--artifact", complete.artifactPath);
					args.push("--json");
					await runScript(pi, "inbox-worker-complete.sh", args, cwd, 8_000);
				};
				if (complete.summary) await withPrivateTempTextFile("pi-inbox-summary-", complete.summary, runComplete);
				else await runComplete();
			} catch {
				// Completion recording is best-effort and must not surface raw worker output.
			}
		})();
	});

	async function launch(ctx: ExtensionContext, itemId: string, spec: InboxLaunchSpec): Promise<LaunchResult> {
		try {
			if (!bus?.emit || !bus?.on) {
				const result: LaunchResult = { state: "degraded", message: "worker bridge unavailable" };
				await recordLifecycleStatus(pi, ctx, itemId, "failed", "Worker launch did not start: bridge unavailable.");
				return result;
			}
			if (spec.backend !== "pi_subagents_async") {
				const result: LaunchResult = { state: "degraded", message: "unsupported worker backend" };
				await recordLifecycleStatus(pi, ctx, itemId, "failed", "Worker launch did not start: unsupported backend.");
				return result;
			}
			const requestId = `inbox-${randomUUID().slice(0, 8)}`;
			pending.set(requestId, { itemId, spec, ctx });
			const result = await new Promise<LaunchResult>((resolve) => {
				const timer = setTimeout(() => {
					responseWaiters.delete(requestId);
					pending.delete(requestId);
					resolve({ state: "degraded", message: "worker launch timed out" });
				}, RESPONSE_TIMEOUT_MS);
				responseWaiters.set(requestId, (value) => {
					clearTimeout(timer);
					resolve(value);
				});
				try {
					bus.emit?.(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params: spec.params ?? {} });
				} catch {
					clearTimeout(timer);
					responseWaiters.delete(requestId);
					pending.delete(requestId);
					resolve({ state: "failed", message: "worker bridge launch failed" });
				}
			});
			if (result.state !== "started") {
				await recordLifecycleStatus(pi, ctx, itemId, "failed", "Worker launch did not start.");
				return result;
			}
			const started = await runScript(pi, "inbox-worker-start.sh", ["--item-id", itemId, "--backend-run-id", result.asyncId || "", "--backend", spec.backend || "pi_subagents_async", "--runtime", "pi", "--session", ctx.sessionManager?.getSessionId?.() || "", ...(result.asyncDir ? ["--async-dir", result.asyncDir] : []), "--json"], ctx.cwd, 8_000);
			if (started.code !== 0) {
				await recordLifecycleStatus(pi, ctx, itemId, "blocked", "Worker launch was accepted, but lifecycle start recording failed; manual inspection may be required.");
				return { ...result, state: "degraded", message: "worker lifecycle recording failed" };
			}
			return result;
		} catch {
			await recordLifecycleStatus(pi, ctx, itemId, "failed", "Worker launch failed before start could be recorded.");
			return { state: "failed", message: "worker launch failed" };
		}
	}

	return { launch };
}
