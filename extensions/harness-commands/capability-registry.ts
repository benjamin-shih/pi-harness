import type { HarnessRuntimeConfig } from "../shared/harness-profile";

export type CommandCapabilityGate = "always" | "asyncInbox" | "controlPlaneSurfaces";

export type CommandCapability = {
	name: string;
	description: string;
	gate: CommandCapabilityGate;
	coldPath: boolean;
};

export const COMMAND_CAPABILITIES = [
	{ name: "mode", description: "Switch harness mode: fast, default, deep, readonly, full", gate: "always", coldPath: false },
	{ name: "status", description: "Show a quick bounded harness, model, tool, context, git, memory, and task status", gate: "always", coldPath: false },
	{ name: "doctor", description: "Run a read-only harness health check with memory-spine and AGENTS task diagnostics", gate: "always", coldPath: true },
	{ name: "doct", description: "Alias for /doctor", gate: "always", coldPath: true },
	{ name: "memory", description: "Show memory diagnostics; use `/memory review`, `/memory review global`, or `/memory help` for explicit admin flow", gate: "always", coldPath: false },
	{ name: "run-card", description: "Show the latest orchestration run card, or decide provided text without executing it", gate: "controlPlaneSurfaces", coldPath: true },
	{ name: "choose-topology", description: "Explicitly record the orchestration topology the main agent chose for the active task", gate: "controlPlaneSurfaces", coldPath: true },
	{ name: "control-center", description: "Show the read-only local Agent Control Center", gate: "controlPlaneSurfaces", coldPath: true },
	{ name: "inbox", description: "Show and tick the shared .agents async inbox", gate: "asyncInbox", coldPath: true },
] as const satisfies readonly CommandCapability[];

export type CommandCapabilityName = typeof COMMAND_CAPABILITIES[number]["name"];

export function commandCapability(name: CommandCapabilityName): CommandCapability {
	const capability = COMMAND_CAPABILITIES.find((candidate) => candidate.name === name);
	if (!capability) throw new Error(`unknown harness command capability: ${name}`);
	return capability;
}

export function commandDescription(name: CommandCapabilityName): string {
	return commandCapability(name).description;
}

export function commandCapabilityEnabled(capability: CommandCapability, config: HarnessRuntimeConfig): boolean {
	if (capability.gate === "always") return true;
	return Boolean(config[capability.gate]);
}

export function enabledCommandCapabilities(config: HarnessRuntimeConfig): CommandCapability[] {
	return COMMAND_CAPABILITIES.filter((capability) => commandCapabilityEnabled(capability, config));
}

export function enabledProfileGatedCommandCapabilities(config: HarnessRuntimeConfig): CommandCapability[] {
	return enabledCommandCapabilities(config).filter((capability) => capability.gate !== "always");
}
