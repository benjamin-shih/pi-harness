import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";

export const TITLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TITLE_SPINNER_MS = 120;

export function piTitle(cwd: string, sessionName?: string, frame?: string): string {
	const base = path.basename(cwd) || cwd;
	const prefix = frame ? `${frame} ` : "";
	return sessionName ? `${prefix}π - ${sessionName} - ${base}` : `${prefix}π - ${base}`;
}

function sessionName(pi: ExtensionAPI): string | undefined {
	const maybe = pi as ExtensionAPI & { getSessionName?: () => string | undefined };
	return maybe.getSessionName?.();
}

function setIdleTitle(pi: ExtensionAPI, ctx: ExtensionContext): void {
	ctx.ui.setTitle(piTitle(ctx.cwd, sessionName(pi)));
}

export function installTitlebarSpinner(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let frameIndex = 0;

	function stop(ctx: ExtensionContext): void {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		frameIndex = 0;
		setIdleTitle(pi, ctx);
	}

	function start(ctx: ExtensionContext): void {
		stop(ctx);
		timer = setInterval(() => {
			const frame = TITLE_SPINNER_FRAMES[frameIndex % TITLE_SPINNER_FRAMES.length];
			ctx.ui.setTitle(piTitle(ctx.cwd, sessionName(pi), frame));
			frameIndex += 1;
		}, TITLE_SPINNER_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		setIdleTitle(pi, ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		start(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stop(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
	});
}
