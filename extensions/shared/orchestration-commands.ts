import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildOrchestrationDecisionState, formatRunCard, type OrchestrationDecisionState } from "./orchestration-guidance";

type OrchestrationTaskLayer = {
	orchestrationSummaryLines(): string[];
	recordOrchestrationChosen(pi: ExtensionAPI, ctx: ExtensionContext, topology: string, reason?: string): Promise<boolean>;
};

export function registerRunCardCommand(pi: ExtensionAPI, taskLayer: Pick<OrchestrationTaskLayer, "orchestrationSummaryLines">, latestDecision: () => OrchestrationDecisionState | undefined): void {
	pi.registerCommand("run-card", {
		description: "Show the latest orchestration run card, or decide provided text without executing it",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const fallbackPrompt = "Summarize current project status";
			const decision = prompt ? await buildOrchestrationDecisionState(pi, ctx.cwd, prompt) : (latestDecision() ?? await buildOrchestrationDecisionState(pi, ctx.cwd, fallbackPrompt));
			const fallbackNote = !prompt && !latestDecision() ? "\n\n- source: generated current-project fallback because no cached turn decision exists" : "";
			const tracking = `\n\n## Chosen vs recommended\n${taskLayer.orchestrationSummaryLines().join("\n")}`;
			const content = decision ? `${formatRunCard(decision)}${tracking}${fallbackNote}` : ["## Run card", "- status: unavailable", "- hint: pass prompt text to `/run-card ...`"].join("\n");
			pi.sendMessage({ customType: "harness-run-card", content, display: true });
		},
	});
}

export function registerChooseTopologyCommand(pi: ExtensionAPI, taskLayer: OrchestrationTaskLayer): void {
	pi.registerCommand("choose-topology", {
		description: "Explicitly record the orchestration topology the main agent chose for the active task",
		handler: async (args, ctx) => {
			const [topology, ...reasonParts] = args.trim().split(/\s+/).filter(Boolean);
			const recorded = topology ? await taskLayer.recordOrchestrationChosen(pi, ctx, topology, reasonParts.join(" ") || "explicit /choose-topology command") : false;
			pi.sendMessage({ customType: "harness-orchestration", content: ["## Orchestration choice", `- topology: ${topology || "not supplied"}`, `- recorded: ${recorded ? "yes" : "no active task or invalid topology"}`, "- mode: explicit task-event tracking only; no execution launched"].join("\n"), display: true });
		},
	});
}
