import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";

export type MemoryAdminScope = { taskId?: string; projectRoot?: string };

type MemoryMutationPayload = {
	memory_api_version?: number;
	recorded?: boolean;
	promoted?: boolean;
	forgotten?: boolean;
	record?: { id?: string; state?: string; title?: string; scope?: { type?: string; project_root?: string; task_id?: string } };
};

type ParsedRemember = { text: string; scope: "task" | "project" | "global" };

function parseRememberArgs(args: string, scope: MemoryAdminScope): ParsedRemember | undefined {
	let text = args.trim();
	let requested: ParsedRemember["scope"] | undefined;
	for (const [pattern, value] of [
		[/^--global\s+/, "global"],
		[/^global\s+/, "global"],
		[/^--task\s+/, "task"],
		[/^task\s+/, "task"],
		[/^--project\s+/, "project"],
		[/^project\s+/, "project"],
	] as const) {
		if (pattern.test(text)) {
			requested = value;
			text = text.replace(pattern, "").trim();
			break;
		}
	}
	if (!text) return undefined;
	return { text, scope: requested ?? (scope.taskId ? "task" : "project") };
}

function titleFromText(text: string): string {
	const clipped = text.replace(/\s+/g, " ").trim().slice(0, 80);
	return `Memory candidate: ${clipped || "Untitled"}`;
}

async function withPrivateFiles<T>(files: Record<string, string>, callback: (paths: Record<string, string>) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-admin-"));
	try {
		const paths: Record<string, string> = {};
		for (const [name, content] of Object.entries(files)) {
			const path = join(dir, name);
			await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
			paths[name] = path;
		}
		return await callback(paths);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function formatMutation(title: string, payload: MemoryMutationPayload | undefined): string {
	if (!payload?.record) return [title, "- status: failed", "- reason: invalid response from memory API"].join("\n");
	const record = payload.record;
	return [
		title,
		`- id: ${record.id ?? "unknown"}`,
		`- state: ${record.state ?? "unknown"}`,
		`- title: ${record.title ?? ""}`,
		`- scope: ${record.scope?.type ?? "unknown"}`,
		"- durable write: explicit user command",
	].join("\n");
}

function mutationError(title: string, result: { code?: number; stdout?: string; stderr?: string }): string {
	return [title, "- status: failed", `- exit: ${result.code ?? "unknown"}`, "- reason: memory API rejected the request or scope"].join("\n");
}

export async function rememberCandidate(pi: ExtensionAPI, ctx: ExtensionContext, args: string, scope: MemoryAdminScope): Promise<string> {
	const parsed = parseRememberArgs(args, scope);
	if (!parsed) return ["## Remember candidate", "- status: skipped", "- usage: `/remember [--task|--project|--global] text to remember`"].join("\n");
	if (parsed.scope === "task" && !scope.taskId) return ["## Remember candidate", "- status: skipped", "- reason: no active task scope; use `/remember --project ...` or `/remember --global ...` explicitly"].join("\n");
	const projectRoot = scope.projectRoot || ctx.cwd;
	return await withPrivateFiles({ "title.txt": titleFromText(parsed.text), "body.txt": parsed.text, "reason.txt": "explicit /remember command" }, async (paths) => {
		const command = [agentsScriptPath("memory-add.sh"), "--title-file", paths["title.txt"], "--body-file", paths["body.txt"], "--reason-file", paths["reason.txt"], "--scope", parsed.scope, "--state", "candidate", "--json"];
		if (parsed.scope === "task") command.push("--task-id", scope.taskId ?? "");
		if (parsed.scope === "project") command.push("--project-root", projectRoot);
		const result = await pi.exec("bash", command, { cwd: ctx.cwd, timeout: 8_000 });
		if (result.code !== 0) return mutationError("## Remember candidate", result);
		return formatMutation("## Remember candidate", parseJson<MemoryMutationPayload>(result.stdout));
	});
}

export async function promoteMemory(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<string> {
	const [id, ...reasonParts] = args.trim().split(/\s+/).filter(Boolean);
	if (!id) return ["## Promote memory", "- status: skipped", "- usage: `/promote-memory memory_id [reason]`"].join("\n");
	const reason = reasonParts.join(" ") || "explicit /promote-memory command";
	return await withPrivateFiles({ "reason.txt": reason }, async (paths) => {
		const result = await pi.exec("bash", [agentsScriptPath("memory-promote.sh"), id, "--reason-file", paths["reason.txt"], "--json"], { cwd: ctx.cwd, timeout: 8_000 });
		if (result.code !== 0) return mutationError("## Promote memory", result);
		return formatMutation("## Promote memory", parseJson<MemoryMutationPayload>(result.stdout));
	});
}

export async function forgetMemory(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<string> {
	const [id, ...reasonParts] = args.trim().split(/\s+/).filter(Boolean);
	if (!id) return ["## Forget memory", "- status: skipped", "- usage: `/forget-memory memory_id [reason]`"].join("\n");
	const reason = reasonParts.join(" ") || "explicit /forget-memory command";
	return await withPrivateFiles({ "reason.txt": reason }, async (paths) => {
		const result = await pi.exec("bash", [agentsScriptPath("memory-forget.sh"), id, "--reason-file", paths["reason.txt"], "--json"], { cwd: ctx.cwd, timeout: 8_000 });
		if (result.code !== 0) return mutationError("## Forget memory", result);
		return formatMutation("## Forget memory", parseJson<MemoryMutationPayload>(result.stdout));
	});
}
