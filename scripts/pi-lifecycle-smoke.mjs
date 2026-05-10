import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PI_OFFLINE = "1";

const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "ben-pi-harness-smoke-"));

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertExtension(extensions, relativePath, options = {}) {
	const extension = extensions.find((entry) => relative(root, entry.resolvedPath || entry.path).split("\\").join("/") === relativePath);
	assert(extension, `pi package smoke: missing extension ${relativePath}`);
	for (const command of options.commands ?? []) assert(extension.commands.has(command), `pi package smoke: ${relativePath} did not register /${command}`);
	for (const event of options.handlers ?? []) assert(extension.handlers.has(event), `pi package smoke: ${relativePath} did not subscribe to ${event}`);
}

try {
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert(packageJson.keywords?.includes("pi-package"), "pi package smoke: package is missing pi-package keyword");
	for (const key of ["extensions", "prompts", "themes"]) {
		assert(Array.isArray(packageJson.pi?.[key]) && packageJson.pi[key].length > 0, `pi package smoke: package.json pi.${key} must be non-empty`);
	}

	const settingsManager = SettingsManager.inMemory({ packages: [root], theme: "catppuccin-mocha" });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true, noSkills: true });
	await loader.reload();

	const extensionResult = loader.getExtensions();
	assert(extensionResult.errors.length === 0, `pi package smoke: extension load errors: ${extensionResult.errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`);
	assert(extensionResult.extensions.length === 4, `pi package smoke: expected 4 extensions, got ${extensionResult.extensions.length}`);

	assertExtension(extensionResult.extensions, "extensions/harness-commands.ts", {
		commands: ["mode", "status", "doctor", "doct", "memory", "checkpoint", "close-task", "task-close", "skills-audit"],
		handlers: ["session_start", "before_agent_start", "tool_call", "tool_result", "agent_end", "session_shutdown"],
	});
	assertExtension(extensionResult.extensions, "extensions/safety-gate.ts", {
		handlers: ["before_agent_start", "tool_call", "tool_result", "user_bash", "agent_end"],
	});
	assertExtension(extensionResult.extensions, "extensions/session-continuity/index.ts", {
		handlers: ["session_start", "before_agent_start", "tool_result", "agent_end", "session_shutdown", "session_before_compact", "session_compact"],
	});
	assertExtension(extensionResult.extensions, "extensions/ui-polish/index.ts", {
		handlers: ["session_start", "agent_start", "agent_end", "session_shutdown", "message_end"],
	});

	const prompts = loader.getPrompts();
	assert(prompts.diagnostics.length === 0, `pi package smoke: prompt diagnostics: ${prompts.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`);
	for (const prompt of ["handoff", "review", "simplify"]) {
		assert(prompts.prompts.some((entry) => entry.name === prompt), `pi package smoke: missing prompt ${prompt}`);
	}

	const themes = loader.getThemes();
	assert(themes.diagnostics.length === 0, `pi package smoke: theme diagnostics: ${themes.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`);
	assert(themes.themes.some((theme) => theme.name === "catppuccin-mocha"), "pi package smoke: missing catppuccin-mocha theme");

	console.log("pi lifecycle smoke ok");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
