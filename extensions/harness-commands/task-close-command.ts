import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type TaskCloser = {
	closeTask(pi: ExtensionAPI, ctx: ExtensionContext, status: "completed" | "blocked", reason?: string): Promise<{ ok: boolean; lines: string[] }>;
};

function parseCloseArgs(args: string): { status?: "completed" | "blocked"; reason: string; error?: string } {
	const trimmed = args.trim();
	if (!trimmed) return { reason: "", error: "usage: /close-task completed|blocked [reason]" };
	const [rawStatus = "", ...rest] = trimmed.split(/\s+/);
	if (rawStatus !== "completed" && rawStatus !== "blocked") return { reason: "", error: "status must be completed or blocked" };
	return { status: rawStatus, reason: rest.join(" ").trim() };
}

export function registerTaskCloseCommand(pi: ExtensionAPI, taskLayer: TaskCloser): void {
	const handler = async (args: string, ctx: ExtensionContext) => {
		const parsed = parseCloseArgs(args);
		if (!parsed.status) {
			pi.sendMessage({ customType: "harness-task-close", content: ["## Task close", `- result: invalid request`, `- reason: ${parsed.error || "invalid status"}`].join("\n"), display: true });
			return;
		}
		const result = await taskLayer.closeTask(pi, ctx, parsed.status, parsed.reason);
		pi.sendMessage({ customType: "harness-task-close", content: result.lines.join("\n"), display: true });
	};
	pi.registerCommand("close-task", {
		description: "Close the active AGENTS task as completed or blocked",
		getArgumentCompletions: (prefix: string) => ["completed", "blocked"].filter((item) => item.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value })),
		handler,
	});
	pi.registerCommand("task-close", {
		description: "Alias for /close-task",
		handler,
	});
}
