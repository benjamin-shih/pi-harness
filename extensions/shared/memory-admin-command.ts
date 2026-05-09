import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { forgetMemory, promoteMemory, rememberCandidate, type MemoryAdminScope } from "./memory-admin";

type MemoryScopeProvider = { ambientScope?: () => MemoryAdminScope };

export function registerMemoryAdminCommands(pi: ExtensionAPI, scopeProvider: MemoryScopeProvider): void {
	pi.registerCommand("remember", {
		description: "Explicitly create a scoped candidate memory; use --task, --project, or --global",
		handler: async (args, ctx) => {
			pi.sendMessage({ customType: "harness-memory-admin", content: await rememberCandidate(pi, ctx, args, scopeProvider.ambientScope?.() ?? {}), display: true });
		},
	});
	pi.registerCommand("promote-memory", {
		description: "Explicitly approve a candidate memory by id",
		handler: async (args, ctx) => {
			pi.sendMessage({ customType: "harness-memory-admin", content: await promoteMemory(pi, ctx, args), display: true });
		},
	});
	pi.registerCommand("forget-memory", {
		description: "Explicitly forget/deprecate a memory by id",
		handler: async (args, ctx) => {
			pi.sendMessage({ customType: "harness-memory-admin", content: await forgetMemory(pi, ctx, args), display: true });
		},
	});
}
