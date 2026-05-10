import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { OrchestrationDecisionState } from "./orchestration-guidance";

function shellUnquote(value: string): string {
	return value.replace(/^["']|["']$/g, "");
}

function normalizeCandidatePath(candidate: string): string {
	let value = shellUnquote(candidate.trim()).replace(/\\([\\\s;&|])/g, "$1");
	if (value === "${HOME}") value = homedir();
	else if (value.startsWith("${HOME}/")) value = path.join(homedir(), value.slice(8));
	return value;
}

function expandLocalPath(rawPath: string, cwd: string): string | undefined {
	const normalized = normalizeCandidatePath(rawPath);
	if (!normalized || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) return undefined;
	const expanded = normalized === "~" ? homedir() : normalized.startsWith("~/") ? path.join(homedir(), normalized.slice(2)) : normalized;
	return path.resolve(cwd, expanded);
}

function isHtmlPath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return ext === ".html" || ext === ".htm";
}

function htmlAutoOpenEnabled(decision?: OrchestrationDecisionState): boolean {
	const html = decision?.decision?.artifacts?.html;
	const autoOpen = html?.auto_open;
	if (!autoOpen?.enabled) return false;
	const allowedModes = new Set(autoOpen.modes ?? []);
	return Boolean(html?.modes?.some((mode) => mode.id && allowedModes.has(mode.id)));
}

export function htmlArtifactPathFromTool(event: ToolResultEvent, cwd: string, decision?: OrchestrationDecisionState): string | undefined {
	if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return undefined;
	const rawPath = event.input?.path;
	if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
	const filePath = expandLocalPath(rawPath, cwd);
	if (!filePath || !isHtmlPath(filePath)) return undefined;
	if (!htmlAutoOpenEnabled(decision)) return undefined;
	return filePath;
}

export async function openHtmlArtifact(pi: ExtensionAPI, ctx: ExtensionContext, filePath: string): Promise<boolean> {
	if (ctx.hasUI === false) return false;
	try {
		await access(filePath);
		const result = await pi.exec("open", [filePath], { cwd: ctx.cwd, timeout: 5_000 });
		if (result.code === 0) {
			ctx.ui?.notify?.(`Opened HTML artifact: ${path.basename(filePath)}`, "info");
			return true;
		}
	} catch {
		// Auto-open is best-effort and must never fail the agent turn.
	}
	return false;
}
