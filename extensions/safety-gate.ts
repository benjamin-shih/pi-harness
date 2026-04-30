import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createPathSafetyChecker, type PathSafetyCheck, type PolicyOperation } from "./safety-gate-lib/policy";
import { extractPathTokens, extractWritePathTokens, looksMutatingBash, looksRecursiveTraversalCommand } from "./safety-gate-lib/shell";

const BLOCKED_OUTPUT =
	"[safety-gate] Blocked output because it appears to contain credential material or a protected private file.";
const BLOCKED_GIT =
	"[safety-gate] Blocked git operation because it may stage, commit, or push credential-bearing private files.";
const HIDDEN_SENSITIVE_RESULT =
	"[safety-gate] Sensitive operation completed, but output was hidden to avoid exposing credential material.";
const GIT_FINALIZATION_MARKER = "PI_GIT_FINALIZATION_GUARD";

const OUTPUT_COMMAND_RE = /\b(?:cat|bat|less|more|head|tail|sed|awk|grep|egrep|fgrep|rg|ripgrep|strings|xxd|hexdump|base64|openssl|jq|python3?|node|ruby|perl)\b/i;
const UPLOAD_COMMAND_RE = /\b(?:curl|wget|scp|sftp|rsync|rclone|aws\s+s3\s+cp|aws\s+s3\s+sync|gh\s+release\s+upload)\b/i;

const GIT_ADD_RE = /\bgit\b[\s\S]*?\badd\b/i;
const GIT_COMMIT_RE = /\bgit\b[\s\S]*?\bcommit\b/i;
const GIT_PUSH_RE = /\bgit\b[\s\S]*?\bpush\b/i;
const BROAD_GIT_ADD_RE = /\bgit\b[\s\S]*?\badd\b[\s\S]*(?:\s(?:-A|--all|-u|--update|\.|:\/?|\*)\b|$)/i;
const COMMIT_ALL_RE = /\bgit\b[\s\S]*?\bcommit\b[\s\S]*(?:\s-a\b|\s--all\b)/i;

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

async function gitLines(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string[]> {
	try {
		const result = await pi.exec("git", args, { cwd, timeout: 5_000 });
		if (result.code !== 0) return [];
		return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

async function sensitivePaths(pathSafety: PathSafetyCheck, cwd: string, paths: string[], operation: "git" | "egress" = "git"): Promise<string[]> {
	const matches: string[] = [];
	for (const p of paths) {
		if (await pathSafety(p, cwd, operation)) matches.push(p);
	}
	return matches;
}

async function changedSensitivePaths(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string): Promise<string[]> {
	try {
		const result = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
			cwd,
			timeout: 5_000,
		});
		if (result.code !== 0) return [];
		return sensitivePaths(pathSafety, cwd, parsePorcelainPaths(result.stdout), "git");
	} catch {
		return [];
	}
}

async function stagedSensitivePaths(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string): Promise<string[]> {
	const paths = await gitLines(pi, cwd, ["diff", "--cached", "--name-only"]);
	return sensitivePaths(pathSafety, cwd, paths, "git");
}

async function outgoingSensitivePaths(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string): Promise<string[]> {
	try {
		const upstream = await pi.exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
			cwd,
			timeout: 5_000,
		});
		if (upstream.code === 0) {
			const base = upstream.stdout.trim();
			const paths = await gitLines(pi, cwd, ["diff", "--name-only", `${base}..HEAD`]);
			return sensitivePaths(pathSafety, cwd, paths, "git");
		}
	} catch {
		// Fall back below.
	}

	return ["no upstream configured; refusing to infer outgoing sensitive paths from full repository contents"];
}

