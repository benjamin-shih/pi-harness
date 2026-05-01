import { runHarnessAuditAndLocalSkillsTests } from "./audits.mjs";
import { runFooterUsageTests } from "./footer-ui.mjs";
import { runHarnessCommandBehaviorTests } from "./harness-commands.mjs";
import { runLatexPreviewBehaviorTests } from "./latex-preview.mjs";
import { runSafetyGateBehaviorTests } from "./safety-gate.mjs";
import { runSessionContinuityBehaviorTests } from "./session-continuity.mjs";

export async function runBehaviorSuite() {
	runFooterUsageTests();
	await runHarnessCommandBehaviorTests();
	await runSafetyGateBehaviorTests();
	await runLatexPreviewBehaviorTests();
	await runSessionContinuityBehaviorTests();
	runHarnessAuditAndLocalSkillsTests();
}
