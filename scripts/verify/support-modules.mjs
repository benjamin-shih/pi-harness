import { homedir } from "node:os";
import { join } from "node:path";
import { assert, loadExtensionModule } from "./harness.mjs";

export function runSupportModuleTests() {
	const config = loadExtensionModule("extensions/shared/config.ts");
	const previousAgentsRoot = process.env.AGENTS_SHARED_ROOT;
	const previousSkillsRoot = process.env.AGENTS_SKILLS_ROOT;
	try {
		delete process.env.AGENTS_SHARED_ROOT;
		delete process.env.AGENTS_SKILLS_ROOT;
		assert(config.agentsRoot() === join(homedir(), ".agents"), "shared config should default agents root under the current home directory");
		assert(config.skillsRoot() === join(homedir(), ".agents", "skills"), "shared config should default skills root under the current home directory");

		process.env.AGENTS_SHARED_ROOT = "/tmp/pi-agents-root";
		delete process.env.AGENTS_SKILLS_ROOT;
		assert(config.agentsRoot() === "/tmp/pi-agents-root", "shared config should honor AGENTS_SHARED_ROOT");
		assert(config.skillsRoot() === join("/tmp/pi-agents-root", "skills"), "shared config should derive skills root from AGENTS_SHARED_ROOT");
		process.env.AGENTS_SKILLS_ROOT = "/tmp/pi-skills-root";
		assert(config.skillsRoot() === "/tmp/pi-skills-root", "shared config should honor AGENTS_SKILLS_ROOT");
	} finally {
		if (previousAgentsRoot === undefined) delete process.env.AGENTS_SHARED_ROOT;
		else process.env.AGENTS_SHARED_ROOT = previousAgentsRoot;
		if (previousSkillsRoot === undefined) delete process.env.AGENTS_SKILLS_ROOT;
		else process.env.AGENTS_SKILLS_ROOT = previousSkillsRoot;
	}
}
