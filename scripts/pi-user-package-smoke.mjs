import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const loader = new DefaultResourceLoader({ cwd: home, agentDir, settingsManager, noContextFiles: true, noSkills: false });
await loader.reload();

const extensionResult = loader.getExtensions();
assert(
	extensionResult.errors.length === 0,
	`pi user package smoke: extension load errors: ${extensionResult.errors.map((error) => `${displayPath(error.path)}: ${String(error.error).slice(0, 160)}`).join("; ")}`,
);
const extensionPaths = extensionResult.extensions.map(extensionPath);
assert(extensionPaths.some((entryPath) => entryPath.startsWith(root)), "pi user package smoke: ben-pi-harness is not loaded from user settings");
assert(extensionPaths.some((entryPath) => entryPath.includes("pi-subagents")), "pi user package smoke: pi-subagents is not loaded from user settings");
assert(extensionPaths.some((entryPath) => entryPath.includes("pi-intercom")), "pi user package smoke: pi-intercom is not loaded from user settings");

const skills = loader.getSkills();
const skillDiagnostics = skills.diagnostics ?? skills.errors ?? [];
assert(skillDiagnostics.length === 0, `pi user package smoke: skill diagnostics: ${skillDiagnostics.map((diagnostic) => String(diagnostic.message || diagnostic.error || diagnostic).slice(0, 160)).join("; ")}`);

console.log(`pi user package smoke ok: ${extensionResult.extensions.length} extensions, ${skills.skills.length} skills`);
