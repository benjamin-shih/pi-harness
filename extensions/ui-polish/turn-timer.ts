import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

const TIMER_STATUS_KEY = "turn-timer";
const TIMER_UPDATE_MS = 1_000;
const TIMER_FOOTER_PREFIX = "Elapsed wall time:";

export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
}

export function appendElapsedToAssistantMessage(message: AssistantMessage, elapsed: string): AssistantMessage {
	if (message.content.some((block) => block.type === "text" && block.text.includes(TIMER_FOOTER_PREFIX))) return message;
	const elapsedBlock = { type: "text" as const, text: `\n\n_${TIMER_FOOTER_PREFIX} ${elapsed}_` };
	return { ...message, content: [...message.content, elapsedBlock] };
}

function setTimerUi(ctx: ExtensionContext, startMs: number): void {
	const elapsed = formatElapsed(Date.now() - startMs);
	ctx.ui.setWorkingMessage(`Working · ${elapsed} elapsed`);
	ctx.ui.setStatus(TIMER_STATUS_KEY, ctx.ui.theme.fg("dim", `elapsed:${elapsed}`));
}

function clearTimerUi(ctx: ExtensionContext, elapsed: string): void {
	ctx.ui.setWorkingMessage();
	ctx.ui.setStatus(TIMER_STATUS_KEY, ctx.ui.theme.fg("dim", `last:${elapsed}`));
}

export function installTurnTimer(pi: ExtensionAPI): void {
	let agentStartMs: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	function stopTimer(): void {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	pi.on("agent_start", async (_event, ctx) => {
		stopTimer();
		agentStartMs = Date.now();
		if (!ctx.hasUI) return;
		setTimerUi(ctx, agentStartMs);
		timer = setInterval(() => {
			if (agentStartMs !== undefined) setTimerUi(ctx, agentStartMs);
		}, TIMER_UPDATE_MS);
	});

	pi.on("message_end", async (event) => {
		if (agentStartMs === undefined || !isAssistantMessage(event.message) || event.message.stopReason === "toolUse") return;
		return { message: appendElapsedToAssistantMessage(event.message, formatElapsed(Date.now() - agentStartMs)) };
	});

	pi.on("agent_end", async (_event, ctx) => {
		const elapsed = formatElapsed(agentStartMs === undefined ? 0 : Date.now() - agentStartMs);
		stopTimer();
		agentStartMs = undefined;
		if (ctx.hasUI) clearTimerUi(ctx, elapsed);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		agentStartMs = undefined;
		if (ctx.hasUI) {
			ctx.ui.setWorkingMessage();
			ctx.ui.setStatus(TIMER_STATUS_KEY, undefined);
		}
	});
}
