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
const CATPPUCCIN_GREEN = "\x1b[38;2;166;227;161m";

interface ThemeLike {
	fg(color: string, text: string): string;
}

interface RenderableMarkdown {
	render(width: number): string[];
}

interface UserMessagePatchState {
	originalRender: (width: number) => string[];
	getTheme: () => ThemeLike | undefined;
	patched: boolean;
}

function livePromptGreen(text: string): string {
	return `${CATPPUCCIN_GREEN}${text}\x1b[39m`;
}

function fitAnsi(line: string, width: number): string {
	const fitted = truncateToWidth(line, Math.max(0, width), "");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function trimAnsiRight(line: string): string {
	return line.replace(/[ \t]+((?:\x1b\[[0-?]*[ -/]*[@-~])*)$/u, "$1");
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

function getMessageMarkdown(component: unknown): RenderableMarkdown | undefined {
	return (component as { contentBox?: { children?: RenderableMarkdown[] } }).contentBox?.children?.[0];
}

function renderSentPromptBox(markdown: RenderableMarkdown, width: number, theme?: ThemeLike): string[] | undefined {
	if (width < 8) return undefined;

	const maxTextWidth = Math.max(1, width - 4);
	const contentLines = markdown.render(maxTextWidth).map(trimAnsiRight);
	if (contentLines.length === 0) return [];

	const textWidth = Math.max(1, ...contentLines.map((line) => visibleWidth(line)));
	const paddingX = 1;
	const innerWidth = textWidth + paddingX * 2;
	const border = (text: string) => theme?.fg("borderAccent", text) ?? text;
	const padContent = (line: string) => ` ${fitAnsi(line, textWidth)} `;

	return [
		border(`╭${"─".repeat(innerWidth)}╮`),
		...contentLines.map((line) => `${border("│")}${padContent(line)}${border("│")}`),
		border(`╰${"─".repeat(innerWidth)}╯`),
	];
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

	// Always replace the wrapper on reload. The original pi renderer is kept in
	// global state, but the wrapper implementation may have changed.
	state.patched = true;

	proto.render = function patchedUserMessageRender(this: unknown, width: number): string[] {
		const markdown = getMessageMarkdown(this);
		const rendered = markdown ? renderSentPromptBox(markdown, width, state!.getTheme()) : undefined;
		if (rendered === undefined) return state!.originalRender.call(this, width);
		if (rendered.length === 0) return rendered;

		rendered[0] = OSC133_ZONE_START + rendered[0];
		rendered[rendered.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + rendered[rendered.length - 1];
		return rendered;
	};
}

class RoundedPromptEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { paddingX: 1 });
		this.borderColor = livePromptGreen;
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
