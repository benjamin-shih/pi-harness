import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseJson } from "../shared/json";
import { runScript } from "./task-layer-api";
import { SUPPORTED_TASK_API_VERSION, supportsTaskRetentionDiagnostics, type TaskLayerState } from "./task-layer-types";
type TaskRetentionResult = { task_api_version?: number; scope?: "project" | "all"; project_scoped?: boolean; policy?: { destructive_actions?: boolean; archive_supported?: boolean; archive_delete_supported?: boolean }; summary?: Record<string, number | undefined> };
function retentionLines(payload: TaskRetentionResult): string[] {
	const policy = payload.policy ?? {};
	const s = payload.summary ?? {};
	const n = (key: string): number => {
		const value = s[key];
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	};
	const malformed = n("malformed_status_files") + n("malformed_lease_files") + n("malformed_artifact_lines") + n("malformed_event_lines");
	const skippedDelete = n("archive_delete_skipped_malformed") + n("archive_delete_skipped_checksum") + n("archive_delete_skipped_active_slot") + n("archive_delete_skipped_blocked");
	const [packages, archived] = payload.project_scoped ? [`${n("task_packages_scoped")} scoped`, `${n("archived_task_packages_scoped")} archived scoped`] : [`${n("task_packages_total")} total`, `${n("archived_task_packages_total")} archived total`];
	return [
		`- retention API: ok (v${payload.task_api_version ?? "?"})`,
		`- retention scope: ${payload.scope ?? "unknown"}; destructive actions ${policy.destructive_actions ? "enabled" : "disabled"}`,
		`- task packages: ${packages}; ${n("active_tasks")} active, ${n("terminal_tasks")} terminal, ${n("stale_tasks")} stale`,
		`- retention candidates: ${n("stale_candidates")} stale candidates, ${n("terminal_retention_candidates")} old terminal candidates`,
		`- archive: ${policy.archive_supported ? "available" : "unavailable"}; ${n("archive_candidates")} candidates, ${archived}`,
		`- archive delete: ${policy.archive_delete_supported ? "available" : "unavailable"}; ${n("archive_delete_candidates")} candidates, ${skippedDelete} skipped`,
		`- task leases: ${n("live_leases")} live, ${n("expired_leases")} expired, ${n("missing_leases")} missing`,
		`- artifact indexes: ${n("artifact_indexes")} indexes, ${n("artifact_records")} records, ${n("artifact_index_bytes")} bytes, ${n("oversized_artifact_indexes")} oversized`,
		`- event ledgers: ${n("event_ledgers")} ledgers, ${n("event_records")} records, ${n("event_log_bytes")} bytes`,
		`- retention metadata: ${malformed} malformed lines/files, ${n("lock_files")} lock files observed`,
	];
}
export async function retentionSection(pi: ExtensionAPI, ctx: ExtensionContext, state: TaskLayerState): Promise<string[]> {
	if (!supportsTaskRetentionDiagnostics(state)) return ["- retention API: unavailable (capability not advertised)"];
	try {
		const result = await runScript(pi, "task-retention.sh", ["--cwd", ctx.cwd], ctx.cwd, 8_000);
		if (result.code !== 0) return ["- retention API: unavailable (script_error)"];
		const payload = parseJson<TaskRetentionResult>(result.stdout);
		return payload?.task_api_version === SUPPORTED_TASK_API_VERSION ? retentionLines(payload) : ["- retention API: unavailable (unsupported API version)"];
	} catch {
		return ["- retention API: unavailable (exception)"];
	}
}
