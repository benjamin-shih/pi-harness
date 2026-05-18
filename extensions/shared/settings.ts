import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";

export type JsonObject = Record<string, unknown>;

export function readJsonObject(path: string): JsonObject {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
	} catch {
		return {};
	}
}

export function mergeSettings(base: JsonObject, override: JsonObject): JsonObject {
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

export function nearestProjectSettings(cwd: string): JsonObject {
	let current = cwd;
	const root = parse(cwd).root;
	while (true) {
		const settings = join(current, ".pi", "settings.json");
		if (existsSync(settings)) return readJsonObject(settings);
		if (current === root) return {};
		current = dirname(current);
	}
}

export function mergedPiSettings(cwd: string): JsonObject {
	return mergeSettings(readJsonObject(join(homedir(), ".pi", "agent", "settings.json")), nearestProjectSettings(cwd));
}

export function harnessSettings(settings: JsonObject): JsonObject {
	const harness = settings.harness;
	return harness && typeof harness === "object" && !Array.isArray(harness) ? harness as JsonObject : {};
}
