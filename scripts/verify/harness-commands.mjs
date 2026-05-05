import { runAmbientContextTests } from "./harness-commands/ambient-context.mjs";
import { runCleanupGuardTests } from "./harness-commands/cleanup-guard.mjs";
import { runFinalVisibilityTests } from "./harness-commands/final-visibility.mjs";
import { runModeBehaviorTests } from "./harness-commands/modes.mjs";
import { runPromptGuidanceTests } from "./harness-commands/prompt-guidance.mjs";
import { runStatusCommandTests } from "./harness-commands/status-commands.mjs";
import { runTaskLayerTests } from "./harness-commands/task-layer.mjs";
import { runTaskLayerScriptBoundaryTests } from "./harness-commands/task-layer-script-boundary.mjs";

export async function runHarnessCommandBehaviorTests() {
	await runAmbientContextTests();
	await runFinalVisibilityTests();
	await runModeBehaviorTests();
	await runPromptGuidanceTests();
	await runStatusCommandTests();
	await runTaskLayerTests();
	await runTaskLayerScriptBoundaryTests();
	await runCleanupGuardTests();
}
