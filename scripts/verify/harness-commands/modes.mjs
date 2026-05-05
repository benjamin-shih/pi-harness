import { loadExtensionModule } from "../harness.mjs";
import { assert } from "./support.mjs";

function createModeHarness() {
	const calls = { models: [], thinking: [], tools: [], statuses: [], notifications: [] };
	const allTools = [
		{ name: "read" },
		{ name: "bash" },
		{ name: "edit" },
		{ name: "write" },
		{ name: "grep" },
		{ name: "find" },
		{ name: "ls" },
	];
	return {
		calls,
		pi: {
			getAllTools: () => allTools,
			setActiveTools: (tools) => calls.tools.push(tools),
			setThinkingLevel: (level) => calls.thinking.push(level),
			setModel: async (model) => {
				calls.models.push(model);
				return true;
			},
		},
		ctx: {
			modelRegistry: {
				find: (provider, id) => id === "gpt-5.4-mini" ? { provider, id } : undefined,
			},
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus: (key, value) => calls.statuses.push({ key, value }),
				notify: (message, level) => calls.notifications.push({ message, level }),
			},
		},
	};
}

export async function runModeBehaviorTests() {
	const modes = loadExtensionModule("extensions/harness-commands/modes.ts");
	assert(modes.modeNames().includes("fast") && modes.modeNames().includes("readonly"), "mode list should include fast and readonly modes");
	assert(modes.modeDescription("fast").includes("smaller GPT"), "fast mode should describe the smaller GPT path");
	assert(modes.modeInstructions("fast")?.includes("FAST MODE"), "fast mode should provide ambient instructions");
	assert(!modes.modeInstructions("default"), "default mode should not add prompt noise");

	const fast = createModeHarness();
	assert(await modes.applyMode("fast", fast.pi, fast.ctx), "fast mode should apply successfully");
	assert(fast.calls.models[0]?.id === "gpt-5.4-mini", "fast mode should prefer the smaller GPT model when available");
	assert(fast.calls.thinking.at(-1) === "low", "fast mode should lower thinking level");
	assert(fast.calls.tools.at(-1).length === fast.pi.getAllTools().length, "fast mode should enable all tools");
	assert(fast.calls.statuses.at(-1)?.value === "mode:fast", "fast mode should update UI status");

	const readonly = createModeHarness();
	assert(await modes.applyMode("readonly", readonly.pi, readonly.ctx), "readonly mode should apply successfully");
	assert(readonly.calls.thinking.at(-1) === "high", "readonly mode should use high thinking");
	assert(readonly.calls.tools.at(-1).join(",") === "read,grep,find,ls", "readonly mode should restrict active tools to read-like tools");
	assert(modes.modeInstructions("readonly")?.includes("Do not edit files"), "readonly mode should add explicit non-mutation instructions");

	const missingModel = createModeHarness();
	missingModel.ctx.modelRegistry.find = () => undefined;
	assert(await modes.applyMode("fast", missingModel.pi, missingModel.ctx), "missing preferred models should not prevent mode application");
	assert(missingModel.calls.notifications.some((notification) => notification.level === "warning"), "missing mode models should warn the user");

	assert(!(await modes.applyMode("unknown", createModeHarness().pi, createModeHarness().ctx)), "unknown modes should not apply");
}
