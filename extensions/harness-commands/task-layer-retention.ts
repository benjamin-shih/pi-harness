import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseJson } from "../shared/json";
import { runScript } from "./task-layer-api";
import { SUPPORTED_TASK_API_VERSION, supportsTaskRetentionDiagnostics, type TaskLayerState } from "./task-layer-types";
type TaskRetentionResult = { task_api_version?: number; scope: "project" | "all"; project_scoped?: boolean; policy: { destructive_actions: boolean; archive_supported?: boolean; archive_delete_supported?: boolean }; summary: Record<string, number> };
function retentionLines(payload: TaskRetentionResult): string[] {
	const s = payload.summary;
	const malformed = s.malformed_status_files + s.malformed_lease_files + s.malformed_artifact_lines + s.malformed_event_lines;
	const [packages, archived] = payload.project_scoped ? [`${s.task_packages_scoped} scoped`, `${s.archived_task_packages_scoped ?? 0} archived scoped`] : [`${s.task_packages_total} total`, `${s.archived_task_packages_total ?? 0} archived total`];
	return [
		`- retention API: ok (v${payload.task_api_version ?? "?"})`,
		`- retention scope: ${payload.scope}; destructive actions ${payload.policy.destructive_actions ? "enabled" : "disabled"}`,
		`- task packages: ${packages}; ${s.active_tasks} active, ${s.terminal_tasks} terminal, ${s.stale_tasks} stale`,
		`- retention candidates: ${s.stale_candidates} stale candidates, ${s.terminal_retention_candidates} old terminal candidates`,
		`- archive: ${payload.policy.archive_supported ? "available" : "unavailable"}; ${s.archive_candidates ?? 0} candidates, ${archived}`,
		`- archive delete: ${payload.policy.archive_delete_supported ? "available" : "unavailable"}; ${s.archive_delete_candidates ?? 0} candidates, ${(s.archive_delete_skipped_malformed ?? 0) + (s.archive_delete_skipped_checksum ?? 0) + (s.archive_delete_skipped_active_slot ?? 0) + (s.archive_delete_skipped_blocked ?? 0)} skipped`,
		`- task leases: ${s.live_leases} live, ${s.expired_leases} expired, ${s.missing_leases} missing`,
		`- artifact indexes: ${s.artifact_indexes} indexes, ${s.artifact_records} records, ${s.artifact_index_bytes} bytes, ${s.oversized_artifact_indexes} oversized`,
		`- event ledgers: ${s.event_ledgers} ledgers, ${s.event_records} records, ${s.event_log_bytes} bytes`,
		`- retention metadata: ${malformed} malformed lines/files, ${s.lock_files} lock files observed`,
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
