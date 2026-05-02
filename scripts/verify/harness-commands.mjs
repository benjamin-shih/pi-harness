import { runAmbientContextTests } from "./harness-commands/ambient-context.mjs";
import { runCleanupGuardTests } from "./harness-commands/cleanup-guard.mjs";
import { runPromptGuidanceTests } from "./harness-commands/prompt-guidance.mjs";
import { runStatusCommandTests } from "./harness-commands/status-commands.mjs";
import { runTaskLayerTests } from "./harness-commands/task-layer.mjs";

export async function runHarnessCommandBehaviorTests() {
	await runAmbientContextTests();
	await runPromptGuidanceTests();
	await runStatusCommandTests();
	await runTaskLayerTests();
	await runCleanupGuardTests();
}