async function gitBlockReason(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string, command: string): Promise<string | undefined> {
	if (GIT_ADD_RE.test(command)) {
		if (await commandMentionsSensitivePath(pathSafety, command, cwd, "git")) return BLOCKED_GIT;
		if (BROAD_GIT_ADD_RE.test(command) && (await changedSensitivePaths(pi, pathSafety, cwd)).length > 0) return BLOCKED_GIT;
	}

	if (GIT_COMMIT_RE.test(command)) {
		if ((await stagedSensitivePaths(pi, pathSafety, cwd)).length > 0) return BLOCKED_GIT;
		if (COMMIT_ALL_RE.test(command) && (await changedSensitivePaths(pi, pathSafety, cwd)).length > 0) return BLOCKED_GIT;
	}

	if (GIT_PUSH_RE.test(command) && (await outgoingSensitivePaths(pi, pathSafety, cwd)).length > 0) return BLOCKED_GIT;
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

async function guardShellCommand(pi: ExtensionAPI, pathSafety: PathSafetyCheck, cwd: string, command: string, forUserBash = false) {
	const gitReason = await gitBlockReason(pi, pathSafety, cwd, command);
	if (gitReason) return forUserBash ? blockedUserBash(gitReason) : blockedTool(gitReason);

	const mutating = looksMutatingBash(command);
	if (mutating && (
		(await pathSafety(".", cwd, "write"))?.action === "block" ||
		await commandMentionsBlockedWritePath(pathSafety, command, cwd)
	)) {
		return forUserBash ? blockedUserBash(BLOCKED_OUTPUT) : blockedTool(BLOCKED_OUTPUT);
	}

	const outputOrUpload = OUTPUT_COMMAND_RE.test(command) || UPLOAD_COMMAND_RE.test(command);
	if (outputOrUpload && await commandMentionsSensitivePath(pathSafety, command, cwd, "egress")) {
		return forUserBash ? blockedUserBash(BLOCKED_OUTPUT) : blockedTool(BLOCKED_OUTPUT);
	}

	if (looksRecursiveTraversalCommand(command) && (
		await pathSafety(".", cwd, "list", true) ||
		await commandMentionsSensitivePath(pathSafety, command, cwd, "list", true)
	)) {
		return forUserBash ? blockedUserBash(BLOCKED_OUTPUT) : blockedTool(BLOCKED_OUTPUT);
	}

	return undefined;
}

export default function safetyGate(pi: ExtensionAPI) {
	const { pathSafety, clearPathSafetyCache } = createPathSafetyChecker(pi);
	let initialGitState: GitFinalizationState | undefined;
	let sawPotentialMutation = false;
	let currentPromptIsGuardBounce = false;

	pi.on("before_agent_start", async (event, ctx) => {
		clearPathSafetyCache();
		initialGitState = await getGitFinalizationState(pi, ctx.cwd);
		sawPotentialMutation = false;
		currentPromptIsGuardBounce = event.prompt.includes(GIT_FINALIZATION_MARKER);
	});

	pi.on("tool_call", async (event, ctx) => {
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

		if (event.toolName === "bash") {
			const command = String(input.command ?? "");
			if (looksMutatingBash(command)) sawPotentialMutation = true;
			return guardShellCommand(pi, pathSafety, ctx.cwd, command, false);
		}

		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const input = event.input as Record<string, unknown> | undefined;
		if (
			(event.toolName === "write" || event.toolName === "edit" || event.toolName === "read" || event.toolName === "grep") &&
			(await pathSafety(input?.path as string | undefined, ctx.cwd, "egress") ||
				await pathSafety(input?.glob as string | undefined, ctx.cwd, "egress"))
		) {
			return { content: [{ type: "text", text: HIDDEN_SENSITIVE_RESULT }] };
		}

		const { content, changed } = redactToolContent(event.content);
		if (!changed) return undefined;
		return { content, isError: true };
	});

	pi.on("user_bash", async (event) => guardShellCommand(pi, pathSafety, event.cwd, event.command, true));

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
		pi.sendUserMessage(message, { deliverAs: "followUp", triggerTurn: true });
	});
}
