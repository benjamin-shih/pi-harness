import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Image, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WIDGET_KEY = "latex-preview";
const MAX_RENDERED_SNIPPETS = 10;
const LATEX_TIMEOUT_MS = 12_000;
const PREVIEW_AUTO_CLEAR_MS = 5 * 60_000;
const MAX_MATH_WIDTH_CELLS = 72;
const MIN_MATH_WIDTH_CELLS = 8;
const PREVIEW_PX_PER_CELL = 18;
const RENDER_INLINE_MATH_IN_CONTEXT = false;
const DISPLAY_ENVIRONMENT = /^(equation\*?|align\*?|gather\*?|multline\*?|flalign\*?|alignat\*?)$/;
const MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|flalign\*?|alignat\*?)\}[\s\S]*?\\end\{\4\})|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^\n$]{1,220}?)(?<!\\)\$/g;

export type LatexSnippet = {
	tex: string;
	display: boolean;
	delimiter: string;
};

type PngDimensions = {
	widthPx: number;
	heightPx: number;
};

type RenderResult = {
	pngBase64?: string;
	dimensions?: PngDimensions;
	error?: string;
};

type RenderedMath = RenderResult & {
	display: boolean;
	delimiter: string;
};

type PreviewBlock =
	| { type: "markdown"; text: string }
	| { type: "math"; math: RenderedMath };

type PreviewPayload = {
	blocks: PreviewBlock[];
	truncated: boolean;
};

type AssistantLike = {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	stopReason?: string;
};

function blankMarkdownCode(text: string): string {
	return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

function collectMatches(source: string, regex: RegExp, display: boolean, delimiter: string, wholeMatch = false): LatexSnippet[] {
	const snippets: LatexSnippet[] = [];
	for (const match of source.matchAll(regex)) {
		const tex = (wholeMatch ? match[0] : match[1])?.trim();
		if (!tex) continue;
		snippets.push({ tex, display, delimiter });
	}
	return snippets;
}

function normalizeSnippetKey(snippet: LatexSnippet): string {
	return `${snippet.display ? "display" : "inline"}:${snippet.tex.replace(/\s+/g, " ").trim()}`;
}

function isUsefulInlineMath(tex: string): boolean {
	if (tex.length > 220) return false;
	if (/^\d+(?:\.\d{2})?$/.test(tex.trim())) return false;
	return /[\\_^{}=<>]|\b(?:frac|sum|int|prod|lim|sqrt|mathbb|operatorname|exp|log|Pr|Var|Cov)\b/.test(tex) || tex.length > 2;
}

function snippetFromRegexMatch(match: RegExpMatchArray): LatexSnippet | undefined {
	if (match[1]) return { tex: match[1].trim(), display: true, delimiter: "$$" };
	if (match[2]) return { tex: match[2].trim(), display: true, delimiter: "\\[" };
	if (match[3]) return { tex: match[3].trim(), display: true, delimiter: "environment" };
	if (match[5]?.trim() && isUsefulInlineMath(match[5].trim())) {
		return { tex: match[5].trim(), display: false, delimiter: "\\(" };
	}
	if (match[6]?.trim() && isUsefulInlineMath(match[6].trim())) {
		return { tex: match[6].trim(), display: false, delimiter: "$" };
	}
	return undefined;
}

export function extractLatexSnippets(text: string, maxSnippets = MAX_RENDERED_SNIPPETS): { snippets: LatexSnippet[]; truncated: boolean } {
	const source = blankMarkdownCode(text);
	const displayPatterns: Array<[RegExp, string, boolean?]> = [
		[/\$\$([\s\S]+?)\$\$/g, "$$"],
		[/\\\[([\s\S]+?)\\\]/g, "\\["],
		[/\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|flalign\*?|alignat\*?)\}[\s\S]*?\\end\{\1\}/g, "environment", true],
	];

	const collected: LatexSnippet[] = [];
	let inlineSource = source;
	for (const [regex, delimiter, wholeMatch] of displayPatterns) {
		collected.push(...collectMatches(source, regex, true, delimiter, Boolean(wholeMatch)));
		inlineSource = inlineSource.replace(regex, " ");
	}

	collected.push(...collectMatches(inlineSource, /\\\(([\s\S]+?)\\\)/g, false, "\\("));
	collected.push(
		...collectMatches(inlineSource, /(?<!\\)\$([^\n$]{1,220}?)(?<!\\)\$/g, false, "$").filter((snippet) =>
			isUsefulInlineMath(snippet.tex),
		),
	);

	const seen = new Set<string>();
	const unique: LatexSnippet[] = [];
	for (const snippet of collected) {
		const key = normalizeSnippetKey(snippet);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(snippet);
	}

	return { snippets: unique.slice(0, maxSnippets), truncated: unique.length > maxSnippets };
}

