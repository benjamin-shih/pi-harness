import { homedir } from "node:os";
import { join } from "node:path";
import { assert, loadExtensionModule, withEnv } from "./harness.mjs";

export async function runSupportModuleTests() {
	const config = loadExtensionModule("extensions/shared/config.ts");
	await withEnv({ AGENTS_SHARED_ROOT: undefined, AGENTS_SKILLS_ROOT: undefined }, async () => {
		assert(config.agentsRoot() === join(homedir(), ".agents"), "shared config should default agents root under the current home directory");
		assert(config.skillsRoot() === join(homedir(), ".agents", "skills"), "shared config should default skills root under the current home directory");
	});

	await withEnv({ AGENTS_SHARED_ROOT: "/tmp/pi-agents-root", AGENTS_SKILLS_ROOT: undefined }, async () => {
		assert(config.agentsRoot() === "/tmp/pi-agents-root", "shared config should honor AGENTS_SHARED_ROOT");
		assert(config.skillsRoot() === join("/tmp/pi-agents-root", "skills"), "shared config should derive skills root from AGENTS_SHARED_ROOT");
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
}
