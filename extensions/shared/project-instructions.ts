import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";

const INSTRUCTION_DOCTOR_API_VERSION = 1;

type InstructionFileHealth = {
	path?: string;
	exists?: boolean;
	line_count?: number;
	has_shared_pointer?: boolean;
	has_ambient_context?: boolean;
	thin_style?: boolean;
	stale?: {
		dispatch_mentions?: number;
		launcher_mentions?: number;
		task_file_reading_lists?: number;
		duplicated_shared_blocks?: number;
	};
};

type ProjectInstructionPayload = {
	instruction_doctor_api_version?: number;
	project_root?: string;
	health?: "ok" | "warning";
	summary?: {
		instruction_files_found?: number;
		thin_style_files?: number;
		dispatch_mentions?: number;
		launcher_mentions?: number;
		task_file_reading_lists?: number;
		duplicated_shared_blocks?: number;
		local_skills_index?: boolean;
	};
	files?: InstructionFileHealth[];
	warnings?: string[];
};

export type ProjectInstructionResult = { ok: true; payload: ProjectInstructionPayload } | { ok: false; reason: string };

export async function buildProjectInstructions(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ProjectInstructionResult> {
	try {
		const result = await pi.exec("bash", [agentsScriptPath("project-instruction-doctor.sh"), "--cwd", ctx.cwd], { cwd: ctx.cwd, timeout: 5_000 });
		if (result.code !== 0) return { ok: false, reason: "script_error" };
		const payload = parseJson<ProjectInstructionPayload>(result.stdout);
		if (payload?.instruction_doctor_api_version !== INSTRUCTION_DOCTOR_API_VERSION) return { ok: false, reason: "unsupported API version" };
		return { ok: true, payload };
	} catch {
		return { ok: false, reason: "exception" };
	}
}

export function projectInstructionHealth(result: ProjectInstructionResult): "ok" | "warning" {
	return result.ok && result.payload.health === "ok" ? "ok" : "warning";
}

function fileLabel(file: InstructionFileHealth): string {
	const path = file.path || "unknown";
	const name = path.split("/").pop() || path;
	if (!file.exists) return `${name}: missing`;
	return `${name}: ${file.thin_style ? "thin" : "needs review"} (${file.line_count ?? 0} lines)`;
}

export function formatProjectInstructionLines(result: ProjectInstructionResult): string[] {
	if (!result.ok) return [`- instruction health: unavailable (${result.reason})`];
	const payload = result.payload;
	const summary = payload.summary ?? {};
	const warnings = payload.warnings ?? [];
	return [
		`- instruction health: ${payload.health ?? "unknown"}`,
		`- project root: ${payload.project_root || "unknown"}`,
		`- instruction files: ${summary.instruction_files_found ?? 0} found, ${summary.thin_style_files ?? 0} thin-style`,
		`- stale markers: ${summary.dispatch_mentions ?? 0} dispatch, ${summary.launcher_mentions ?? 0} launcher, ${summary.task_file_reading_lists ?? 0} task-file lists, ${summary.duplicated_shared_blocks ?? 0} duplicated blocks`,
		`- local skills index: ${summary.local_skills_index ? "present" : "absent"}`,
		`- files: ${(payload.files ?? []).map(fileLabel).join("; ") || "none"}`,
		...(warnings.length ? [`- warnings: ${warnings.slice(0, 3).join("; ")}`] : ["- warnings: none"]),
	];
}
