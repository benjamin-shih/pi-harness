import { existsSync } from "node:fs";
import { assert, createTaskHarness } from "./support.mjs";

export async function runInboxCommandTests() {
	const harness = createTaskHarness({});
	assert(harness.commands.has("inbox"), "/inbox should be registered in parent harness mode");
	await harness.commands.get("inbox").handler("", harness.ctx);
	const listText = harness.sentMessages.at(-1).content;
	assert(listText.includes("## Async inbox"), "/inbox should render inbox status");
	assert(listText.includes("statuses: queued=1"), "/inbox should summarize statuses");
	assert(listText.includes("Build Kalshi tool"), "/inbox should render bounded safe titles");

	await harness.commands.get("inbox").handler("submit Build Kalshi tool with token=abcdef1234567890", harness.ctx);
	const submitText = harness.sentMessages.at(-1).content;
	assert(submitText.includes("## Inbox receipt"), "/inbox submit should render a receipt");
	assert(submitText.includes("result: queued"), "/inbox submit should report queued status");
	assert(!submitText.includes("abcdef1234567890"), "/inbox submit should not echo sensitive request text");
	const enqueueCall = harness.execCalls.find((call) => call.args[0]?.endsWith("inbox-enqueue.sh"));
	assert(enqueueCall?.args.includes("--request-file"), "/inbox submit should pass request text through a private temp file");
	assert(!enqueueCall?.args.includes("Build Kalshi tool with token=abcdef1234567890"), "/inbox submit argv should not include raw request text");
	const requestFile = enqueueCall?.args[enqueueCall.args.indexOf("--request-file") + 1];
	assert(requestFile && !existsSync(requestFile), "/inbox submit should clean up the private request file");
}
