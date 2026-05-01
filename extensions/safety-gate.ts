import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createPathSafetyChecker, type PathSafetyCheck, type PolicyOperation } from "./safety-gate-lib/policy";
import { extractCopyMoveSourcePathTokens, extractInputPathTokens, extractOutputPathTokens, extractPathTokens, extractWritePathTokens, looksMutatingBash, looksRecursiveTraversalCommand, parseGitCommands } from "./safety-gate-lib/shell";

const BLOCKED_OUTPUT =
	"[safety-gate] Blocked output because it appears to contain credential material or a protected private file.";
const BLOCKED_GIT =
	"[safety-gate] Blocked git operation because it may stage, commit, or push credential-bearing private files.";
const HIDDEN_SENSITIVE_RESULT =
	"[safety-gate] Sensitive operation completed, but output was hidden to avoid exposing credential material.";
const GIT_FINALIZATION_MARKER = "PI_GIT_FINALIZATION_GUARD";

const OUTPUT_COMMAND_RE = /\b(?:cat|bat|less|more|head|tail|sort|uniq|cut|wc|diff|comm|sed|awk|grep|egrep|fgrep|rg|ripgrep|strings|xxd|hexdump|base64|openssl|jq|python3?|node|ruby|perl)\b/i;
const UPLOAD_COMMAND_RE = /\b(?:curl|wget|scp|sftp|rsync|rclone|aws\s+s3\s+cp|aws\s+s3\s+sync|gh\s+release\s+upload)\b/i;

type GitFinalizationState = {
	root: string;
	statusText: string;
	dirtyLines: string[];
	head: string;
	hasUpstream: boolean;
	behind: number;
	ahead: number;
};

const DEFINITE_SECRET_PATTERNS = [
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{24,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];
const GENERIC_SECRET_ASSIGNMENT_RE =
	/\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|private[_-]?key|credential)\b\s*[:=]\s*["']?([^"'`\s]{12,})/gi;

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

function looksLikeRealSecretValue(value: string): boolean {
	const lower = value.toLowerCase();
	if (["example", "placeholder", "changeme", "dummy", "redacted", "undefined", "null"].some((word) => lower.includes(word))) {
		return false;
	}
	if (/[\\()[\]{}|]/.test(value)) return false;
	return /[a-z]/i.test(value) && /[0-9]/.test(value);
}

function containsCredentialMaterial(text: string): boolean {
	if (DEFINITE_SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
	GENERIC_SECRET_ASSIGNMENT_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = GENERIC_SECRET_ASSIGNMENT_RE.exec(text))) {
		if (looksLikeRealSecretValue(match[1] ?? "")) return true;
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

function isBroadGitAdd(args: string[]): boolean {
	return args.length === 0 || args.some((arg) => arg === "-A" || arg === "--all" || arg === "-u" || arg === "--update" || arg === "." || arg === ":/" || arg === ":" || arg === "*");
}

function isCommitAll(args: string[]): boolean {
	return args.some((arg) => arg === "--all" || arg === "-a" || /^-[^-].*a/.test(arg));
}

async function gitBlockReason(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string, command: string): Promise<string | undefined> {
	const gitCommands = parseGitCommands(command);
	for (const git of gitCommands) {
		const effectiveCwd = gitEffectiveCwd(cwd, git.cwd);
		const writesToIndex = git.subcommand === "add" || git.subcommand === "commit";
		if (writesToIndex && await commandMentionsSensitivePath(pathSafety, command, effectiveCwd, "git")) return BLOCKED_GIT;

		if (git.subcommand === "add") {
			if (isBroadGitAdd(git.args) && unsafeIfUnknown(await changedGitPathStatus(pi, pathSafety, effectiveCwd))) return BLOCKED_GIT;
		}

		if (git.subcommand === "commit") {
			if (unsafeIfUnknown(await stagedGitPathStatus(pi, pathSafety, effectiveCwd))) return BLOCKED_GIT;
			if (isCommitAll(git.args) && unsafeIfUnknown(await changedGitPathStatus(pi, pathSafety, effectiveCwd))) return BLOCKED_GIT;
		}

		if (git.subcommand === "push" && unsafeIfUnknown(await outgoingGitPathStatus(pi, pathSafety, effectiveCwd))) return BLOCKED_GIT;
	}
	return undefined;
}

function parseAheadBehind(stdout: string): { behind: number; ahead: number } {
	const [behindText, aheadText] = stdout.trim().split(/\s+/);
	return {
		behind: Number.parseInt(behindText ?? "0", 10) || 0,
		ahead: Number.parseInt(aheadText ?? "0", 10) || 0,
	};
}

async function getGitFinalizationState(pi: ExtensionAPI, cwd: string): Promise<GitFinalizationState | undefined> {
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 });
	if (root.code !== 0) return undefined;

	const status = await pi.exec("git", ["status", "--porcelain=v1", "--branch"], { cwd, timeout: 5_000 });
	if (status.code !== 0) return undefined;

	const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 });
	if (head.code !== 0) return undefined;

	const lines = status.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
	const dirtyLines = lines.filter((line) => !line.startsWith("##"));
	const upstreamCount = await pi.exec("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"], { cwd, timeout: 5_000 });
	const counts = upstreamCount.code === 0 ? parseAheadBehind(upstreamCount.stdout) : { behind: 0, ahead: 0 };

	return {
		root: root.stdout.trim(),
		statusText: status.stdout.trimEnd(),
		dirtyLines,
		head: head.stdout.trim(),
		hasUpstream: upstreamCount.code === 0,
		behind: counts.behind,
		ahead: counts.ahead,
	};
}

