import {
	CustomEditor,
	UserMessageComponent,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@mariozechner/pi-tui";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const USER_MESSAGE_PATCH_KEY = "__benPiHarnessRoundedUserMessagePatch";

interface UserMessagePatchState {
	originalRender: (width: number) => string[];
	getTheme: () => { fg(color: string, text: string): string } | undefined;
	patched: boolean;
}

function fitAnsi(line: string, width: number): string {
	const fitted = truncateToWidth(line, Math.max(0, width), "");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function stripControl(line: string): string {
	return line
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isEditorBorderLine(line: string, width: number): boolean {
	if (visibleWidth(line) !== width) return false;
	return /^[─\s↑↓0-9more]+$/.test(stripControl(line));
}

function renderRoundedLine(
	line: string,
	innerWidth: number,
	border: (text: string) => string,
	position: "top" | "middle" | "bottom",
): string {
	const body = fitAnsi(line, innerWidth);
	if (position === "top") return `${border("╭")}${body}${border("╮")}`;
	if (position === "bottom") return `${border("╰")}${body}${border("╯")}`;
	return `${border("│")}${body}${border("│")}`;
}

function patchUserMessageComponent(getTheme: UserMessagePatchState["getTheme"]): void {
	const globalStore = globalThis as Record<string, unknown>;
	const proto = UserMessageComponent.prototype as unknown as { render(width: number): string[] };
	let state = globalStore[USER_MESSAGE_PATCH_KEY] as UserMessagePatchState | undefined;

	if (!state) {
		state = { originalRender: proto.render, getTheme, patched: false };
		globalStore[USER_MESSAGE_PATCH_KEY] = state;
	}
	state.getTheme = getTheme;

	if (state.patched) return;
	state.patched = true;

	proto.render = function patchedUserMessageRender(this: unknown, width: number): string[] {
		if (width < 4) return state!.originalRender.call(this, width);

		const innerWidth = Math.max(1, width - 2);
		const lines = state!.originalRender.call(this, innerWidth);
		if (lines.length === 0) return lines;

		const first = lines[0] ?? "";
		const last = lines[lines.length - 1] ?? "";
		const hasStart = first.startsWith(OSC133_ZONE_START);
		const hasEnd = last.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL);
		if (hasStart) lines[0] = first.slice(OSC133_ZONE_START.length);
		if (hasEnd) lines[lines.length - 1] = last.slice((OSC133_ZONE_END + OSC133_ZONE_FINAL).length);

		const theme = state!.getTheme();
		const border = (text: string) => theme?.fg("borderMuted", text) ?? text;
		const rendered = [
			renderRoundedLine("─".repeat(innerWidth), innerWidth, border, "top"),
			...lines.map((line) => renderRoundedLine(line, innerWidth, border, "middle")),
			renderRoundedLine("─".repeat(innerWidth), innerWidth, border, "bottom"),
		];

		if (hasStart) rendered[0] = OSC133_ZONE_START + rendered[0];
		if (hasEnd) rendered[rendered.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + rendered[rendered.length - 1];
		return rendered;
	};
}

class RoundedPromptEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { paddingX: 1 });
	}

	render(width: number): string[] {
		if (width < 4) return super.render(width);

		const innerWidth = Math.max(1, width - 2);
		const lines = super.render(innerWidth);
		if (lines.length === 0) return lines;

		const borderIndices = lines
			.map((line, index) => (isEditorBorderLine(line, innerWidth) ? index : -1))
			.filter((index) => index >= 0);
		const topIndex = borderIndices[0] ?? 0;
		const bottomIndex = borderIndices.at(-1) ?? lines.length - 1;
		const border = (text: string) => this.borderColor(text);
		const rendered: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (i === topIndex) {
				rendered.push(renderRoundedLine(line, innerWidth, border, "top"));
				continue;
			}
			if (i === bottomIndex) continue;
			rendered.push(renderRoundedLine(line, innerWidth, border, "middle"));
		}

		const bottomLine = lines[bottomIndex] ?? "─".repeat(innerWidth);
		rendered.push(renderRoundedLine(bottomLine, innerWidth, border, "bottom"));
		return rendered;
	}
}

export default function aestheticPolish(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		patchUserMessageComponent(() => ctx.ui.theme);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new RoundedPromptEditor(tui, theme, keybindings));
	});
}
