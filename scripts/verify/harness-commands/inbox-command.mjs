import { existsSync } from "node:fs";
import { assert, createTaskHarness } from "./support.mjs";

function createEventBus() {
	const handlers = new Map();
	return {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => handlers.set(event, handlers.get(event).filter((candidate) => candidate !== handler));
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) handler(data);
		},
		handlers,
	};
}

async function flushMicrotasks() {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

export async function runInboxCommandTests() {
	const bus = createEventBus();
	let slashRequest;
	bus.on("subagent:slash:request", (data) => {
		slashRequest = data;
		bus.emit("subagent:slash:response", {
			requestId: data.requestId,
			isError: false,
			result: { details: { mode: "single", results: [], asyncId: "async-1", asyncDir: "/tmp/async-1" } },
		});
	});

	const harness = createTaskHarness({ eventBus: bus });
	assert(harness.commands.has("inbox"), "/inbox should be registered in parent harness mode");

	await harness.commands.get("inbox").handler("", harness.ctx);
	const listText = harness.sentMessages.at(-1).content;
	assert(listText.includes("## Async inbox"), "/inbox should render the shared inbox list");
	assert(listText.includes("active lanes:"), "/inbox should surface bounded lane status from .agents");
	assert(listText.includes("Build Kalshi tool"), "/inbox list should render safe titles only");

	await harness.commands.get("inbox").handler("submit Build Kalshi tool with private details", harness.ctx);
	const receipt = harness.sentMessages.at(-1).content;
	assert(receipt.includes("scheduler action: launch"), "/inbox submit should ask .agents scheduler for the item action");
	assert(receipt.includes("worker launch: started; worker launch accepted"), "/inbox submit should execute returned .agents launch specs through the subagent bridge");
	assert(!receipt.includes("private details"), "/inbox receipt should not echo raw request text");
	assert(slashRequest?.params?.async === true, "/inbox worker bridge should preserve async launch params from .agents");
	assert(slashRequest?.params?.task?.includes("Private request file:"), "/inbox worker launch should point at the private request file");
	assert(!slashRequest?.params?.task?.includes("private details"), "/inbox worker launch should not include raw request text");

	const enqueueCall = harness.execCalls.find((call) => call.args[0]?.endsWith("inbox-enqueue.sh"));
	assert(enqueueCall?.args.includes("--request-file"), "/inbox submit should pass request text through a private temp file");
	assert(!enqueueCall?.args.includes("Build Kalshi tool with private details"), "/inbox submit should not pass raw request text through argv");
	const requestPath = enqueueCall?.args[enqueueCall.args.indexOf("--request-file") + 1];
	assert(requestPath && !existsSync(requestPath), "/inbox submit should clean up the private request temp file");
	assert(harness.execCalls.some((call) => call.args[0]?.endsWith("inbox-worker-start.sh")), "/inbox submit should record worker start after launch acceptance");

	bus.emit("subagent:async-complete", { id: "async-1", results: [{ success: true, output: "Completed successfully", artifactPaths: { outputPath: "/tmp/out.md" } }] });
	await flushMicrotasks();
	const completeCall = harness.execCalls.find((call) => call.args[0]?.endsWith("inbox-worker-complete.sh"));
	assert(completeCall, "/inbox bridge should record bounded worker completion events");
	assert(completeCall.args.includes("--summary-file"), "/inbox completion should pass worker summary through a private file");
	assert(!completeCall.args.includes("Completed successfully"), "/inbox completion should not pass raw worker output through argv");
	const summaryPath = completeCall.args[completeCall.args.indexOf("--summary-file") + 1];
	assert(summaryPath && !existsSync(summaryPath), "/inbox completion should clean up the private summary file");

	const noBridgeHarness = createTaskHarness({ eventBus: {} });
	await noBridgeHarness.commands.get("inbox").handler("submit Build Kalshi tool", noBridgeHarness.ctx);
	const noBridgeReceipt = noBridgeHarness.sentMessages.at(-1).content;
	assert(noBridgeReceipt.includes("worker launch: degraded; pi-subagents event bridge is unavailable"), "/inbox submit should report unavailable worker bridge without pretending work launched");
	const failedLaunchCall = noBridgeHarness.execCalls.find((call) => call.args[0]?.endsWith("inbox-worker-complete.sh"));
	assert(failedLaunchCall?.args.includes("--status") && failedLaunchCall.args.includes("failed"), "/inbox submit should record launch failure instead of leaving scheduled items stuck");
	assert(failedLaunchCall?.args.includes("--summary-file"), "/inbox launch failure should use a private summary file");

	const queuedHarness = createTaskHarness({
		scriptResults: {
			"inbox-schedule.sh": { code: 0, stdout: JSON.stringify({ inbox_api_version: 1, kind: "inbox_schedule", action: "queued", items: [{ action: "queued", reason: "project lane already active", item: { id: "inq_submit", status: "queued", safe_title: "Build Kalshi tool", project: { id: "kalshi" } } }], launch_specs: [] }), stderr: "" },
		},
	});
	await queuedHarness.commands.get("inbox").handler("submit Build another Kalshi tool", queuedHarness.ctx);
	const queuedReceipt = queuedHarness.sentMessages.at(-1).content;
	assert(queuedReceipt.includes("scheduler action: queued"), "/inbox submit should surface queued same-project scheduler decisions");
	assert(!queuedHarness.execCalls.some((call) => call.args[0]?.endsWith("inbox-worker-start.sh")), "/inbox submit should not launch when .agents returns no launch spec");
}
