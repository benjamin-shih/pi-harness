import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsRoot, agentsScriptPath } from "../shared/config";
import { parseJson } from "../shared/json";
import { cleanPathToken } from "./shell";

const POLICY_API_VERSION = 1;

export type PolicyOperation = "read" | "write" | "list" | "egress" | "capture" | "git";

export type PathSafetyResult = {
	policy_api_version?: number;
	action?: "allow" | "warn" | "block";
	allowed?: boolean;
	matched?: boolean;
	recursive?: boolean;
	reason?: string;
	rule_path?: string;
	normalized_path?: string;
};

export type PathSafetyCheck = (rawPath: string | undefined, cwd: string, operation?: PolicyOperation, recursive?: boolean) => Promise<PathSafetyResult | undefined>;

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

export function createPathSafetyChecker(pi: ExtensionAPI): { pathSafety: PathSafetyCheck; clearPathSafetyCache: () => void } {
	const cache = new Map<string, PathSafetyResult | null>();

	async function pathSafety(rawPath: string | undefined, cwd: string, operation: PolicyOperation = "read", recursive = false): Promise<PathSafetyResult | undefined> {
		const pathToken = rawPath ? cleanPathToken(rawPath) : "";
		if (!pathToken) return undefined;
		const root = agentsRoot();
		const cacheKey = `${root}\0${cwd}\0${operation}\0${recursive ? "recursive" : "direct"}\0${pathToken}`;
		if (cache.has(cacheKey)) return cache.get(cacheKey) ?? undefined;
		try {
			const args = [agentsScriptPath("path-safety.sh"), "--path", pathToken, "--cwd", cwd, "--operation", operation];
			if (recursive) args.push("--recursive");
			const result = await pi.exec("bash", args, { cwd, timeout: 5_000 });
			if (result.code !== 0) {
				const unavailable = policyUnavailable(pathToken, `exit ${result.code}`);
				cache.set(cacheKey, unavailable);
				return unavailable;
			}
			const payload = parseJson<PathSafetyResult>(result.stdout);
			if (!payload || payload.policy_api_version !== POLICY_API_VERSION) {
				const unavailable = policyUnavailable(pathToken, `unsupported API version ${payload?.policy_api_version ?? "missing"}`);
				cache.set(cacheKey, unavailable);
				return unavailable;
			}
			const value = payload.action === "allow" ? null : payload;
			cache.set(cacheKey, value);
			return value ?? undefined;
		} catch (error) {
			const unavailable = policyUnavailable(pathToken, error instanceof Error ? error.message : String(error));
			cache.set(cacheKey, unavailable);
			return unavailable;
		}
	}

	return { pathSafety, clearPathSafetyCache: () => cache.clear() };
}
