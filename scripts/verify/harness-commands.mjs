import { runAmbientContextTests } from "./harness-commands/ambient-context.mjs";
import { runCleanupGuardTests } from "./harness-commands/cleanup-guard.mjs";
import { runExecutionGuidanceTests } from "./harness-commands/execution-guidance.mjs";
import { runFinalVisibilityTests } from "./harness-commands/final-visibility.mjs";
import { runGitSummaryTests } from "./harness-commands/git-summary.mjs";
import { runInboxCommandTests } from "./harness-commands/inbox-command.mjs";
import { runModeBehaviorTests } from "./harness-commands/modes.mjs";
import { runPromptGuidanceTests } from "./harness-commands/prompt-guidance.mjs";
import { runRemoteCiGuardTests } from "./harness-commands/remote-ci-guard.mjs";
import { runStatusCommandTests } from "./harness-commands/status-commands.mjs";
import { runSubagentTopologyTests } from "./harness-commands/subagent-topology.mjs";
import { runTaskLayerTests } from "./harness-commands/task-layer.mjs";
import { runTaskLayerScriptBoundaryTests } from "./harness-commands/task-layer-script-boundary.mjs";

export async function runHarnessCommandBehaviorTests() {
	await runAmbientContextTests();
	await runExecutionGuidanceTests();
	await runFinalVisibilityTests();
	await runGitSummaryTests();
	await runInboxCommandTests();
	await runModeBehaviorTests();
	await runPromptGuidanceTests();
	await runRemoteCiGuardTests();
	await runStatusCommandTests();
	await runSubagentTopologyTests();
	await runTaskLayerTests();
	await runTaskLayerScriptBoundaryTests();
	await runCleanupGuardTests();
}
