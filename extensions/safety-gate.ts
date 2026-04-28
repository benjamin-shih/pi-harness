import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

const BLOCKED_OUTPUT =
	"[safety-gate] Blocked output because it appears to contain credential material or a protected private file.";
const BLOCKED_GIT =
	"[safety-gate] Blocked git operation because it may stage, commit, or push credential-bearing private files.";
const HIDDEN_SENSITIVE_RESULT =
	"[safety-gate] Sensitive operation completed, but output was hidden to avoid exposing credential material.";

const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg"]);
const SENSITIVE_FILE_RE = /^(?:\.npmrc|\.pypirc|\.netrc|auth\.json|id_(?:rsa|ed25519|ecdsa|dsa)|(?:credentials|secrets?|tokens?|private-key|service-account)(?:\.(?:json|ya?ml|toml|ini|env|txt))?|.*\.(?:pem|key|p12|pfx))$/i;

const OUTPUT_COMMAND_RE = /\b(?:cat|bat|less|more|head|tail|sed|awk|grep|egrep|fgrep|rg|ripgrep|strings|xxd|hexdump|base64|openssl|jq|python3?|node|ruby|perl)\b/i;
const UPLOAD_COMMAND_RE = /\b(?:curl|wget|scp|sftp|rsync|rclone|aws\s+s3\s+cp|aws\s+s3\s+sync|gh\s+release\s+upload)\b/i;

const GIT_ADD_RE = /\bgit\b[\s\S]*?\badd\b/i;
const GIT_COMMIT_RE = /\bgit\b[\s\S]*?\bcommit\b/i;
const GIT_PUSH_RE = /\bgit\b[\s\S]*?\bpush\b/i;
const BROAD_GIT_ADD_RE = /\bgit\b[\s\S]*?\badd\b[\s\S]*(?:\s(?:-A|--all|-u|--update|\.|:\/?|\*)\b|$)/i;
const COMMIT_ALL_RE = /\bgit\b[\s\S]*?\bcommit\b[\s\S]*(?:\s-a\b|\s--all\b)/i;

