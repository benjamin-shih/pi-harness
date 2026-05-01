import { runHarnessAuditAndLocalSkillsTests } from "./verify/audits.mjs";
import { runFooterUsageTests } from "./verify/footer-ui.mjs";
import { runHarnessCommandBehaviorTests } from "./verify/harness-commands.mjs";
import { runPackageStructureTests } from "./verify/package-structure.mjs";
import { runLatexPreviewBehaviorTests } from "./verify/latex-preview.mjs";
import { runSafetyGateBehaviorTests } from "./verify/safety-gate.mjs";
import { runSessionContinuityBehaviorTests } from "./verify/session-continuity.mjs";
import { runShellParserTests } from "./verify/shell-parser.mjs";
import { runSupportModuleTests } from "./verify/support-modules.mjs";

for (const run of [
	runPackageStructureTests,
	runSupportModuleTests,
	runShellParserTests,
	runFooterUsageTests,
	runHarnessCommandBehaviorTests,
	runSafetyGateBehaviorTests,
	runLatexPreviewBehaviorTests,
	runSessionContinuityBehaviorTests,
	runHarnessAuditAndLocalSkillsTests,
]) {
	await run();
}

if (process.exitCode) process.exit(process.exitCode);
console.log("verify ok");
