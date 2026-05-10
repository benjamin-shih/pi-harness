import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function queueFollowUpAfterCurrentAgent(pi: Pick<ExtensionAPI, "sendUserMessage">, content: string): void {
	// agent_end fires before the core Agent clears activeRun. Deferring avoids the
	// transient "Agent is already processing a prompt" error from immediate prompts.
	setTimeout(() => pi.sendUserMessage(content, { deliverAs: "followUp" }), 0);
}
