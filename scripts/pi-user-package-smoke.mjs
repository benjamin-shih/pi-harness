import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PI_OFFLINE = "1";

const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const agentDir = join(home, ".pi", "agent");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function displayPath(value) {
	return String(value || "")
		.replaceAll(home, "~")
		.replaceAll(root, "<harness>");
}

function extensionPath(entry) {
	return entry.resolvedPath || entry.path || "";
}

if (!existsSync(agentDir)) {
	console.log("pi user package smoke skipped: no local agent directory");
	process.exit(0);
}

const settingsManager = SettingsManager.create(home, agentDir);

async function loadRuntimeExtensions(childMode = false) {
	const previous = process.env.PI_SUBAGENT_CHILD;
	if (childMode) process.env.PI_SUBAGENT_CHILD = "1";
	else delete process.env.PI_SUBAGENT_CHILD;
	try {
		const loader = new DefaultResourceLoader({ cwd: home, agentDir, settingsManager, noContextFiles: true, noSkills: false });
		await loader.reload();
		return { loader, extensionResult: loader.getExtensions() };
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
}

function extensionWith(extensionResult, predicate) {
	return extensionResult.extensions.find((entry) => predicate(extensionPath(entry)));
}

function relativeExtensionPath(entry) {
	return relative(root, extensionPath(entry)).split("\\").join("/");
}

function extensionByRelativePath(extensionResult, relativePath) {
	return extensionResult.extensions.find((entry) => relativeExtensionPath(entry) === relativePath);
}

function commandNames(extension) {
	return [...(extension?.commands?.keys?.() ?? [])].sort();
}

function handlerNames(extension) {
	return [...(extension?.handlers?.keys?.() ?? [])].sort();
}

function assertNames(actual, expected, label) {
	const expectedSorted = [...expected].sort();
	assert(JSON.stringify(actual) === JSON.stringify(expectedSorted), `pi user package smoke: ${label} expected ${expectedSorted.join(",") || "none"}, got ${actual.join(",") || "none"}`);
}

function assertCommand(extension, command, label) {
	assert(extension?.commands?.has(command), `pi user package smoke: ${label} did not register /${command}`);
}

const { loader, extensionResult } = await loadRuntimeExtensions(false);
assert(
	extensionResult.errors.length === 0,
	`pi user package smoke: extension load errors: ${extensionResult.errors.map((error) => `${displayPath(error.path)}: ${String(error.error).slice(0, 160)}`).join("; ")}`,
);
const harnessExtension = extensionWith(extensionResult, (entryPath) => entryPath.startsWith(root));
const subagentsExtension = extensionWith(extensionResult, (entryPath) => entryPath.includes("pi-subagents"));
const intercomExtension = extensionWith(extensionResult, (entryPath) => entryPath.includes("pi-intercom"));
assert(harnessExtension, "pi user package smoke: ben-pi-harness is not loaded from user settings");
assert(subagentsExtension, "pi user package smoke: pi-subagents is not loaded from user settings");
assert(intercomExtension, "pi user package smoke: pi-intercom is not loaded from user settings");
for (const command of ["run", "parallel", "subagents-doctor"]) assertCommand(subagentsExtension, command, "pi-subagents");
assertCommand(intercomExtension, "intercom", "pi-intercom");

const childLoad = await loadRuntimeExtensions(true);
assert(
	childLoad.extensionResult.errors.length === 0,
	`pi user package smoke: subagent-child extension load errors: ${childLoad.extensionResult.errors.map((error) => `${displayPath(error.path)}: ${String(error.error).slice(0, 160)}`).join("; ")}`,
);
const expectedChildMode = new Map([
	["extensions/harness-commands.ts", { commands: [], handlers: [] }],
	["extensions/safety-gate.ts", { commands: [], handlers: ["agent_end", "before_agent_start", "tool_call", "tool_result", "user_bash"] }],
	["extensions/session-continuity/index.ts", { commands: [], handlers: [] }],
	["extensions/ui-polish/index.ts", { commands: [], handlers: [] }],
	["packages/ben-pi-latex-preview/extensions/latex-preview.ts", { commands: [], handlers: ["agent_end", "agent_start", "input", "session_shutdown", "session_start"] }],
]);
for (const [relativePath, expected] of expectedChildMode.entries()) {
	const extension = extensionByRelativePath(childLoad.extensionResult, relativePath);
	assert(extension, `pi user package smoke: missing child-mode extension ${relativePath}`);
	assertNames(commandNames(extension), expected.commands, `${relativePath} child commands`);
	assertNames(handlerNames(extension), expected.handlers, `${relativePath} child handlers`);
}

const skills = loader.getSkills();
const skillDiagnostics = skills.diagnostics ?? skills.errors ?? [];
assert(skillDiagnostics.length === 0, `pi user package smoke: skill diagnostics: ${skillDiagnostics.map((diagnostic) => String(diagnostic.message || diagnostic.error || diagnostic).slice(0, 160)).join("; ")}`);

console.log(`pi user package smoke ok: ${extensionResult.extensions.length} extensions, ${skills.skills.length} skills`);
