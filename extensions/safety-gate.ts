import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";

const BLOCKED_OUTPUT =
	"[safety-gate] Blocked output because it appears to contain credential material or a protected private file.";
const BLOCKED_GIT =
	"[safety-gate] Blocked git operation because it may stage, commit, or push credential-bearing private files.";
const HIDDEN_SENSITIVE_RESULT =
	"[safety-gate] Sensitive operation completed, but output was hidden to avoid exposing credential material.";
const GIT_FINALIZATION_MARKER = "PI_GIT_FINALIZATION_GUARD";
const DEFAULT_AGENTS_ROOT = "/Users/benjaminshih/.agents";
const POLICY_API_VERSION = 1;
const pathSafetyCache = new Map<string, PathSafetyResult | null>();

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

type PathSafetyResult = {
	policy_api_version?: number;
	action?: "allow" | "warn" | "block";
	allowed?: boolean;
	matched?: boolean;
	reason?: string;
	rule_path?: string;
	normalized_path?: string;
};

const DEFINITE_SECRET_PATTERNS = [
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{24,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];
const GENERIC_SECRET_ASSIGNMENT_RE =
	/\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|private[_-]?key|credential)\b\s*[:=]\s*["']?([^"'`\s]{12,})/gi;

function agentsRoot(): string {
	return process.env.AGENTS_SHARED_ROOT || DEFAULT_AGENTS_ROOT;
}

function policyScriptPath(scriptName: string): string {
	return path.join(agentsRoot(), "scripts", scriptName);
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function cleanPathToken(rawPath: string): string {
	return rawPath.trim().replace(/^@/, "").replace(/^[\'"]|[\'"]$/g, "").replace(/[,:]+$/g, "");
}

function policyUnavailable(pathToken: string, reason: string): PathSafetyResult {
	return {
		action: "block",
		allowed: false,
		matched: false,
		reason: `policy unavailable: ${reason}`,
		rule_path: "",
		normalized_path: pathToken,
	};
}

async function pathSafety(pi: ExtensionAPI, rawPath: string | undefined, cwd: string, operation: "read" | "write" | "list" | "egress" | "capture" | "git" = "read"): Promise<PathSafetyResult | undefined> {
	const pathToken = rawPath ? cleanPathToken(rawPath) : "";
	if (!pathToken) return undefined;
	const cacheKey = `${agentsRoot()}\0${cwd}\0${operation}\0${pathToken}`;
	if (pathSafetyCache.has(cacheKey)) return pathSafetyCache.get(cacheKey) ?? undefined;
	try {
		const result = await pi.exec("bash", [policyScriptPath("path-safety.sh"), "--path", pathToken, "--cwd", cwd, "--operation", operation], { cwd, timeout: 5_000 });
		if (result.code !== 0) {
			const unavailable = policyUnavailable(pathToken, `exit ${result.code}`);
			pathSafetyCache.set(cacheKey, unavailable);
			return unavailable;
		}
		const payload = parseJson<PathSafetyResult>(result.stdout);
		if (!payload || payload.policy_api_version !== POLICY_API_VERSION) {
			const unavailable = policyUnavailable(pathToken, `unsupported API version ${payload?.policy_api_version ?? "missing"}`);
			pathSafetyCache.set(cacheKey, unavailable);
			return unavailable;
		}
		const value = payload.action === "allow" ? null : payload;
		pathSafetyCache.set(cacheKey, value);
		return value ?? undefined;
	} catch (error) {
		const unavailable = policyUnavailable(pathToken, error instanceof Error ? error.message : String(error));
		pathSafetyCache.set(cacheKey, unavailable);
		return unavailable;
	}
}

function extractPathTokens(command: string): string[] {
	const tokens = new Set<string>();
	const pathLike = /(?:^|[\s"'`=:(])(@?(?:~|\$HOME|\.{1,2}|\/)[^\s"'`;&|)]+)/g;
	let match: RegExpExecArray | null;
	while ((match = pathLike.exec(command))) {
		const token = cleanPathToken(match[1] ?? "");
		if (token) tokens.add(token);
	}

	for (const token of command.split(/\s+/)) {
		const cleaned = cleanPathToken(token);
		if (!cleaned || cleaned.startsWith("-") || /^[A-Z_]+=/.test(cleaned) || /^[a-z]+:\/\//i.test(cleaned)) continue;
		if (/^(?:cat|bat|less|more|head|tail|sed|awk|grep|egrep|fgrep|rg|ripgrep|strings|xxd|hexdump|base64|openssl|jq|python3?|node|ruby|perl|curl|wget|scp|sftp|rsync|rclone|git|aws|gh)$/.test(cleaned)) continue;
		if (/[/~.$]|(?:env|rsa|ed25519|ecdsa|dsa|npmrc|pypirc|netrc|credentials?|secrets?|tokens?|wallet|private-key|service-account|auth\.json|\.pem|\.key|\.p12|\.pfx)$/i.test(cleaned)) tokens.add(cleaned);
	}

	return [...tokens];
}

async function commandMentionsSensitivePath(pi: ExtensionAPI, command: string, cwd: string, operation: "egress" | "git" = "egress"): Promise<boolean> {
	for (const token of extractPathTokens(command)) {
		if (await pathSafety(pi, token, cwd, operation)) return true;
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

async function sensitivePaths(pi: ExtensionAPI, cwd: string, paths: string[], operation: "git" | "egress" = "git"): Promise<string[]> {
	const matches: string[] = [];
	for (const p of paths) {
		if (await pathSafety(pi, p, cwd, operation)) matches.push(p);
	}
	return matches;
}

async function changedSensitivePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	try {
		const result = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
			cwd,
			timeout: 5_000,
		});
		if (result.code !== 0) return [];
		return sensitivePaths(pi, cwd, parsePorcelainPaths(result.stdout), "git");
	} catch {
		return [];
	}
}

async function stagedSensitivePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const paths = await gitLines(pi, cwd, ["diff", "--cached", "--name-only"]);
	return sensitivePaths(pi, cwd, paths, "git");
}

async function outgoingSensitivePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	try {
		const upstream = await pi.exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
			cwd,
			timeout: 5_000,
		});
		if (upstream.code === 0) {
			const base = upstream.stdout.trim();
			const paths = await gitLines(pi, cwd, ["diff", "--name-only", `${base}..HEAD`]);
			return sensitivePaths(pi, cwd, paths, "git");
		}
	} catch {
		// Fall back below.
	}

	return ["no upstream configured; refusing to infer outgoing sensitive paths from full repository contents"];
}

async function gitBlockReason(pi: ExtensionAPI, cwd: string, command: string): Promise<string | undefined> {
	if (GIT_ADD_RE.test(command)) {
		if (await commandMentionsSensitivePath(pi, command, cwd, "git")) return BLOCKED_GIT;
		if (BROAD_GIT_ADD_RE.test(command) && (await changedSensitivePaths(pi, cwd)).length > 0) return BLOCKED_GIT;
	}

	if (GIT_COMMIT_RE.test(command)) {
		if ((await stagedSensitivePaths(pi, cwd)).length > 0) return BLOCKED_GIT;
		if (COMMIT_ALL_RE.test(command) && (await changedSensitivePaths(pi, cwd)).length > 0) return BLOCKED_GIT;
	}

	if (GIT_PUSH_RE.test(command) && (await outgoingSensitivePaths(pi, cwd)).length > 0) return BLOCKED_GIT;
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

function looksMutatingBash(command: string): boolean {
	return /(^|[;&|()\s])(?:rm|mv|cp|touch|mkdir|rmdir|tee|python|python3|node|npm|pnpm|yarn|make|lualatex|latexmk|git\s+(?:add|commit|push|reset|checkout|switch|merge|rebase|stash|clean))\b/.test(command)
		|| /(^|[^<])>{1,2}\s*[^&]/.test(command)
		|| /\b(?:sed|perl)\s+[^\n]*\s-i\b/.test(command);
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

async function guardShellCommand(pi: ExtensionAPI, cwd: string, command: string, forUserBash = false) {
	const gitReason = await gitBlockReason(pi, cwd, command);
	if (gitReason) return forUserBash ? blockedUserBash(gitReason) : blockedTool(gitReason);

	if ((OUTPUT_COMMAND_RE.test(command) || UPLOAD_COMMAND_RE.test(command)) && await commandMentionsSensitivePath(pi, command, cwd, "egress")) {
		return forUserBash ? blockedUserBash(BLOCKED_OUTPUT) : blockedTool(BLOCKED_OUTPUT);
	}

	return undefined;
}

export default function safetyGate(pi: ExtensionAPI) {
	let initialGitState: GitFinalizationState | undefined;
	let sawPotentialMutation = false;
	let currentPromptIsGuardBounce = false;

	pi.on("before_agent_start", async (event, ctx) => {
		pathSafetyCache.clear();
		initialGitState = await getGitFinalizationState(pi, ctx.cwd);
		sawPotentialMutation = false;
		currentPromptIsGuardBounce = event.prompt.includes(GIT_FINALIZATION_MARKER);
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;

		if (event.toolName === "edit" || event.toolName === "write") {
			sawPotentialMutation = true;
			const writeDecision = await pathSafety(pi, input.path as string | undefined, ctx.cwd, "write");
			if (writeDecision?.action === "block") return blockedTool(BLOCKED_OUTPUT);
		}

		if (event.toolName === "read") {
			if (await pathSafety(pi, input.path as string | undefined, ctx.cwd, "read")) return blockedTool(BLOCKED_OUTPUT);
		}

		if (event.toolName === "grep") {
			if (
				await pathSafety(pi, input.path as string | undefined, ctx.cwd, "list") ||
				await pathSafety(pi, input.glob as string | undefined, ctx.cwd, "list")
			) {
				return blockedTool(BLOCKED_OUTPUT);
			}
		}

		if (event.toolName === "bash") {
			const command = String(input.command ?? "");
			if (looksMutatingBash(command)) sawPotentialMutation = true;
			return guardShellCommand(pi, ctx.cwd, command, false);
		}

		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const input = event.input as Record<string, unknown> | undefined;
		if (
			(event.toolName === "write" || event.toolName === "edit" || event.toolName === "read" || event.toolName === "grep") &&
			(await pathSafety(pi, input?.path as string | undefined, ctx.cwd, "egress") ||
				await pathSafety(pi, input?.glob as string | undefined, ctx.cwd, "egress"))
		) {
			return { content: [{ type: "text", text: HIDDEN_SENSITIVE_RESULT }] };
		}

		const { content, changed } = redactToolContent(event.content);
		if (!changed) return undefined;
		return { content, isError: true };
	});

	pi.on("user_bash", async (event) => guardShellCommand(pi, event.cwd, event.command, true));

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
