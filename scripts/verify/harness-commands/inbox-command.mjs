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
	assert(receipt.includes("scheduler action: launch"), "/inbox submit should ask .agents tick/scheduler for the item action");
	assert(receipt.includes("worker launch: started; worker launch accepted"), "/inbox submit should execute returned .agents launch specs through the subagent bridge");
	assert(!receipt.includes("private details"), "/inbox receipt should not echo raw request text");
	assert(slashRequest?.params?.async === true, "/inbox worker bridge should preserve async launch params from .agents");
	assert(slashRequest?.params?.task?.includes("Private request file:"), "/inbox worker launch should point at the private request file");
	assert(!slashRequest?.params?.task?.includes("private details"), "/inbox worker launch should not include raw request text");

	const tickCall = harness.execCalls.find((call) => call.args[0]?.endsWith("inbox-tick.sh") && call.args.includes("--execute"));
	assert(tickCall, "/inbox submit should bridge through .agents inbox-tick --execute");
	assert(!harness.execCalls.some((call) => call.args[0]?.endsWith("inbox-schedule.sh")), "/inbox submit should not bypass tick with direct scheduler calls");
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
	assert(completeCall.args.includes("--backend-run-id") && completeCall.args.includes("async-1"), "/inbox completion should be durable by persisted backend run id");
	assert(completeCall.args.includes("--summary-file"), "/inbox completion should pass worker summary through a private file");
	assert(!completeCall.args.includes("Completed successfully"), "/inbox completion should not pass raw worker output through argv");
	const summaryPath = completeCall.args[completeCall.args.indexOf("--summary-file") + 1];
	assert(summaryPath && !existsSync(summaryPath), "/inbox completion should clean up the private summary file");

	const noBridgeHarness = createTaskHarness({ eventBus: {} });
	await noBridgeHarness.commands.get("inbox").handler("submit Build Kalshi tool", noBridgeHarness.ctx);
	const noBridgeReceipt = noBridgeHarness.sentMessages.at(-1).content;
	assert(noBridgeReceipt.includes("worker launch: degraded; worker bridge unavailable"), "/inbox submit should report unavailable worker bridge without pretending work launched");
	const failedLaunchCall = noBridgeHarness.execCalls.find((call) => call.args[0]?.endsWith("inbox-worker-complete.sh"));
	assert(failedLaunchCall?.args.includes("--status") && failedLaunchCall.args.includes("failed"), "/inbox submit should record launch failure instead of leaving scheduled items stuck");
	assert(failedLaunchCall?.args.includes("--summary-file"), "/inbox launch failure should use a private summary file");

	const errorBus = createEventBus();
	errorBus.on("subagent:slash:request", (data) => errorBus.emit("subagent:slash:response", { requestId: data.requestId, isError: true, errorText: "raw private bridge stderr" }));
	const errorHarness = createTaskHarness({ eventBus: errorBus });
	await errorHarness.commands.get("inbox").handler("submit Build Kalshi tool", errorHarness.ctx);
	const errorReceipt = errorHarness.sentMessages.at(-1).content;
	assert(errorReceipt.includes("worker launch: failed; subagent bridge returned an error"), "/inbox submit should surface generic bridge errors");
	assert(!errorReceipt.includes("raw private bridge stderr"), "/inbox submit should not expose raw bridge errors");

	const throwingBus = { on: () => {}, emit: () => { throw new Error("raw private thrown bridge error"); } };
	const throwingHarness = createTaskHarness({ eventBus: throwingBus });
	await throwingHarness.commands.get("inbox").handler("submit Build Kalshi tool", throwingHarness.ctx);
	const throwingReceipt = throwingHarness.sentMessages.at(-1).content;
	assert(throwingReceipt.includes("worker launch: failed; worker bridge launch failed"), "/inbox submit should catch bridge emit exceptions");
	assert(!throwingReceipt.includes("raw private thrown bridge error"), "/inbox submit should not expose thrown bridge errors");

	const startFailureBus = createEventBus();
	startFailureBus.on("subagent:slash:request", (data) => startFailureBus.emit("subagent:slash:response", { requestId: data.requestId, isError: false, result: { details: { asyncId: "async-start-fail" } } }));
	const startFailureHarness = createTaskHarness({ eventBus: startFailureBus, scriptResults: { "inbox-worker-start.sh": { code: 1, stdout: "", stderr: "raw private lifecycle stderr" } } });
	await startFailureHarness.commands.get("inbox").handler("submit Build Kalshi tool", startFailureHarness.ctx);
	const startFailureReceipt = startFailureHarness.sentMessages.at(-1).content;
	assert(startFailureReceipt.includes("worker launch: degraded; worker lifecycle recording failed"), "/inbox submit should report lifecycle-record failures generically");
	assert(!startFailureReceipt.includes("raw private lifecycle stderr"), "/inbox submit should not expose lifecycle stderr");
	assert(startFailureHarness.execCalls.some((call) => call.args[0]?.endsWith("inbox-worker-complete.sh") && call.args.includes("blocked")), "/inbox submit should record lifecycle-record failure as blocked");

	await harness.commands.get("inbox").handler("tick", harness.ctx);
	const tickPreview = harness.sentMessages.at(-1).content;
	assert(tickPreview.includes("tick mode: dry-run"), "/inbox tick should preview without executing scheduler mutation");
	const dryRunTickCall = harness.execCalls.find((call) => call.args[0]?.endsWith("inbox-tick.sh") && call.args.includes("--dry-run"));
	assert(dryRunTickCall, "/inbox tick should call .agents inbox-tick --dry-run");

	await harness.commands.get("inbox").handler("schedule", harness.ctx);
	const scheduleReceipt = harness.sentMessages.at(-1).content;
	assert(scheduleReceipt.includes("tick mode: execute"), "/inbox schedule should execute a supervised tick");
	assert(scheduleReceipt.includes("worker launches by .agents: no"), "/inbox schedule should show that .agents did not launch workers itself");

	const tickFailureHarness = createTaskHarness({ scriptResults: { "inbox-tick.sh": { code: 2, stdout: "", stderr: "raw private scheduler stderr" } } });
	await tickFailureHarness.commands.get("inbox").handler("submit Build Kalshi tool", tickFailureHarness.ctx);
	const tickFailureReceipt = tickFailureHarness.sentMessages.at(-1).content;
	assert(tickFailureReceipt.includes("worker launch: tick failed: exit 2"), "/inbox submit should report tick failures after enqueue");
	assert(!tickFailureReceipt.includes("raw private scheduler stderr"), "/inbox submit should not expose tick stderr");

	const queuedHarness = createTaskHarness({
		scriptResults: {
			"inbox-tick.sh": { code: 0, stdout: JSON.stringify({ inbox_api_version: 1, kind: "inbox_tick", dry_run: false, mutating_actions: true, worker_launches: false, reconcile: { updated: 0 }, summary: { checked: 1, launchable_count: 0, launch_spec_count: 0, queued_count: 1, needs_user_count: 0, noop_count: 0 }, schedule: { inbox_api_version: 1, kind: "inbox_schedule", action: "queued", items: [{ action: "queued", reason: "project lane already active", item: { id: "inq_submit", status: "queued", safe_title: "Build Kalshi tool", project: { id: "kalshi" } } }], launch_specs: [] }, launch_specs: [] }), stderr: "" },
		},
	});
	await queuedHarness.commands.get("inbox").handler("submit Build another Kalshi tool", queuedHarness.ctx);
	const queuedReceipt = queuedHarness.sentMessages.at(-1).content;
	assert(queuedReceipt.includes("scheduler action: queued"), "/inbox submit should surface queued same-project scheduler decisions");
	assert(!queuedHarness.execCalls.some((call) => call.args[0]?.endsWith("inbox-worker-start.sh")), "/inbox submit should not launch when .agents returns no launch spec");
}
