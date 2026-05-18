export const COMMAND_CAPABILITIES = [
	{ name: "mode", description: "Switch harness mode: fast, default, deep, readonly, full" },
	{ name: "status", description: "Show a quick bounded harness, model, tool, context, git, memory, and task status" },
	{ name: "doctor", description: "Run a read-only harness health check with memory-spine and AGENTS task diagnostics" },
	{ name: "doct", description: "Alias for /doctor" },
	{ name: "memory", description: "Show memory diagnostics; use `/memory review`, `/memory review global`, or `/memory help` for explicit admin flow" },
] as const;

export type CommandCapabilityName = typeof COMMAND_CAPABILITIES[number]["name"];

function commandCapability(name: CommandCapabilityName): typeof COMMAND_CAPABILITIES[number] {
	const capability = COMMAND_CAPABILITIES.find((candidate) => candidate.name === name);
	if (!capability) throw new Error(`unknown harness command capability: ${name}`);
	return capability;
}

export function commandDescription(name: CommandCapabilityName): string {
	return commandCapability(name).description;
}
