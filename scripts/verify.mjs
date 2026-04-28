import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Module from "node:module";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);

function fail(message) {
	console.error(`verify failed: ${message}`);
	process.exitCode = 1;
}

function readJson(relativePath) {
	const fullPath = join(root, relativePath);
	try {
		return JSON.parse(readFileSync(fullPath, "utf8"));
	} catch (error) {
		fail(`${relativePath} is not valid JSON: ${error.message}`);
		return undefined;
	}
}

const packageJson = readJson("package.json");
if (packageJson) {
	for (const key of ["extensions", "prompts", "themes"]) {
		const entries = packageJson.pi?.[key];
		if (!Array.isArray(entries) || entries.length === 0) fail(`package.json pi.${key} must be a non-empty array`);
		for (const entry of entries ?? []) {
			const resolved = join(root, entry);
			if (!existsSync(resolved)) fail(`package.json pi.${key} path does not exist: ${entry}`);
		}
	}
}

for (const theme of readdirSync(join(root, "themes")).filter((file) => file.endsWith(".json"))) {
	const data = readJson(join("themes", theme));
	if (!data?.name) fail(`${theme} is missing a theme name`);
	if (!data?.colors || typeof data.colors !== "object") fail(`${theme} is missing colors`);
}

for (const prompt of readdirSync(join(root, "prompts")).filter((file) => file.endsWith(".md"))) {
	const text = readFileSync(join(root, "prompts", prompt), "utf8");
	if (!text.startsWith("---\n")) fail(`${prompt} is missing frontmatter`);
	if (!/^description:\s*.+$/m.test(text)) fail(`${prompt} is missing a description`);
}

// Pi packages should list pi core packages as peerDependencies, not runtime dependencies.
for (const dep of ["@mariozechner/pi-ai", "@mariozechner/pi-coding-agent", "@mariozechner/pi-tui"]) {
	if (!packageJson?.peerDependencies?.[dep]) fail(`missing peerDependency ${dep}`);
	if (packageJson?.dependencies?.[dep]) fail(`${dep} should not be bundled in dependencies`);
}

// The extension TypeScript files import pi packages that are provided by pi at runtime.
// In CI we add pi-coding-agent's nested node_modules to NODE_PATH before loading via jiti.
const piRoot = join(root, "node_modules", "@mariozechner", "pi-coding-agent");
if (!existsSync(join(piRoot, "package.json"))) {
	fail("@mariozechner/pi-coding-agent is not installed; run npm install or npm ci");
}
const piNodeModules = join(piRoot, "node_modules");
process.env.NODE_PATH = [piNodeModules, process.env.NODE_PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
Module.Module._initPaths();

const { createJiti } = require("@mariozechner/jiti");
for (const extension of readdirSync(join(root, "extensions")).filter((file) => /\.[cm]?[jt]s$/.test(file))) {
	const fullPath = join(root, "extensions", extension);
	try {
		const jiti = createJiti(fullPath, { interopDefault: true, moduleCache: false });
		const loaded = jiti(fullPath);
		const factory = loaded.default ?? loaded;
		if (typeof factory !== "function") fail(`${extension} does not export a default function`);
	} catch (error) {
		fail(`${extension} failed to load: ${error.stack ?? error.message}`);
	}
}

if (process.exitCode) process.exit(process.exitCode);
console.log("verify ok");
