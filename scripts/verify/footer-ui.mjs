import { assert, loadExtensionModule } from "./harness.mjs";

export function runFooterUsageTests() {
	const footer = loadExtensionModule("extensions/ui-polish/index.ts");
	assert(typeof footer.calculateFooterUsage === "function", "ui-polish should export calculateFooterUsage");
	assert(typeof footer.compactExtensionStatusItems === "function", "ui-polish should export compactExtensionStatusItems");
	assert(typeof footer.piTitle === "function", "ui-polish should export piTitle");
	assert(typeof footer.formatElapsed === "function", "ui-polish should export formatElapsed");
	assert(typeof footer.formatCount === "function", "ui-polish should export formatCount");
	assert(typeof footer.appendElapsedToAssistantMessage === "function", "ui-polish should export appendElapsedToAssistantMessage");
	assert(footer.piTitle("/tmp/project", "session", "⠋") === "⠋ π - session - project", "ui-polish should format active titlebar spinner titles");
	assert(footer.piTitle("/tmp/project", "session") === "π - session - project", "ui-polish should format idle titlebar titles");
	assert(Array.isArray(footer.TITLE_SPINNER_FRAMES) && footer.TITLE_SPINNER_FRAMES.length > 0, "ui-polish should expose titlebar spinner frames");
	assert(footer.formatCount(999) === "999", "ui-polish should format small footer counts directly");
	assert(footer.formatCount(12_345) === "12.3k", "ui-polish should compact thousands with one decimal");
	assert(footer.formatCount(12_345_678) === "12.35m", "ui-polish should compact millions with two decimals");
	assert(footer.formatCount(1_002_500_000) === "1.00b", "ui-polish should compact billion-scale footer counts instead of oversized million counts");
	assert(footer.formatElapsed(65_432) === "1:05", "ui-polish should format minute elapsed times");
	assert(footer.formatElapsed(3_661_000) === "1:01:01", "ui-polish should format hour elapsed times");
	const timedMessage = footer.appendElapsedToAssistantMessage({
		role: "assistant",
		content: [{ type: "text", text: "Done" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	}, "1:05");
	assert(timedMessage.content.at(-1)?.text?.includes("Elapsed wall time: 1:05"), "ui-polish should append final elapsed time to assistant messages");
	const usage = footer.calculateFooterUsage([
		{
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, cost: { total: 0.01 } },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "subagent",
				details: { mode: "single", results: [{ usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.2 } }] },
			},
		},
		{
			type: "custom_message",
			customType: "subagent-slash-result",
			details: {
				requestId: "r1",
				result: { details: { mode: "single", results: [{ usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.04 } }] } },
			},
		},
	]);
	assert(usage.input === 117, "footer usage should include parent and subagent input tokens");
	assert(usage.output === 58, "footer usage should include parent and subagent output tokens");
	assert(usage.cacheRead + usage.cacheWrite === 20, "footer usage should include parent and subagent cache tokens");
	assert(Math.abs(usage.cost - 0.25) < 1e-9, "footer usage should include parent and subagent cost");
	assert(usage.subagentInput === 107 && usage.subagentOutput === 53, "footer usage should expose subagent token contribution");

	const statuses = footer.compactExtensionStatusItems(new Map([
		["memory", "\u001b[2mmemory:ready:12\u001b[22m"],
		["latex-preview", "latex:auto"],
		["turn-timer", "\u001b[2mlast:1:05\u001b[22m"],
		["mode", "mode:deep"],
		["custom-long-key", "custom status value"],
	]));
	assert(statuses.length === 5, "footer should keep extension statuses as separate compact chips");
	assert(statuses[0].label === "mem" && statuses[0].value === "r12", "footer should compact memory status values");
	assert(statuses[1].label === "tex" && statuses[1].value === "auto", "footer should compact latex status values");
	assert(statuses[2].label === "time" && statuses[2].value === "1:05", "footer should render turn timer as a clear time chip");
	assert(statuses[2].bg === "selectedBg" && statuses[2].labelColor === "text", "footer timer chip should use an explicit readable background and label color");
	assert(statuses[3].label === "mode" && statuses[3].value === "deep", "footer should compact mode status values");
	assert(statuses[4].label.startsWith("custo") && statuses[4].label.includes("…") && statuses[4].value.startsWith("custom st") && statuses[4].value.includes("…"), "footer should truncate unknown status chips predictably");
	assert(!statuses.some((status) => status.label === "state"), "footer should not collapse extension statuses into a long state segment");
}
