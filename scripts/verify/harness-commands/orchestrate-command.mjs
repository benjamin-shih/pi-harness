import { existsSync } from "node:fs";
import { assert, createTaskHarness, orchestrationPlanPayload } from "./support.mjs";

function createEventBus() {
	const handlers = new Map();
	const requests = [];
	return {
		requests,
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => handlers.set(event, handlers.get(event).filter((candidate) => candidate !== handler));
		},
		emit(event, data) {
			if (event === "subagent:slash:request") {
				requests.push(data);
				for (const handler of handlers.get("subagent:slash:response") ?? []) {
					handler({ requestId: data.requestId, isError: false, result: { details: { asyncId: `async-${requests.length}` } } });
				}
				return;
			}
			for (const handler of handlers.get(event) ?? []) handler(data);
		},
	};
}

export async function runOrchestrateCommandTests() {
	const bus = createEventBus();
	const harness = createTaskHarness({ eventBus: bus });
	assert(harness.commands.has("orchestrate"), "/orchestrate should be registered in parent harness mode");

	await harness.commands.get("orchestrate").handler("Build feature with private phrase", harness.ctx);
	const preview = harness.sentMessages.at(-1).content;
	assert(preview.includes("## Orchestration plan"), "/orchestrate should render a plan preview by default");
	assert(preview.includes("engineering_scout"), "/orchestrate preview should include bounded role metadata");
	assert(!preview.includes("private phrase"), "/orchestrate preview should not echo raw request text");
	assert(bus.requests.length === 0, "/orchestrate preview should not launch subagents");
	const planCall = harness.execCalls.find((call) => call.args[0]?.endsWith("orchestration-plan.sh"));
	assert(planCall?.args.includes("--prompt-file"), "/orchestrate should pass request text through a private prompt file");
	assert(!planCall?.args.includes("Build feature with private phrase"), "/orchestrate should not pass raw request text through argv");
	const requestPath = planCall?.args[planCall.args.indexOf("--prompt-file") + 1];
	assert(requestPath && !existsSync(requestPath), "/orchestrate should clean up the private plan prompt file");

	await harness.commands.get("orchestrate").handler("run Build feature with private phrase", harness.ctx);
	const runReceipt = harness.sentMessages.at(-1).content;
	assert(runReceipt.includes("started=2"), "/orchestrate run should launch read-only helper roles");
	assert(runReceipt.includes("deferred=1"), "/orchestrate run should defer write-capable workers by default");
	assert(!runReceipt.includes("private phrase"), "/orchestrate run receipt should not echo raw request text");
	assert(bus.requests.length === 2, "/orchestrate run should launch only read-only roles by default");
	assert(bus.requests.every((request) => request.params.agent !== "worker"), "/orchestrate run should skip worker unless --workers is explicit");

	await harness.commands.get("orchestrate").handler("run --workers Build feature with private phrase", harness.ctx);
	const workerReceipt = harness.sentMessages.at(-1).content;
	assert(workerReceipt.includes("started=3"), "/orchestrate run --workers should launch read-only roles plus bounded worker");
	assert(workerReceipt.includes("workers included by explicit --workers"), "/orchestrate should report explicit worker inclusion");
	const workerRequest = bus.requests.find((request) => request.params.agent === "worker");
	assert(workerRequest, "/orchestrate run --workers should send a worker subagent request");
	assert(workerRequest.params.task.includes("bounded write-capable worker handoff"), "worker task should include bounded write handoff guardrails");
	assert(workerRequest.params.task.includes("Build feature with private phrase"), "worker task should receive the private request context needed to do the task");

	const unsafeHarness = createTaskHarness({ orchestrationPlanPayload: orchestrationPlanPayload({ read_only: false }) });
	await unsafeHarness.commands.get("orchestrate").handler("run Unsafe plan request", unsafeHarness.ctx);
	const unsafeReceipt = unsafeHarness.sentMessages.at(-1).content;
	assert(unsafeReceipt.includes("plan failed read-only safety preflight"), "/orchestrate should reject non-read-only plans before preview or launch");

	const unsafeWorkerBus = createEventBus();
	const unsafeWorkerPlan = orchestrationPlanPayload({ role_launch_plan: orchestrationPlanPayload().role_launch_plan.map((role) => role.agent === "worker" ? { ...role, requires_confirmation: false } : role) });
	const unsafeWorkerHarness = createTaskHarness({ eventBus: unsafeWorkerBus, orchestrationPlanPayload: unsafeWorkerPlan });
	await unsafeWorkerHarness.commands.get("orchestrate").handler("run --workers Unsafe worker request", unsafeWorkerHarness.ctx);
	const unsafeWorkerReceipt = unsafeWorkerHarness.sentMessages.at(-1).content;
	assert(unsafeWorkerReceipt.includes("failed=1"), "/orchestrate should fail unsafe worker roles instead of launching them");
	assert(!unsafeWorkerBus.requests.some((request) => request.params.agent === "worker"), "/orchestrate should not launch write roles without bounded confirmation metadata");

	const readOnlyPlan = orchestrationPlanPayload({
		autonomy: { mode: "confirm", read_only_auto_run_eligible: true, confirmation_required: false, execute_low_risk_policy: "future adapter may auto-run only read-only role specs when explicitly configured", dashboard_mutations: false },
		role_launch_plan: orchestrationPlanPayload().role_launch_plan.filter((role) => !role.may_write),
	});
	const readOnlyBus = createEventBus();
	const readOnlyHarness = createTaskHarness({ eventBus: readOnlyBus, orchestrationPlanPayload: readOnlyPlan });
	await readOnlyHarness.commands.get("orchestrate").handler("run Research safe read-only request", readOnlyHarness.ctx);
	const readOnlyReceipt = readOnlyHarness.sentMessages.at(-1).content;
	assert(readOnlyReceipt.includes("started=2"), "/orchestrate run should launch all roles when the plan is read-only");
	assert(!readOnlyReceipt.includes("safe read-only request"), "/orchestrate read-only receipt should not echo raw request text");
}
