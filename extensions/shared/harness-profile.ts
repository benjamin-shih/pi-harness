import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";

type JsonObject = Record<string, unknown>;
export type HarnessProfile = "lean" | "full";

export type HarnessRuntimeConfig = {
	profile: HarnessProfile;
	asyncInbox: boolean;
	controlPlaneSurfaces: boolean;
	ambientOrchestration: boolean;
};

function readJson(path: string): JsonObject {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
	} catch {
		return {};
	}
}

function mergeSettings(base: JsonObject, override: JsonObject): JsonObject {
	const result: JsonObject = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
			result[key] = mergeSettings(result[key] as JsonObject, value as JsonObject);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function nearestProjectSettings(cwd: string): JsonObject {
	let current = cwd;
	const root = parse(cwd).root;
	while (true) {
		const settings = join(current, ".pi", "settings.json");
		if (existsSync(settings)) return readJson(settings);
		if (current === root) return {};
		current = dirname(current);
	}
}

function mergedSettings(cwd: string): JsonObject {
	return mergeSettings(readJson(join(homedir(), ".pi", "agent", "settings.json")), nearestProjectSettings(cwd));
}

function harnessSettings(settings: JsonObject): JsonObject {
	const harness = settings.harness;
	return harness && typeof harness === "object" && !Array.isArray(harness) ? harness as JsonObject : {};
}

function parseProfile(value: unknown): HarnessProfile | undefined {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	return text === "full" || text === "lean" ? text : undefined;
}

function parseBool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const text = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enabled"].includes(text)) return true;
	if (["0", "false", "no", "off", "disabled"].includes(text)) return false;
	return undefined;
}

function settingBool(settings: JsonObject, keys: string[]): boolean | undefined {
	const harness = harnessSettings(settings);
	for (const key of keys) {
		const fromHarness = parseBool(harness[key]);
		if (fromHarness !== undefined) return fromHarness;
		const fromTopLevel = parseBool(settings[key]);
		if (fromTopLevel !== undefined) return fromTopLevel;
	}
	return undefined;
}

function envBool(name: string): boolean | undefined {
	return parseBool(process.env[name]);
}

function configuredBool(settings: JsonObject, envName: string, keys: string[], fallback: boolean): boolean {
	return envBool(envName) ?? settingBool(settings, keys) ?? fallback;
}

export function harnessRuntimeConfig(cwd = process.cwd()): HarnessRuntimeConfig {
	const settings = mergedSettings(cwd);
	const harness = harnessSettings(settings);
	const profile = parseProfile(process.env.BEN_PI_HARNESS_PROFILE) ?? parseProfile(harness.profile) ?? parseProfile(settings.harnessProfile) ?? "lean";
	const fullDefault = profile === "full";
	return {
		profile,
		asyncInbox: configuredBool(settings, "BEN_PI_ASYNC_INBOX", ["asyncInbox", "enableInbox"], fullDefault),
		controlPlaneSurfaces: configuredBool(settings, "BEN_PI_CONTROL_PLANE_SURFACES", ["controlPlaneSurfaces", "enableControlPlaneSurfaces"], fullDefault),
		ambientOrchestration: configuredBool(settings, "BEN_PI_AMBIENT_ORCHESTRATION", ["ambientOrchestration", "enableAmbientOrchestration"], fullDefault),
	};
}