function displayBody(tex: string): string {
	const env = tex.match(/^\\begin\{([^}]+)\}/)?.[1];
	if (env && DISPLAY_ENVIRONMENT.test(env)) return tex;
	return `\\[\n${tex}\n\\]`;
}

function latexDocument(snippet: LatexSnippet): string {
	const body = snippet.display ? displayBody(snippet.tex) : `$\\displaystyle ${snippet.tex}$`;
	return String.raw`\documentclass{article}
\usepackage{amsmath,amssymb,mathtools,bm,bbm,dsfont,braket,cancel,physics}
\usepackage[active,tightpage,displaymath,textmath]{preview}
\PreviewBorder=3pt
\usepackage{xcolor}
\providecommand{\Var}{\operatorname{Var}}
\providecommand{\Cov}{\operatorname{Cov}}
\providecommand{\Corr}{\operatorname{Corr}}
\providecommand{\Tr}{\operatorname{Tr}}
\providecommand{\rank}{\operatorname{rank}}
\providecommand{\diag}{\operatorname{diag}}
\providecommand{\argmax}{\operatorname*{arg\,max}}
\providecommand{\argmin}{\operatorname*{arg\,min}}
\def\E{\mathbb{E}}
\def\P{\mathbb{P}}
\def\R{\mathbb{R}}
\def\N{\mathbb{N}}
\def\Z{\mathbb{Z}}
\def\C{\mathbb{C}}
\def\1{\mathbf{1}}
\pagecolor{white}
\pagestyle{empty}
\begin{document}
\color{black}
${body}
\end{document}
`;
}

function errorSummary(error: unknown): string {
	const anyError = error as { message?: string; stdout?: string | Buffer; stderr?: string | Buffer };
	const output = [anyError.stdout, anyError.stderr, anyError.message]
		.filter(Boolean)
		.map((part) => String(part))
		.join("\n");
	const latexError = output.match(/^! .+$/m)?.[0];
	return (latexError ?? output.split(/\r?\n/).find((line) => line.trim()) ?? "LaTeX render failed").slice(0, 240);
}

function pngDimensions(buffer: Buffer): PngDimensions | undefined {
	if (buffer.length < 24) return undefined;
	if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return undefined;
	return { widthPx: buffer.readUInt32BE(16), heightPx: buffer.readUInt32BE(20) };
}

