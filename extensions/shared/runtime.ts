export function isPiSubagentChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1";
}
