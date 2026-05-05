import { loadExtensionModule } from "../harness.mjs";
import { assert, createTaskHarness, taskBindPayload } from "./support.mjs";

function assistantMessage(stopReason = "stop") {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
}

export async function runFinalVisibilityTests() {
	const visibility = loadExtensionModule("extensions/shared/final-visibility.ts");
	const ambient = {
		version: "v0",
		weight: "standard",
		lanes: [
			{ id: "execution", title: "Ambient execution protocol", status: "included", chars: 100, publicSummary: "profile software; overlays none" },
			{ id: "memory", title: "Approved scoped memory", status: "included", chars: 20 },
			{ id: "repo", title: "Repo metadata", status: "skipped", chars: 0, reason: "untracked secret.txt not scanned" },
		],
		policyReasons: ["nontrivial_prompt"],
		personalContext: "auto_scoped",
		advisorySubagents: "not_enabled",
		vectorMemory: false,
	};
	const footer = visibility.formatFinalVisibility({
		ambient,
		mode: "fast",
		task: {
			state: "bound",
			activity: { reads: 1, writes: 2, commands: 3, errors: 0 },
			artifacts: { recordedThisTurn: 2, skippedThisTurn: 1 },
		},
	});
	assert(footer.includes("╭─ Harness visibility"), "final visibility should render a compact visual footer");
	assert(footer.includes("│ ambient  standard · mode fast · task bound"), "final visibility should include prompt weight, mode, and task state in one row");
	assert(footer.includes("│ exec     software · overlays none"), "final visibility should include safe execution routing metadata");
	assert(footer.includes("│ turn     activity r1/w2/c3/e0 · artifacts 2 meta +1 skipped"), "final visibility should summarize activity and artifact metadata in one row");
	assert(footer.includes("│ memory   approved yes · durable writes no · vector off"), "final visibility should summarize memory/write posture without memory content");
	assert(!footer.includes("secret.txt"), "final visibility should not include skipped-lane reasons or filenames");
	assert(!visibility.formatFinalVisibility({ ambient: { ...ambient, weight: "trivial" } }), "trivial turns should not get final visibility noise");

	const appended = visibility.appendFinalVisibilityToAssistantMessage(assistantMessage(), { ambient, task: { state: "not_bound", activity: { reads: 0, writes: 0, commands: 0, errors: 0 }, artifacts: { recordedThisTurn: 0, skippedThisTurn: 0 } } });
	assert(appended.content.at(-1).text.includes("Harness visibility"), "final visibility should append to assistant messages");
	const idempotent = visibility.appendFinalVisibilityToAssistantMessage(appended, { ambient });
	assert(idempotent === appended, "final visibility append should be idempotent");
	const mentionsVisibility = assistantMessage();
	mentionsVisibility.content[0].text = "This discusses Harness visibility without already appending the footer.";
	const stillAppended = visibility.appendFinalVisibilityToAssistantMessage(mentionsVisibility, { ambient });
	assert(stillAppended !== mentionsVisibility && stillAppended.content.at(-1).text.includes("╭─ Harness visibility"), "ordinary prose mentioning Harness visibility should not suppress footer append");
	const uiPolish = loadExtensionModule("extensions/ui-polish/index.ts");
	const visibilityThenElapsed = uiPolish.appendElapsedToAssistantMessage(appended, "0:01");
	assert(visibilityThenElapsed.content.some((block) => block.text?.includes("Harness visibility")) && visibilityThenElapsed.content.some((block) => block.text?.includes("Elapsed wall time: 0:01")), "final visibility should compose with elapsed footer after it");
	const elapsedThenVisibility = visibility.appendFinalVisibilityToAssistantMessage(uiPolish.appendElapsedToAssistantMessage(assistantMessage(), "0:02"), { ambient });
	assert(elapsedThenVisibility.content.some((block) => block.text?.includes("Harness visibility")) && elapsedThenVisibility.content.some((block) => block.text?.includes("Elapsed wall time: 0:02")), "final visibility should compose with elapsed footer before it");

	const harness = createTaskHarness({ bindPayload: taskBindPayload() });
	await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
	await harness.handlers.get("before_agent_start")({ prompt: "Go ahead and implement final visibility", systemPrompt: "base" }, harness.ctx);
	await harness.handlers.get("tool_result")({ toolName: "edit", input: { path: "src/final.ts" }, isError: false }, harness.ctx);
	const final = await harness.handlers.get("message_end")({ message: assistantMessage() }, harness.ctx);
	const finalText = final?.message?.content.at(-1)?.text ?? "";
	assert(finalText.includes("Harness visibility"), "harness should append final visibility on final assistant messages");
	assert(finalText.includes("exec     software · overlays none"), "harness final visibility should include execution route metadata when detected");
	assert(finalText.includes("task bound"), "harness final visibility should include task binding state");
	assert(finalText.includes("activity r0/w1/c0/e0"), "harness final visibility should include observed turn activity");
	assert(finalText.includes("artifacts 1 meta"), "harness final visibility should include artifact metadata captured this turn");
	assert(finalText.includes("approved no"), "harness final visibility should avoid approved-memory content");
	assert(!finalText.includes("pi-task"), "harness final visibility should not include task ids");
	const toolUse = await harness.handlers.get("message_end")({ message: assistantMessage("toolUse") }, harness.ctx);
	assert(!toolUse, "harness should not append final visibility to intermediate tool-use assistant messages");
}
