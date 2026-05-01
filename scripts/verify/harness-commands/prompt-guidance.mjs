import { loadExtensionModule } from "../harness.mjs";
import { assert, createHarness, root, withEnv } from "./support.mjs";

export async function runPromptGuidanceTests() {
	const promptGuidance = loadExtensionModule("extensions/harness-commands/prompt-guidance.ts");
	assert(promptGuidance.classifyPrompt("What is specificity?") === "trivial", "fallback prompt classifier should not treat incidental ci substrings as complex");
	const basic = createHarness([]);
	const result = await basic.beforeAgentStart({ prompt: "What is the CLT?", systemPrompt: "base" }, { cwd: root });
	assert(result?.systemPrompt?.includes("## Display Math Rendering"), "harness should inject displaymath rendering guidance");
	assert(result.systemPrompt.includes("\\begin{displaymath}"), "harness should ask agents to use displaymath delimiters");
	assert(result.systemPrompt.includes("instead of `\\[`"), "harness should discourage bracket display delimiters");
	assert(result.systemPrompt.includes("## Markdown Heading Rendering"), "harness should inject Markdown heading rendering guidance");
	assert(result.systemPrompt.includes("use only `#` and `##` Markdown headings"), "harness should steer agents away from deeper Markdown headings");
	assert(result.systemPrompt.includes("instead of `###`"), "harness should recommend bold labels instead of raw level-3 headings");
	assert(!result.systemPrompt.includes("## Post-Change Cleanup Gate"), "harness should not inject cleanup guidance for non-coding prompts");

	await withEnv({ AGENTS_SKILLS_ROOT: "/tmp/pi-custom-skills" }, async () => {
		const routed = createHarness([]);
		const routedResult = await routed.beforeAgentStart({ prompt: "Implement config cleanup", systemPrompt: "base" }, { cwd: root });
		assert(routedResult.systemPrompt.includes("/tmp/pi-custom-skills/SKILLS.md"), "skill-routing guidance should honor AGENTS_SKILLS_ROOT");
	});
}