export async function renderLatexSnippet(snippet: LatexSnippet): Promise<RenderResult> {
	const workdir = await mkdtemp(join(tmpdir(), "pi-latex-preview-"));
	try {
		await writeFile(join(workdir, "formula.tex"), latexDocument(snippet), "utf8");
		await execFileAsync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "formula.tex"], {
			cwd: workdir,
			timeout: LATEX_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		await execFileAsync("pdftocairo", ["-png", "-singlefile", "-r", "220", "formula.pdf", "formula"], {
			cwd: workdir,
			timeout: LATEX_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		const png = await readFile(join(workdir, "formula.png"));
		return { pngBase64: png.toString("base64"), dimensions: pngDimensions(png) };
	} catch (error) {
		return { error: errorSummary(error) };
	} finally {
		await rm(workdir, { recursive: true, force: true });
	}
}

function assistantText(message: AssistantLike | undefined): string | undefined {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	const text = message.content
		.filter((part) => part.type === "text" && part.text?.trim())
		.map((part) => part.text)
		.join("\n\n")
		.trim();
	return text || undefined;
}

function pushMarkdown(blocks: PreviewBlock[], text: string): void {
	if (!text.trim()) return;
	const previous = blocks.at(-1);
	if (previous?.type === "markdown") {
		previous.text += text;
	} else {
		blocks.push({ type: "markdown", text });
	}
}

async function buildPreviewPayload(text: string): Promise<PreviewPayload | undefined> {
	const blocks: PreviewBlock[] = [];
	let cursor = 0;
	let renderedCount = 0;
	let truncated = false;

	for (const match of text.matchAll(MATH_PATTERN)) {
		const start = match.index ?? 0;
		const raw = match[0];
		const snippet = snippetFromRegexMatch(match);
		if (!snippet) continue;
		if (!snippet.display && !RENDER_INLINE_MATH_IN_CONTEXT) continue;
		if (renderedCount >= MAX_RENDERED_SNIPPETS) {
			truncated = true;
			break;
		}

		pushMarkdown(blocks, text.slice(cursor, start));
		const result = await renderLatexSnippet(snippet);
		blocks.push({ type: "math", math: { display: snippet.display, delimiter: snippet.delimiter, ...result } });
		cursor = start + raw.length;
		renderedCount++;
	}

	if (renderedCount === 0) return undefined;
	pushMarkdown(blocks, text.slice(cursor));
	return { blocks, truncated };
}

function targetWidthCells(math: RenderedMath): number {
	const widthPx = math.dimensions?.widthPx;
	if (!widthPx) return 48;
	return Math.max(MIN_MATH_WIDTH_CELLS, Math.min(MAX_MATH_WIDTH_CELLS, Math.ceil(widthPx / PREVIEW_PX_PER_CELL)));
}

function addMathImage(container: Container, math: RenderedMath, index: number, theme: Theme): void {
	if (math.pngBase64) {
		container.addChild(
			new Image(
				math.pngBase64,
				"image/png",
				{ fallbackColor: (text: string) => theme.fg("muted", text) },
				{ maxWidthCells: targetWidthCells(math), filename: `latex-${index + 1}.png` },
				math.dimensions,
			),
		);
	} else {
		container.addChild(new Text(theme.fg("warning", math.error ?? "LaTeX render failed"), 1, 0));
	}
}

function latexPreviewComponent(payload: PreviewPayload, theme: Theme): Container {
	const container = new Container();
	const mdTheme = getMarkdownTheme();
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold("Rendered LaTeX preview (transient)")), 1, 0));
	container.addChild(new Text(theme.fg("dim", "Not saved to session; clears on next prompt, reload, or timeout."), 1, 0));
	if (!RENDER_INLINE_MATH_IN_CONTEXT) {
		container.addChild(new Text(theme.fg("dim", "Display equations are rendered in context; inline math stays in prose."), 1, 0));
	}
	if (payload.truncated) {
		container.addChild(new Text(theme.fg("dim", `Showing first ${MAX_RENDERED_SNIPPETS} display equations.`), 1, 0));
	}

	let mathIndex = 0;
	for (const block of payload.blocks) {
		if (block.type === "markdown") {
			container.addChild(new Markdown(block.text.trim(), 1, 0, mdTheme));
		} else {
			container.addChild(new Spacer(1));
			addMathImage(container, block.math, mathIndex, theme);
			container.addChild(new Spacer(1));
			mathIndex++;
		}
	}
	return container;
}

export default function latexPreview(pi: ExtensionAPI) {
	let clearTimer: ReturnType<typeof setTimeout> | undefined;

	function clearPreview(ctx?: ExtensionContext): void {
		if (clearTimer) {
			clearTimeout(clearTimer);
			clearTimer = undefined;
		}
		if (!ctx?.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	function showPreview(ctx: ExtensionContext, payload: PreviewPayload): void {
		clearPreview(ctx);
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => latexPreviewComponent(payload, theme), { placement: "aboveEditor" });
		clearTimer = setTimeout(() => {
			try {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			} catch {
				// The extension context may be stale after reload/session switch.
			} finally {
				clearTimer = undefined;
			}
		}, PREVIEW_AUTO_CLEAR_MS);
	}

	pi.on("input", (_event, ctx) => {
		clearPreview(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		clearPreview(ctx);
	});

	pi.on("session_shutdown", () => {
		clearPreview();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant") as AssistantLike | undefined;
		const text = assistantText(lastAssistant);
		if (!text) return;
		const payload = await buildPreviewPayload(text);
		if (!payload) return;
		showPreview(ctx, payload);
	});
}
