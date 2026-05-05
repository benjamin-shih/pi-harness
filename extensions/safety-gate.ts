import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { GIT_FINALIZATION_MARKER, getGitFinalizationState, gitFinalizationStateChanged, needsGitFinalization, summarizeGitFinalizationState, type GitFinalizationState } from "./safety-gate-lib/finalization";
import { createPathSafetyChecker, type PathSafetyCheck, type PolicyOperation } from "./safety-gate-lib/policy";
import { BLOCKED_OUTPUT, HIDDEN_SENSITIVE_RESULT, contentMentionsSensitivePath, redactToolContent } from "./safety-gate-lib/redaction";
import { extractCopyMoveSourcePathTokens, extractInputPathTokens, extractOutputPathTokens, extractPathTokens, extractRecursiveEgressSourcePathTokens, extractWritePathTokens, looksMutatingBash, looksRecursiveTraversalCommand, parseGitCommands } from "./safety-gate-lib/shell";
const BLOCKED_GIT =
	"[safety-gate] Blocked git operation because it may stage, commit, or push credential-bearing private files.";
const OUTPUT_COMMAND_RE = /\b(?:cat|bat|less|more|head|tail|sort|uniq|cut|wc|diff|comm|sed|awk|grep|egrep|fgrep|rg|ripgrep|strings|xxd|hexdump|base64|openssl|jq|python3?|node|ruby|perl)\b/i;
const UPLOAD_COMMAND_RE = /\b(?:curl|wget|scp|sftp|rsync|rclone|aws\s+s3\s+cp|aws\s+s3\s+sync|gh\s+release\s+upload)\b/i;
async function commandMentionsSensitivePath(pathSafety: PathSafetyCheck, command: string, cwd: string, operation: PolicyOperation = "egress", recursive = false): Promise<boolean> {
	for (const token of extractPathTokens(command)) {
		if (await pathSafety(token, cwd, operation, recursive)) return true;
	}
	return false;
}
async function commandMentionsBlockedWritePath(pathSafety: PathSafetyCheck, command: string, cwd: string): Promise<boolean> {
	for (const token of extractWritePathTokens(command)) {
		if ((await pathSafety(token, cwd, "write", true))?.action === "block") return true;
	}
	return false;
}
async function commandMentionsSensitiveEgressOperand(pathSafety: PathSafetyCheck, command: string, cwd: string): Promise<boolean> {
	for (const token of extractCopyMoveSourcePathTokens(command)) {
		if (await pathSafety(token, cwd, "egress")) return true;
	}
	const outputTargets = new Set(extractOutputPathTokens(command));
	const inputTargets = new Set(extractInputPathTokens(command));
	const writeTargets = new Set(extractWritePathTokens(command));
	for (const token of extractPathTokens(command)) {
		if (outputTargets.has(token) || inputTargets.has(token) || writeTargets.has(token)) continue;
		if (await pathSafety(token, cwd, "egress")) return true;
	}
	return false;
}
async function commandMentionsRecursiveEgressPath(pathSafety: PathSafetyCheck, command: string, cwd: string): Promise<boolean> {
	for (const token of extractRecursiveEgressSourcePathTokens(command)) {
		if (await pathSafety(token, cwd, "egress", true)) return true;
	}
	return false;
}
function parsePorcelainPaths(stdout: string): string[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.slice(3).trim())
		.filter(Boolean)
		.map((file) => file.split(" -> ").at(-1) ?? file);
}
type GitSafetyStatus = "safe" | "unsafe" | "unknown";
function unsafeIfUnknown(status: GitSafetyStatus): boolean {
	return status !== "safe";
}
async function gitLines(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string[] | undefined> {
	try {
		const result = await pi.exec("git", args, { cwd, timeout: 5_000 });
		if (result.code !== 0) return undefined;
		return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	} catch {
		return undefined;
	}
}
async function gitPathStatus(pathSafety: PathSafetyCheck, cwd: string, paths: string[] | undefined): Promise<GitSafetyStatus> {
	if (!paths) return "unknown";
	for (const p of paths) {
		if (await pathSafety(p, cwd, "git")) return "unsafe";
	}
	return "safe";
}
async function pathspecGitPathStatus(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string, pathspecs: string[]): Promise<GitSafetyStatus> {
	if (!pathspecs.length) return "safe";
	try {
		const result = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ...pathspecs], {
			cwd,
			timeout: 5_000,
		});
		if (result.code !== 0) return "unknown";
		return gitPathStatus(pathSafety, cwd, parsePorcelainPaths(result.stdout));
	} catch {
		return "unknown";
	}
}
async function changedGitPathStatus(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string): Promise<GitSafetyStatus> {
	try {
		const result = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
			cwd,
			timeout: 5_000,
		});
		if (result.code !== 0) return "unknown";
		return gitPathStatus(pathSafety, cwd, parsePorcelainPaths(result.stdout));
	} catch {
		return "unknown";
	}
}
async function stagedGitPathStatus(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string): Promise<GitSafetyStatus> {
	return gitPathStatus(pathSafety, cwd, await gitLines(pi, cwd, ["diff", "--cached", "--name-only"]));
}
async function outgoingGitPathStatus(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string): Promise<GitSafetyStatus> {
	try {
		const upstream = await pi.exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
			cwd,
			timeout: 5_000,
		});
		if (upstream.code !== 0) return "unknown";
		const base = upstream.stdout.trim();
		return gitPathStatus(pathSafety, cwd, await gitLines(pi, cwd, ["diff", "--name-only", `${base}..HEAD`]));
	} catch {
		return "unknown";
	}
}
function expandShellHome(path: string): string {
	if (path === "~" || path === "$HOME" || path === "${HOME}") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	if (path.startsWith("$HOME/")) return resolve(homedir(), path.slice(6));
	if (path.startsWith("${HOME}/")) return resolve(homedir(), path.slice(8));
	return path;
}
function gitEffectiveCwd(baseCwd: string, gitCwd: string | undefined): string {
	if (!gitCwd) return baseCwd;
	const expanded = expandShellHome(gitCwd);
	return isAbsolute(expanded) ? expanded : resolve(baseCwd, expanded);
}
function shellPathCwd(baseCwd: string, rawPath: string): string {
	const expanded = expandShellHome(rawPath);
	return isAbsolute(expanded) ? expanded : resolve(baseCwd, expanded);
}
function isBroadGitAdd(args: string[]): boolean {
	return args.length === 0 || args.some((arg) => arg === "-A" || arg === "--all" || arg === "-u" || arg === "--update" || arg === "." || arg === ":/" || arg === ":" || arg === "*");
}
function isCommitAll(args: string[]): boolean {
	return args.some((arg) => arg === "--all" || arg === "-a" || /^-[^-].*a/.test(arg));
}
function hasPathspecFileOption(args: string[]): boolean {
	return args.some((arg) => arg === "--pathspec-from-file" || arg.startsWith("--pathspec-from-file=") || arg === "--pathspec-file-nul");
}
function optionConsumesNextArg(arg: string): boolean {
	return ["-m", "-F", "-C", "-c", "--message", "--file", "--author", "--date", "--reuse-message", "--reedit-message", "--cleanup", "--pathspec-from-file"].includes(arg);
}
function extractGitPathspecArgs(args: string[]): string[] {
	const pathspecs: string[] = [];
	let afterDoubleDash = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (afterDoubleDash) {
			pathspecs.push(arg);
			continue;
		}
		if (arg === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (optionConsumesNextArg(arg) || (/^-[^-]/.test(arg) && /[mFCc]/.test(arg.slice(1)) && arg.length <= 3)) {
			index++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		pathspecs.push(arg);
	}
	return pathspecs;
}
function pushHasUninspectedRefs(args: string[]): boolean {
	if (args.some((arg) => ["--all", "--mirror", "--tags", "--follow-tags"].includes(arg))) return true;
	let operands = 0;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--repo" || arg === "--receive-pack" || arg === "--exec") {
			if (arg === "--repo") operands++;
			index++;
			continue;
		}
		if (arg.startsWith("--repo=")) {
			operands++;
			continue;
		}
		if (arg.startsWith("--receive-pack=") || arg.startsWith("--exec=")) continue;
		if (arg.startsWith("-")) continue;
		operands++;
	}
	return operands > 1;
}
async function gitBlockReason(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string, command: string): Promise<string | undefined> {
	const gitCommands = parseGitCommands(command);
	for (const git of gitCommands) {
		const effectiveCwd = gitEffectiveCwd(cwd, git.cwd);
		const writesToIndex = git.subcommand === "add" || git.subcommand === "commit";
		if (writesToIndex && await commandMentionsSensitivePath(pathSafety, command, effectiveCwd, "git")) return BLOCKED_GIT;
		if (git.subcommand === "add") {
			if (hasPathspecFileOption(git.args)) return BLOCKED_GIT;
			if (isBroadGitAdd(git.args) && unsafeIfUnknown(await changedGitPathStatus(pi, pathSafety, effectiveCwd))) return BLOCKED_GIT;
			if (!isBroadGitAdd(git.args) && unsafeIfUnknown(await pathspecGitPathStatus(pi, pathSafety, effectiveCwd, extractGitPathspecArgs(git.args)))) return BLOCKED_GIT;
		}
		if (git.subcommand === "commit") {
			if (hasPathspecFileOption(git.args)) return BLOCKED_GIT;
			if (unsafeIfUnknown(await stagedGitPathStatus(pi, pathSafety, effectiveCwd))) return BLOCKED_GIT;
			if (isCommitAll(git.args) && unsafeIfUnknown(await changedGitPathStatus(pi, pathSafety, effectiveCwd))) return BLOCKED_GIT;
			if (unsafeIfUnknown(await pathspecGitPathStatus(pi, pathSafety, effectiveCwd, extractGitPathspecArgs(git.args)))) return BLOCKED_GIT;
		}
		if (git.subcommand === "push" && (pushHasUninspectedRefs(git.args) || unsafeIfUnknown(await outgoingGitPathStatus(pi, pathSafety, effectiveCwd)))) return BLOCKED_GIT;
	}
	return undefined;
}
function blockedTool(reason: string) {
	return { block: true, reason };
}
function blockedUserBash(reason: string) {
	return { result: { output: reason, exitCode: 1, cancelled: false, truncated: false } };
}
async function commandInputsSensitivePath(pathSafety: PathSafetyCheck, command: string, cwd: string): Promise<boolean> {
	for (const token of extractInputPathTokens(command)) {
		if (await pathSafety(token, cwd, "egress")) return true;
	}
	return false;
}
async function guardShellCommand(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string, command: string, forUserBash = false) {
	const block = (reason: string) => forUserBash ? blockedUserBash(reason) : blockedTool(reason);
	const gitReason = await gitBlockReason(pi, pathSafety, cwd, command);
	if (gitReason) return block(gitReason);
	const mutating = looksMutatingBash(command);
	if (mutating && (
		(await pathSafety(".", cwd, "write"))?.action === "block" ||
		await commandMentionsBlockedWritePath(pathSafety, command, cwd)
	)) {
		return block(BLOCKED_OUTPUT);
	}
	if ((await pathSafety(".", cwd, "egress"))?.action === "block") return block(BLOCKED_OUTPUT);
	if (await commandInputsSensitivePath(pathSafety, command, cwd)) return block(BLOCKED_OUTPUT);
	if (await commandMentionsSensitiveEgressOperand(pathSafety, command, cwd)) return block(BLOCKED_OUTPUT);
	if (await commandMentionsRecursiveEgressPath(pathSafety, command, cwd)) return block(BLOCKED_OUTPUT);
	const outputOrUpload = OUTPUT_COMMAND_RE.test(command) || UPLOAD_COMMAND_RE.test(command);
	if (outputOrUpload && await commandMentionsSensitivePath(pathSafety, command, cwd, "egress")) return block(BLOCKED_OUTPUT);
	if (looksRecursiveTraversalCommand(command) && (
		await pathSafety(".", cwd, "list", true) ||
		await commandMentionsSensitivePath(pathSafety, command, cwd, "list", true)
	)) {
		return block(BLOCKED_OUTPUT);
	}
	return undefined;
}
export default function safetyGate(pi: ExtensionAPI) {
	const { pathSafety, clearPathSafetyCache } = createPathSafetyChecker(pi);
	const on = pi.on as unknown as (event: string, handler: (event: any, ctx: any) => unknown) => void;
	let initialGitState: GitFinalizationState | undefined;
	let sawPotentialMutation = false;
	let currentPromptIsGuardBounce = false;
	pi.on("before_agent_start", async (event, ctx) => {
		clearPathSafetyCache();
		initialGitState = await getGitFinalizationState(pi, ctx.cwd);
		sawPotentialMutation = false;
		currentPromptIsGuardBounce = event.prompt.includes(GIT_FINALIZATION_MARKER);
	});
	on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		if (event.toolName === "edit" || event.toolName === "write") {
			sawPotentialMutation = true;
			const writeDecision = await pathSafety(input.path as string | undefined, ctx.cwd, "write");
			if (writeDecision?.action === "block") return blockedTool(BLOCKED_OUTPUT);
		}
		if (event.toolName === "read") {
			if (await pathSafety(input.path as string | undefined, ctx.cwd, "read")) return blockedTool(BLOCKED_OUTPUT);
		}
		if (event.toolName === "grep") {
			const grepPath = typeof input.path === "string" ? input.path : ".";
			if (
				await pathSafety(grepPath, ctx.cwd, "list", true) ||
				await pathSafety(input.glob as string | undefined, ctx.cwd, "list")
			) {
				return blockedTool(BLOCKED_OUTPUT);
			}
		}
		if (event.toolName === "find" || event.toolName === "ls") {
			const listPath = typeof input.path === "string" ? input.path : ".";
			if (await pathSafety(listPath, ctx.cwd, "list", event.toolName === "find")) return blockedTool(BLOCKED_OUTPUT);
		}
		if (event.toolName === "bash") {
			const command = String(input.command ?? "");
			if (looksMutatingBash(command)) sawPotentialMutation = true;
			return guardShellCommand(pi, pathSafety, ctx.cwd, command, false);
		}
		return undefined;
	});
	on("tool_result", async (event, ctx) => {
		const input = event.input as Record<string, unknown> | undefined;
		const resultPath = typeof input?.path === "string" ? input.path : (event.toolName === "find" || event.toolName === "ls" ? "." : undefined);
		const scansListingContent = event.toolName === "find" || event.toolName === "ls";
		const resultContentCwd = scansListingContent && typeof input?.path === "string" ? shellPathCwd(ctx.cwd, input.path) : ctx.cwd;
		if (
			(event.toolName === "write" || event.toolName === "edit" || event.toolName === "read" || event.toolName === "grep" || scansListingContent) &&
			(await pathSafety(resultPath, ctx.cwd, "egress") ||
				await pathSafety(input?.glob as string | undefined, ctx.cwd, "egress") ||
				(scansListingContent && await contentMentionsSensitivePath(pathSafety, event.content, resultContentCwd)))
		) {
			return { content: [{ type: "text", text: HIDDEN_SENSITIVE_RESULT }] };
		}
		const { content, changed } = redactToolContent(event.content);
		if (!changed) return undefined;
		return { content, isError: true };
	});
	on("user_bash", async (event) => guardShellCommand(pi, pathSafety, event.cwd, event.command, true));
	pi.on("agent_end", async (_event, ctx) => {
		const currentState = await getGitFinalizationState(pi, ctx.cwd);
		if (!currentState) return;
		const modifiedThisPrompt = sawPotentialMutation || gitFinalizationStateChanged(initialGitState, currentState);
		if (!modifiedThisPrompt || !needsGitFinalization(currentState, initialGitState)) return;
		if (currentPromptIsGuardBounce) {
			if (ctx.hasUI) ctx.ui.notify(`Git finalization still incomplete: ${summarizeGitFinalizationState(currentState)}`, "warning");
			return;
		}
		const message = `${GIT_FINALIZATION_MARKER}: Git finalization is incomplete (${summarizeGitFinalizationState(currentState)}). Continue: run the relevant validation, commit, and push before giving the final summary. If finalization is blocked, report the exact blocker and leave the repo state explicit.`;
		pi.sendUserMessage(message, { deliverAs: "followUp", triggerTurn: true } as any);
	});
}