function gitFinalizationStateChanged(before: GitFinalizationState | undefined, after: GitFinalizationState): boolean {
	if (!before) return true;
	return (
		before.root !== after.root ||
		before.statusText !== after.statusText ||
		before.head !== after.head ||
		before.hasUpstream !== after.hasUpstream ||
		before.behind !== after.behind ||
		before.ahead !== after.ahead
	);
}

function needsGitFinalization(state: GitFinalizationState, before: GitFinalizationState | undefined): boolean {
	if (state.dirtyLines.length > 0) return true;
	if (state.ahead > 0) return true;
	if (!state.hasUpstream && before && state.head !== before.head) return true;
	return false;
}

function summarizeGitFinalizationState(state: GitFinalizationState): string {
	const parts: string[] = [];
	if (state.dirtyLines.length > 0) parts.push(`${state.dirtyLines.length} dirty/untracked file(s)`);
	if (state.ahead > 0) parts.push(`${state.ahead} unpushed commit(s)`);
	if (!state.hasUpstream) parts.push("no upstream configured");
	return parts.join(", ") || "git finalization incomplete";
}

function blockedTool(reason: string) {
	return { block: true, reason };
}

function blockedUserBash(reason: string) {
	return { result: { output: reason, exitCode: 1, cancelled: false, truncated: false } };
}

async function contentMentionsSensitivePath(pathSafety: PathSafetyCheck, content: unknown, cwd: string): Promise<boolean> {
	if (!Array.isArray(content)) return false;
	for (const part of content) {
		const text = part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined;
		if (typeof text !== "string") continue;
		for (const token of extractPathTokens(text)) {
			if (await pathSafety(token, cwd, "egress")) return true;
		}
	}
	return false;
}

function redactToolContent(content: unknown): { content: unknown; changed: boolean } {
	if (!Array.isArray(content)) return { content, changed: false };

	let changed = false;
	const next = content.map((part) => {
		if (!part || typeof part !== "object") return part;
		const maybeText = part as { type?: string; text?: unknown };
		if (maybeText.type !== "text" || typeof maybeText.text !== "string") return part;
		if (!containsCredentialMaterial(maybeText.text)) return part;
		changed = true;
		return { ...maybeText, text: BLOCKED_OUTPUT };
	});

	return { content: next, changed };
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
		const resultContentCwd = scansListingContent && typeof input?.path === "string" ? resolve(ctx.cwd, input.path) : ctx.cwd;
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
