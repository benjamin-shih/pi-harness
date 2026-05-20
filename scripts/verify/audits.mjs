import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assert, fail, root } from "./harness.mjs";

function defaultSkillsRoot() {
	if (process.env.AGENTS_SKILLS_ROOT) return process.env.AGENTS_SKILLS_ROOT;
	return join(process.env.AGENTS_SHARED_ROOT || join(homedir(), ".agents"), "skills");
}

function runHarnessAuditTest() {
	const stdout = execFileSync(process.execPath, [join(root, "scripts", "harness-audit.mjs"), "--json"], { encoding: "utf8" });
	const audit = JSON.parse(stdout);
	assert(audit.issues.length === 0, `harness audit has ${audit.issues.length} issue(s)`);
	assert(audit.metrics.runtimeExtensionEntrypoints <= 4, "harness audit should enforce compact runtime extension count");
	assert(audit.metrics.leanHotPath?.profile === "lean", "harness audit should expose lean hot-path metrics");
	assert(typeof audit.metrics.leanHotPath.ambientTurnExecSites === "number", "lean hot-path metrics should count ambient exec sites");
	assert(audit.metrics.leanHotPath.deferredCleanupSnapshot === true, "lean hot-path metrics should observe deferred cleanup snapshots");
	assert(audit.extensions.some((extension) => extension.path === "extensions/session-continuity/index.ts"), "harness audit should discover directory-style session-continuity extension");
}

function runLocalSkillsAuditTest() {
	const localSkillsRoot = defaultSkillsRoot();
	if (!existsSync(localSkillsRoot)) return;
	try {
		const stdout = execFileSync(process.execPath, [join(root, "scripts", "skills-audit.mjs"), "--root", localSkillsRoot, "--json"], {
			encoding: "utf8",
		});
		const audit = JSON.parse(stdout);
		assert(audit.issues.length === 0, `local skills audit has ${audit.issues.length} issue(s)`);
	} catch (error) {
		fail(`local skills audit failed: ${error.message}`);
	}
}

export function runHarnessAuditAndLocalSkillsTests() {
	runHarnessAuditTest();
	runLocalSkillsAuditTest();
}
