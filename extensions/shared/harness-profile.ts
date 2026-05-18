import { harnessSettings, mergedPiSettings, type JsonObject } from "./settings";

export type HarnessProfile = "lean" | "full";

export type HarnessRuntimeConfig = {
	profile: HarnessProfile;
	ambientOrchestration: boolean;
};

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
	const settings = mergedPiSettings(cwd);
	const harness = harnessSettings(settings);
	const profile = parseProfile(process.env.BEN_PI_HARNESS_PROFILE) ?? parseProfile(harness.profile) ?? parseProfile(settings.harnessProfile) ?? "lean";
	const fullDefault = profile === "full";
	return {
		profile,
		ambientOrchestration: configuredBool(settings, "BEN_PI_AMBIENT_ORCHESTRATION", ["ambientOrchestration", "enableAmbientOrchestration"], fullDefault),
	};
}
