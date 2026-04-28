import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { calculateImageRows, Container, getCellDimensions, Image, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync, inflateSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const WIDGET_KEY = "latex-preview";
const MAX_RENDERED_SNIPPETS = 10;
const LATEX_TIMEOUT_MS = 12_000;
const PREVIEW_AUTO_CLEAR_MS = 5 * 60_000;
const MAX_MATH_WIDTH_CELLS = 72;
const MIN_MATH_WIDTH_CELLS = 8;
const PREVIEW_PX_PER_CELL = 18;
const RENDER_INLINE_MATH_IN_CONTEXT = false;
const DEFAULT_TEXT_RGB: Rgb = { r: 205, g: 214, b: 244 };
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

type Rgb = {
	r: number;
	g: number;
	b: number;
};

type RenderOptions = {
	textRgb: Rgb;
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

function clampColorChannel(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

function latexDocument(snippet: LatexSnippet, options: RenderOptions): string {
	const body = snippet.display ? displayBody(snippet.tex) : `$\\displaystyle ${snippet.tex}$`;
	const rgb = options.textRgb;
	return String.raw`\documentclass{article}
\usepackage{amsmath,amssymb,mathtools,bm,bbm,dsfont,braket,cancel,physics}
\usepackage[active,tightpage,displaymath,textmath]{preview}
\PreviewBorder=3pt
\usepackage{xcolor}
\definecolor{PiMathText}{RGB}{${clampColorChannel(rgb.r)},${clampColorChannel(rgb.g)},${clampColorChannel(rgb.b)}}
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
\pagestyle{empty}
\begin{document}
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
	let c = index;
	for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

type PngChunk = {
	type: string;
	data: Buffer;
};

function crc32(parts: Buffer[]): number {
	let crc = 0xffffffff;
	for (const part of parts) {
		for (const byte of part) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBuffer = Buffer.from(type, "ascii");
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBuffer.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32([typeBuffer, data]), 8 + data.length);
	return chunk;
}

function paethPredictor(left: number, up: number, upperLeft: number): number {
	const p = left + up - upperLeft;
	const pa = Math.abs(p - left);
	const pb = Math.abs(p - up);
	const pc = Math.abs(p - upperLeft);
	if (pa <= pb && pa <= pc) return left;
	return pb <= pc ? up : upperLeft;
}

function parsePngChunks(buffer: Buffer): PngChunk[] | undefined {
	if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return undefined;
	const chunks: PngChunk[] = [];
	let offset = PNG_SIGNATURE.length;
	while (offset + 12 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > buffer.length) return undefined;
		chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
		offset = dataEnd + 4;
		if (type === "IEND") break;
	}
	return chunks;
}

function tintRgbaPng(buffer: Buffer, rgb: Rgb): Buffer {
	const chunks = parsePngChunks(buffer);
	const ihdr = chunks?.find((chunk) => chunk.type === "IHDR")?.data;
	if (!chunks || !ihdr || ihdr.length !== 13) return buffer;

	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const bitDepth = ihdr[8];
	const colorType = ihdr[9];
	const interlace = ihdr[12];
	if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) return buffer;

	const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
	const inflated = inflateSync(idat);
	const bytesPerPixel = 4;
	const stride = width * bytesPerPixel;
	if (inflated.length < (stride + 1) * height) return buffer;

	const pixels = Buffer.alloc(stride * height);
	let inputOffset = 0;
	for (let y = 0; y < height; y++) {
		const filter = inflated[inputOffset++];
		const rowStart = y * stride;
		const prevRowStart = (y - 1) * stride;
		for (let x = 0; x < stride; x++) {
			const raw = inflated[inputOffset++];
			const left = x >= bytesPerPixel ? pixels[rowStart + x - bytesPerPixel] : 0;
			const up = y > 0 ? pixels[prevRowStart + x] : 0;
			const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[prevRowStart + x - bytesPerPixel] : 0;
			let value: number;
			switch (filter) {
				case 0:
					value = raw;
					break;
				case 1:
					value = raw + left;
					break;
				case 2:
					value = raw + up;
					break;
				case 3:
					value = raw + Math.floor((left + up) / 2);
					break;
				case 4:
					value = raw + paethPredictor(left, up, upperLeft);
					break;
				default:
					return buffer;
			}
			pixels[rowStart + x] = value & 0xff;
		}
	}

	for (let offset = 0; offset < pixels.length; offset += bytesPerPixel) {
		if (pixels[offset + 3] === 0) continue;
		pixels[offset] = clampColorChannel(rgb.r);
		pixels[offset + 1] = clampColorChannel(rgb.g);
		pixels[offset + 2] = clampColorChannel(rgb.b);
	}

	const refiltered = Buffer.alloc((stride + 1) * height);
	let outputOffset = 0;
	for (let y = 0; y < height; y++) {
		refiltered[outputOffset++] = 0;
		pixels.copy(refiltered, outputOffset, y * stride, (y + 1) * stride);
		outputOffset += stride;
	}

	const outputChunks: Buffer[] = [PNG_SIGNATURE];
	let wroteIdat = false;
	for (const chunk of chunks) {
		if (chunk.type === "IDAT") {
			if (!wroteIdat) {
				outputChunks.push(pngChunk("IDAT", deflateSync(refiltered, { level: 9 })));
				wroteIdat = true;
			}
			continue;
		}
		if (chunk.type === "IEND") {
			if (!wroteIdat) outputChunks.push(pngChunk("IDAT", deflateSync(refiltered, { level: 9 })));
			outputChunks.push(pngChunk("IEND", Buffer.alloc(0)));
			break;
		}
		outputChunks.push(pngChunk(chunk.type, chunk.data));
	}
	return Buffer.concat(outputChunks);
}

export async function renderLatexSnippet(snippet: LatexSnippet, options: RenderOptions = { textRgb: DEFAULT_TEXT_RGB }): Promise<RenderResult> {
	const workdir = await mkdtemp(join(tmpdir(), "pi-latex-preview-"));
	try {
		await writeFile(join(workdir, "formula.tex"), latexDocument(snippet, options), "utf8");
		await execFileAsync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "formula.tex"], {
			cwd: workdir,
			timeout: LATEX_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		await execFileAsync("pdftocairo", ["-png", "-transp", "-singlefile", "-r", "220", "formula.pdf", "formula"], {
			cwd: workdir,
			timeout: LATEX_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		const png = await readFile(join(workdir, "formula.png"));
		const tintedPng = tintRgbaPng(png, options.textRgb);
		return { pngBase64: tintedPng.toString("base64"), dimensions: pngDimensions(png) };
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

const ANSI_BASIC_RGB: Rgb[] = [
	{ r: 0, g: 0, b: 0 },
	{ r: 128, g: 0, b: 0 },
	{ r: 0, g: 128, b: 0 },
	{ r: 128, g: 128, b: 0 },
	{ r: 0, g: 0, b: 128 },
	{ r: 128, g: 0, b: 128 },
	{ r: 0, g: 128, b: 128 },
	{ r: 192, g: 192, b: 192 },
	{ r: 128, g: 128, b: 128 },
	{ r: 255, g: 0, b: 0 },
	{ r: 0, g: 255, b: 0 },
	{ r: 255, g: 255, b: 0 },
	{ r: 0, g: 0, b: 255 },
	{ r: 255, g: 0, b: 255 },
	{ r: 0, g: 255, b: 255 },
	{ r: 255, g: 255, b: 255 },
];

function rgbFromAnsi(ansi: string): Rgb | undefined {
	const trueColor = ansi.match(/38;2;(\d{1,3});(\d{1,3});(\d{1,3})/);
	if (trueColor) {
		return { r: Number(trueColor[1]), g: Number(trueColor[2]), b: Number(trueColor[3]) };
	}

	const color256 = ansi.match(/38;5;(\d{1,3})/);
	if (color256) return xterm256ToRgb(Number(color256[1]));

	const basic = ansi.match(/\[(3[0-7]|9[0-7])m/);
	if (!basic) return undefined;
	const code = Number(basic[1]);
	return ANSI_BASIC_RGB[code >= 90 ? code - 82 : code - 30];
}

function xterm256ToRgb(index: number): Rgb | undefined {
	if (index < 0 || index > 255) return undefined;
	if (index < 16) return ANSI_BASIC_RGB[index];
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return { r: level, g: level, b: level };
	}
	const steps = [0, 95, 135, 175, 215, 255];
	const n = index - 16;
	return { r: steps[Math.floor(n / 36)], g: steps[Math.floor((n % 36) / 6)], b: steps[n % 6] };
}

function renderOptionsFromTheme(theme: Theme | undefined): RenderOptions {
	try {
		const textRgb = theme ? rgbFromAnsi(theme.getFgAnsi("text")) : undefined;
		return { textRgb: textRgb ?? DEFAULT_TEXT_RGB };
	} catch {
		return { textRgb: DEFAULT_TEXT_RGB };
	}
}

async function buildPreviewPayload(text: string, renderOptions: RenderOptions): Promise<PreviewPayload | undefined> {
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
		const result = await renderLatexSnippet(snippet, renderOptions);
		blocks.push({ type: "math", math: { display: snippet.display, delimiter: snippet.delimiter, ...result } });
		cursor = start + raw.length;
		renderedCount++;
	}

	if (renderedCount === 0) return undefined;
	pushMarkdown(blocks, text.slice(cursor));
	return { blocks, truncated };
}

function targetWidthCells(math: RenderedMath, availableWidthCells = MAX_MATH_WIDTH_CELLS): number {
	const widthPx = math.dimensions?.widthPx;
	const heightPx = math.dimensions?.heightPx;
	const limit = Math.max(1, Math.min(MAX_MATH_WIDTH_CELLS, Math.floor(availableWidthCells)));
	if (!widthPx || !heightPx) return Math.min(48, limit);

	const lower = Math.min(MIN_MATH_WIDTH_CELLS, limit);
	let bestCells = Math.max(lower, Math.min(limit, Math.ceil(widthPx / PREVIEW_PX_PER_CELL)));
	let bestScore = Number.POSITIVE_INFINITY;
	const cellDimensions = getCellDimensions();
	const originalAspect = widthPx / heightPx;

	for (let cells = lower; cells <= limit; cells++) {
		const rows = calculateImageRows({ widthPx, heightPx }, cells, cellDimensions);
		const renderedAspect = (cells * cellDimensions.widthPx) / (rows * cellDimensions.heightPx);
		const aspectError = Math.abs(Math.log(renderedAspect / originalAspect));
		const sizePenalty = cells < 28 ? (28 - cells) * 0.01 : 0;
		const score = aspectError + sizePenalty;
		if (score < bestScore) {
			bestScore = score;
			bestCells = cells;
		}
	}

	return bestCells;
}

class ResponsiveMathImage {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly math: RenderedMath,
		private readonly index: number,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		if (!this.math.pngBase64) {
			const text = new Text(this.theme.fg("warning", this.math.error ?? "LaTeX render failed"), 1, 0);
			this.cachedLines = text.render(width);
			this.cachedWidth = width;
			return this.cachedLines;
		}

		const maxWidthCells = targetWidthCells(this.math, Math.max(1, width - 2));
		const image = new Image(
			this.math.pngBase64,
			"image/png",
			{ fallbackColor: (text: string) => this.theme.fg("muted", text) },
			{ maxWidthCells, filename: `latex-${this.index + 1}.png` },
			this.math.dimensions,
		);
		this.cachedLines = image.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function addMathImage(container: Container, math: RenderedMath, index: number, theme: Theme): void {
	container.addChild(new ResponsiveMathImage(math, index, theme));
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
		const payload = await buildPreviewPayload(text, renderOptionsFromTheme(ctx.ui.theme));
		if (!payload) return;
		showPreview(ctx, payload);
	});
}
