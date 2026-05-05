import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";
import { extensionEntrypoints as scanExtensionEntrypoints } from "../lib/extension-entrypoints.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const requireFromVerify = createRequire(import.meta.url);

export function fail(message) {
	console.error(`verify failed: ${message}`);
	process.exitCode = 1;
}

export function assert(condition, message) {
	if (!condition) fail(message);
}

export function readJson(relativePath) {
	const fullPath = join(root, relativePath);
	try {
		return JSON.parse(readFileSync(fullPath, "utf8"));
	} catch (error) {
		fail(`${relativePath} is not valid JSON: ${error.message}`);
		return undefined;
	}
}

const piRoot = join(root, "node_modules", "@mariozechner", "pi-coding-agent");
assert(existsSync(join(piRoot, "package.json")), "@mariozechner/pi-coding-agent is not installed; run npm install or npm ci");
const piNodeModules = join(root, "node_modules");
process.env.NODE_PATH = [piNodeModules, process.env.NODE_PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
Module.Module._initPaths();

const { createJiti } = requireFromVerify("@mariozechner/jiti");
const jitiAlias = {
	"@mariozechner/pi-coding-agent": join(piRoot, "dist", "index.js"),
	"@mariozechner/pi-agent-core": join(piNodeModules, "@mariozechner", "pi-agent-core", "dist", "index.js"),
	"@mariozechner/pi-ai": join(piNodeModules, "@mariozechner", "pi-ai", "dist", "index.js"),
	"@mariozechner/pi-ai/oauth": join(piNodeModules, "@mariozechner", "pi-ai", "dist", "oauth.js"),
	"@mariozechner/pi-tui": join(piNodeModules, "@mariozechner", "pi-tui", "dist", "index.js"),
};

export function loadModuleAt(fullPath) {
	const jiti = createJiti(fullPath, { interopDefault: true, moduleCache: false, alias: jitiAlias });
	return jiti(fullPath);
}

export function loadExtensionModule(relativePath) {
	return loadModuleAt(join(root, relativePath));
}

export function loadExtension(relativePath) {
	const loaded = loadExtensionModule(relativePath);
	const factory = loaded.default ?? loaded;
	assert(typeof factory === "function", `${relativePath} does not export a default function`);
	return factory;
}

export async function withEnv(overrides, fn) {
	const previous = new Map();
	for (const key of Object.keys(overrides)) {
		previous.set(key, process.env[key]);
		const value = overrides[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

export function extensionEntrypoints() {
	return scanExtensionEntrypoints(root);
}
