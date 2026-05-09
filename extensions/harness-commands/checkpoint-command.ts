import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AmbientContextSnapshot } from "../shared/ambient-context";
import { buildStatus } from "../shared/harness-status";

type CheckpointTaskLayer = Parameters<typeof buildStatus>[2];

export function registerCheckpointCommand(pi: ExtensionAPI, taskLayer: CheckpointTaskLayer, ambientContext: () => AmbientContextSnapshot | undefined): void {
	pi.registerCommand("checkpoint", {
		description: "Create a visible session checkpoint with current harness status",
		handler: async (args, ctx) => {
			const label = args.trim() || new Date().toISOString().replace(/[:.]/g, "-");
			const leafId = ctx.sessionManager.getLeafId();
			if (leafId) pi.setLabel(leafId, `checkpoint: ${label}`);
			const content = [`## Checkpoint: ${label}`, await buildStatus(pi, ctx, taskLayer, ambientContext()), "", "Next-step note:", args.trim() || "None provided."].join("\n");
			pi.sendMessage({ customType: "harness-checkpoint", content, display: true, details: { label } });
			ctx.ui.notify(`Checkpoint created: ${label}`, "info");
		},
	});
}
