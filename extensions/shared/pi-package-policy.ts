import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentsScriptPath } from "./config";
import { parseJson } from "./json";

const PI_PACKAGE_POLICY_API_VERSION = 1;

type PiPackagePolicyPackage = {
	source_type?: string;
	display_source?: string;
	approved?: boolean;
	pinned?: boolean;
	reason?: string;
};

type PiPackagePolicyPayload = {
	pi_package_policy_api_version?: number;
	approval_manifest?: string;
	settings_path?: string;
	summary?: {
		configured_packages?: number;
		approved_packages?: number;
		unapproved_packages?: number;
		unpinned_packages?: number;
		unknown_package_entries?: number;
		approved_manifest_entries?: number;
		attestation?: { verified?: number; mismatch?: number; missing?: number; skipped?: number; unapproved?: number; cache_hit?: number; cache_miss?: number; cache_disabled?: number };
	};
	packages?: PiPackagePolicyPackage[];
};

export type PiPackagePolicyResult = { ok: true; payload: PiPackagePolicyPayload } | { ok: false; reason: string };

function displayPath(path: string | undefined): string {
	if (!path) return "unknown";
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export async function buildPiPackagePolicy(pi: ExtensionAPI, ctx: ExtensionContext): Promise<PiPackagePolicyResult> {
	try {
		const result = await pi.exec("bash", [agentsScriptPath("pi-package-doctor.sh")], { cwd: ctx.cwd, timeout: 5_000 });
		if (result.code !== 0) return { ok: false, reason: "script_error" };
		const payload = parseJson<PiPackagePolicyPayload>(result.stdout);
		if (payload?.pi_package_policy_api_version !== PI_PACKAGE_POLICY_API_VERSION) return { ok: false, reason: "unsupported API version" };
		return { ok: true, payload };
	} catch {
		return { ok: false, reason: "exception" };
	}
}

function sourceTypeCounts(packages: PiPackagePolicyPackage[]): string {
	const counts = new Map<string, number>();
	for (const pkg of packages) counts.set(pkg.source_type || "unknown", (counts.get(pkg.source_type || "unknown") ?? 0) + 1);
	return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([type, count]) => `${count} ${type}`).join(", ") || "none";
}

export function piPackagePolicyHealth(result: PiPackagePolicyResult): "ok" | "warning" {
	if (!result.ok) return "warning";
	const summary = result.payload.summary;
	const attestation = summary?.attestation;
	return (summary?.unapproved_packages ?? 0) || (summary?.unpinned_packages ?? 0) || (summary?.unknown_package_entries ?? 0) || (attestation?.mismatch ?? 0) || (attestation?.missing ?? 0) ? "warning" : "ok";
}

export function formatPiPackagePolicyLines(result: PiPackagePolicyResult): string[] {
	if (!result.ok) return [`- package policy: unavailable (${result.reason})`];
	const payload = result.payload;
	const summary = payload.summary ?? {};
	const packages = payload.packages ?? [];
	const unapproved = packages.filter((pkg) => !pkg.approved);
	const attestation = summary.attestation ?? {};
	return [
		`- package policy: ok (v${payload.pi_package_policy_api_version ?? "?"})`,
		`- approval manifest: ${displayPath(payload.approval_manifest)} (${summary.approved_manifest_entries ?? 0} approved entries)`,
		`- configured packages: ${summary.configured_packages ?? 0}; ${summary.approved_packages ?? 0} approved, ${summary.unapproved_packages ?? 0} unapproved, ${summary.unpinned_packages ?? 0} unpinned`,
		`- installed attestation: ${attestation.verified ?? 0} verified, ${attestation.mismatch ?? 0} mismatch, ${attestation.missing ?? 0} missing, ${attestation.skipped ?? 0} skipped; cache ${attestation.cache_hit ?? 0} hit, ${attestation.cache_miss ?? 0} miss, ${attestation.cache_disabled ?? 0} disabled`,
		`- package source types: ${sourceTypeCounts(packages)}`,
		...(unapproved.length
			? [`- unapproved package samples: ${unapproved.slice(0, 5).map((pkg) => `${pkg.display_source || "unknown"} (${pkg.reason || "unapproved"})`).join("; ")}`]
			: ["- unapproved package samples: none"]),
		"- upstream checks: disabled in harness; use explicit `.agents` quarantine scan and promotion scripts",
	];
}
