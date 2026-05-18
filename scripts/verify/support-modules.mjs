import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assert, loadExtensionModule, withEnv } from "./harness.mjs";

export async function runSupportModuleTests() {
	const config = loadExtensionModule("extensions/shared/config.ts");
	const agentsClient = loadExtensionModule("extensions/shared/agents-client.ts");
	const harnessProfile = loadExtensionModule("extensions/shared/harness-profile.ts");
	const capabilityRegistry = loadExtensionModule("extensions/harness-commands/capability-registry.ts");
	await withEnv({ AGENTS_SHARED_ROOT: undefined, AGENTS_SKILLS_ROOT: undefined }, async () => {
		assert(config.agentsRoot() === join(homedir(), ".agents"), "shared config should default agents root under the current home directory");
		assert(config.skillsRoot() === join(homedir(), ".agents", "skills"), "shared config should default skills root under the current home directory");
	});

	await withEnv({ AGENTS_SHARED_ROOT: "/tmp/pi-agents-root", AGENTS_SKILLS_ROOT: undefined }, async () => {
		assert(config.agentsRoot() === "/tmp/pi-agents-root", "shared config should honor AGENTS_SHARED_ROOT");
		assert(config.skillsRoot() === join("/tmp/pi-agents-root", "skills"), "shared config should derive skills root from AGENTS_SHARED_ROOT");
		const pi = { exec: async (_cmd, args, options) => ({ code: 0, stdout: JSON.stringify({ task_api_version: 1, script: args[0], cwd: options.cwd }), stderr: "" }) };
		const payload = await agentsClient.runAgentsJson(pi, { scriptName: "task-api.sh", args: ["info"], cwd: "/tmp/project", versionKey: "task_api_version", expectedVersion: 1 });
		assert(payload?.script === join("/tmp/pi-agents-root", "scripts", "task-api.sh") && payload?.cwd === "/tmp/project", "agents client should centralize script path, cwd, and JSON version checks");
		assert(!agentsClient.agentsJsonPayload({ code: 0, stdout: JSON.stringify({ task_api_version: 2 }), stderr: "" }, "task_api_version", 1), "agents client should reject unsupported JSON versions");
	});

	await withEnv({ AGENTS_SHARED_ROOT: "~/.agents", AGENTS_SKILLS_ROOT: undefined }, async () => {
		assert(config.agentsRoot() === join(homedir(), ".agents"), "shared config should expand tilde agents roots");
		assert(config.agentsScriptPath("task-api.sh") === join(homedir(), ".agents", "scripts", "task-api.sh"), "shared config should build script paths from expanded roots");
	});

	await withEnv({ AGENTS_SKILLS_ROOT: "${HOME}/pi-skills-root" }, async () => {
		assert(config.skillsRoot() === join(homedir(), "pi-skills-root"), "shared config should expand home variables in skill roots");
	});

	await withEnv({ AGENTS_SKILLS_ROOT: "/tmp/pi-skills-root" }, async () => {
		assert(config.skillsRoot() === "/tmp/pi-skills-root", "shared config should honor AGENTS_SKILLS_ROOT");
	});

	await withEnv({ BEN_PI_HARNESS_PROFILE: undefined, BEN_PI_ASYNC_INBOX: undefined, BEN_PI_CONTROL_PLANE_SURFACES: undefined, BEN_PI_AMBIENT_ORCHESTRATION: undefined }, async () => {
		const lean = harnessProfile.harnessRuntimeConfig(process.cwd());
		const leanCommands = capabilityRegistry.enabledCommandCapabilities(lean).map((capability) => capability.name);
		assert(lean.profile === "lean", "harness profile should default to lean");
		assert(!lean.asyncInbox && !lean.controlPlaneSurfaces && !lean.ambientOrchestration, "lean profile should disable optional control-plane surfaces by default");
		assert(leanCommands.includes("mode") && leanCommands.includes("status") && leanCommands.includes("memory"), "capability registry should keep core lean commands enabled");
		assert(!leanCommands.includes("inbox") && !leanCommands.includes("control-center") && !leanCommands.includes("run-card") && !leanCommands.includes("choose-topology"), "capability registry should keep full-only commands out of lean by default");
	});
	await withEnv({ BEN_PI_HARNESS_PROFILE: "full" }, async () => {
		const full = harnessProfile.harnessRuntimeConfig(process.cwd());
		const fullCommands = capabilityRegistry.enabledCommandCapabilities(full).map((capability) => capability.name);
		assert(full.profile === "full", "harness profile should honor full profile env override");
		assert(full.asyncInbox && full.controlPlaneSurfaces && full.ambientOrchestration, "full profile should enable control-plane surfaces by default");
		assert(fullCommands.includes("inbox") && fullCommands.includes("control-center") && fullCommands.includes("run-card") && fullCommands.includes("choose-topology"), "capability registry should enable profile-gated commands in full profile");
	});
	await withEnv({ BEN_PI_HARNESS_PROFILE: "lean", BEN_PI_ASYNC_INBOX: "1" }, async () => {
		const explicit = harnessProfile.harnessRuntimeConfig(process.cwd());
		const explicitCommands = capabilityRegistry.enabledCommandCapabilities(explicit).map((capability) => capability.name);
		assert(explicit.profile === "lean" && explicit.asyncInbox && !explicit.controlPlaneSurfaces, "explicit feature env overrides should work within lean profile");
		assert(explicitCommands.includes("inbox") && !explicitCommands.includes("control-center"), "capability registry should honor independent feature overrides within lean profile");
	});
	const settingsRoot = mkdtempSync(join(tmpdir(), "pi-harness-profile-"));
	try {
		mkdirSync(join(settingsRoot, ".pi"));
		writeFileSync(join(settingsRoot, ".pi", "settings.json"), JSON.stringify({ harness: { profile: "lean", controlPlaneSurfaces: true, ambientOrchestration: true } }));
		await withEnv({ BEN_PI_HARNESS_PROFILE: undefined, BEN_PI_ASYNC_INBOX: undefined, BEN_PI_CONTROL_PLANE_SURFACES: undefined, BEN_PI_AMBIENT_ORCHESTRATION: undefined }, async () => {
			const fromSettings = harnessProfile.harnessRuntimeConfig(join(settingsRoot, "subdir"));
			assert(fromSettings.profile === "lean" && !fromSettings.asyncInbox && fromSettings.controlPlaneSurfaces && fromSettings.ambientOrchestration, "project .pi/settings.json should configure harness profile feature overrides");
		});
	} finally {
		rmSync(settingsRoot, { recursive: true, force: true });
	}
}