const DEFINITE_SECRET_PATTERNS = [
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{24,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];
const GENERIC_SECRET_ASSIGNMENT_RE =
	/\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|private[_-]?key|credential)\b\s*[:=]\s*["']?([^"'`\s]{12,})/gi;

function isSamplePath(rawPath: string): boolean {
	const lower = rawPath.toLowerCase();
	return /(?:^|[./_-])(?:example|sample|template|stub|dummy)(?:$|[./_-])/.test(lower) || lower.endsWith(".dist");
}

function normalizePath(rawPath: string, cwd: string): string {
	let p = rawPath.trim().replace(/^@/, "").replace(/^['\"]|['\"]$/g, "");
	if (p === "~") p = HOME;
	else if (p.startsWith("~/")) p = path.join(HOME, p.slice(2));
	else if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
	return path.normalize(p);
}

function sensitiveReason(rawPath: string | undefined, cwd: string): string | undefined {
	if (!rawPath || isSamplePath(rawPath)) return undefined;

	const normalized = normalizePath(rawPath, cwd);
	const lower = normalized.toLowerCase();
	const parts = lower.split(path.sep).filter(Boolean);
	const base = parts.at(-1) ?? "";

	if (parts.some((part) => SENSITIVE_DIRS.has(part))) return "protected private directory";
	if (parts.includes(".kube") && base === "config") return "kubernetes credential config";
	if (lower.includes(`${path.sep}.config${path.sep}gcloud${path.sep}`)) return "gcloud credential config";
	if (lower.endsWith(`${path.sep}.config${path.sep}gh${path.sep}hosts.yml`)) return "GitHub CLI credential config";
	if (lower.endsWith(`${path.sep}.docker${path.sep}config.json`)) return "docker credential config";
	if (base === ".env" || base.startsWith(".env.")) return "environment secret file";
	if (/[*?\[]/.test(base) && base.startsWith(".env")) return "environment secret glob";
	if (SENSITIVE_FILE_RE.test(base)) return "credential-bearing filename";
	return undefined;
}

function extractPathTokens(command: string): string[] {
	const tokens: string[] = [];
	const re = /(?:^|[\s"'`=:(])(@?(?:~|\.{1,2}|\/)[^\s"'`;&|)]+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(command))) {
		const token = match[1]?.replace(/[,:]+$/g, "");
		if (token) tokens.push(token);
	}
	return tokens;
}

function commandMentionsSensitivePath(command: string, cwd: string): boolean {
	const withoutSamples = command.replace(/\.env\.(?:example|sample|template|stub|dummy|dist)\b/gi, "");
	if (/(^|[^\w.-])@?(?:\.\/)?\.env(?:$|[.*?\s\/"'`:;|&)])/i.test(withoutSamples)) return true;
	if (/(^|[^\w.-])@?(?:~\/|\$HOME\/)?\.ssh(?:$|[\/\s"'`:;|&)])/i.test(withoutSamples)) return true;
	if (/(^|[\s"'`])(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|\.npmrc|\.pypirc|\.netrc)(?:$|[\s"'`;|&)])/i.test(withoutSamples)) return true;
	return extractPathTokens(command).some((token) => sensitiveReason(token, cwd));
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

async function changedSensitivePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	try {
		const result = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
			cwd,
			timeout: 5_000,
		});
		if (result.code !== 0) return [];
		return parsePorcelainPaths(result.stdout).filter((p) => sensitiveReason(p, cwd));
	} catch {
		return [];
	}
}

async function stagedSensitivePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const paths = await gitLines(pi, cwd, ["diff", "--cached", "--name-only"]);
	return paths.filter((p) => sensitiveReason(p, cwd));
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
			return paths.filter((p) => sensitiveReason(p, cwd));
		}
	} catch {
		// Fall back below.
	}

	const tracked = await gitLines(pi, cwd, ["ls-files"]);
	return tracked.filter((p) => sensitiveReason(p, cwd));
}

async function gitBlockReason(pi: ExtensionAPI, cwd: string, command: string): Promise<string | undefined> {
	if (GIT_ADD_RE.test(command)) {
		if (commandMentionsSensitivePath(command, cwd)) return BLOCKED_GIT;
		if (BROAD_GIT_ADD_RE.test(command) && (await changedSensitivePaths(pi, cwd)).length > 0) return BLOCKED_GIT;
	}

	if (GIT_COMMIT_RE.test(command)) {
		if ((await stagedSensitivePaths(pi, cwd)).length > 0) return BLOCKED_GIT;
		if (COMMIT_ALL_RE.test(command) && (await changedSensitivePaths(pi, cwd)).length > 0) return BLOCKED_GIT;
	}

	if (GIT_PUSH_RE.test(command) && (await outgoingSensitivePaths(pi, cwd)).length > 0) return BLOCKED_GIT;
	return undefined;
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

	if (commandMentionsSensitivePath(command, cwd) && (OUTPUT_COMMAND_RE.test(command) || UPLOAD_COMMAND_RE.test(command))) {
		return forUserBash ? blockedUserBash(BLOCKED_OUTPUT) : blockedTool(BLOCKED_OUTPUT);
	}

	return undefined;
}

export default function safetyGate(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;

		if (event.toolName === "read") {
			if (sensitiveReason(input.path as string | undefined, ctx.cwd)) return blockedTool(BLOCKED_OUTPUT);
		}

		if (event.toolName === "grep") {
			if (
				sensitiveReason(input.path as string | undefined, ctx.cwd) ||
				sensitiveReason(input.glob as string | undefined, ctx.cwd)
			) {
				return blockedTool(BLOCKED_OUTPUT);
			}
		}

		if (event.toolName === "bash") {
			return guardShellCommand(pi, ctx.cwd, String(input.command ?? ""), false);
		}

		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const input = event.input as Record<string, unknown> | undefined;
		if (
			(event.toolName === "write" || event.toolName === "edit" || event.toolName === "read" || event.toolName === "grep") &&
			(sensitiveReason(input?.path as string | undefined, ctx.cwd) ||
				sensitiveReason(input?.glob as string | undefined, ctx.cwd))
		) {
			return { content: [{ type: "text", text: HIDDEN_SENSITIVE_RESULT }] };
		}

		const { content, changed } = redactToolContent(event.content);
		if (!changed) return undefined;
		return { content, isError: true };
	});

	pi.on("user_bash", async (event) => guardShellCommand(pi, event.cwd, event.command, true));
}
