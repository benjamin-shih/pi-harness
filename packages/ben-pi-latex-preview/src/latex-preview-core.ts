import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync, inflateSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const WIDGET_KEY = "latex-preview";
const LATEX_TIMEOUT_MS = 12_000;
const PREVIEW_AUTO_CLEAR_MS = 15 * 60_000;
const MAX_RENDERED_DISPLAY_MATH_BLOCKS = 20;
const MAX_MATH_WIDTH_CELLS = 72;
const MIN_MATH_WIDTH_CELLS = 8;
const PREVIEW_PX_PER_CELL = 18;
const DEFAULT_TEXT_RGB: Rgb = { r: 205, g: 214, b: 244 };
const DISPLAY_ENVIRONMENT = /^(displaymath|equation\*?|align\*?|gather\*?|multline\*?|flalign\*?|alignat\*?)$/;
const DISPLAY_MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(\\begin\{(displaymath|equation\*?|align\*?|gather\*?|multline\*?|flalign\*?|alignat\*?)\}[\s\S]*?\\end\{\4\})/g;
const MAX_TEX_SNIPPET_CHARS = 5_000;
const BLOCKED_LATEX_COMMANDS = [
	"addbibresource",
	"bibliography",
	"catcode",
	"csname",
	"directlua",
	"documentclass",
	"edef",
	"endinput",
	"everyjob",
	"expandafter",
	"gdef",
	"graphicspath",
	"IfFileExists",
	"include",
	"includegraphics",
	"includeonly",
	"input",
	"InputIfFileExists",
	"latelua",
	"let",
	"luaexec",
	"newcommand",
	"newread",
	"newwrite",
	"openin",
	"openout",
	"pdfobj",
	"pdfshellescape",
	"pdfximage",
	"read",
	"renewcommand",
	"RequirePackage",
	"special",
	"usepackage",
	"write",
	"write18",
	"xdef",
];
const BLOCKED_LATEX_COMMAND_PATTERN = new RegExp(
	`(^|[^\\\\])\\\\(?:${[...BLOCKED_LATEX_COMMANDS].sort((a, b) => b.length - a.length).join("|")})(?:\\b|\\d)`,
	"i",
);

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
	tex: string;
	display: boolean;
	delimiter: string;
};

type PreviewBlock =
	| { type: "markdown"; text: string }
	| { type: "math"; math: RenderedMath };

type PreviewPayload = {
	blocks: PreviewBlock[];
};

type Constructable<T = unknown> = new (...args: any[]) => T;

type LatexPreviewRuntime = {
	calculateImageRows: (dimensions: PngDimensions, columns: number, cellDimensions: unknown) => number;
	Container: Constructable<{ addChild: (child: unknown) => void }>;
	encodeITerm2: (base64Data: string, options: Record<string, unknown>) => string;
	encodeKitty: (base64Data: string, options: Record<string, unknown>) => string;
	getCapabilities: () => { images?: string | null };
	getCellDimensions: () => unknown;
	getMarkdownTheme: () => unknown;
	imageFallback: (mediaType: string, dimensions: PngDimensions, filename: string) => string;
	Markdown: Constructable;
	Spacer: Constructable;
	Text: Constructable<{ render: (width: number) => string[] }>;
};

let runtime: LatexPreviewRuntime | undefined;

export function configureLatexPreviewRuntime(deps: LatexPreviewRuntime): void {
	runtime = deps;
}

function runtimeDeps(): LatexPreviewRuntime {
	if (!runtime) throw new Error("LaTeX preview runtime dependencies have not been configured.");
	return runtime;
}

type AssistantLike = {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	stopReason?: string;
};

type TextSpan = {
	start: number;
	end: number;
};

function lineEndWithNewline(text: string, start: number): number {
	const newline = text.indexOf("\n", start);
	return newline === -1 ? text.length : newline + 1;
}

function lineContentEnd(text: string, endWithNewline: number): number {
	return endWithNewline > 0 && text[endWithNewline - 1] === "\n" ? endWithNewline - 1 : endWithNewline;
}

function escapedRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FENCE_CONTAINER_PREFIX = String.raw` {0,3}(?:(?:>\s*)*)?(?:(?:[-+*]|\d{1,9}[.)])\s+)? {0,3}`;
const BACKTICK = "`";

function fenceOpener(line: string): string | undefined {
	return line.match(new RegExp(`^${FENCE_CONTAINER_PREFIX}(${BACKTICK}{3,}|~{3,})`))?.[1];
}

function fenceCloser(line: string, char: string, minLength: number): boolean {
	return new RegExp(`^${FENCE_CONTAINER_PREFIX}${escapedRegExp(char)}{${minLength},}\\s*$`).test(line);
}

function fencedCodeSpans(text: string): TextSpan[] {
	const spans: TextSpan[] = [];
	let lineStart = 0;

	while (lineStart < text.length) {
		const lineEnd = lineEndWithNewline(text, lineStart);
		const line = text.slice(lineStart, lineContentEnd(text, lineEnd));
		const opener = fenceOpener(line);
		if (!opener) {
			lineStart = lineEnd;
			continue;
		}

		const char = opener[0]!;
		let cursor = lineEnd;
		let spanEnd = text.length;
		while (cursor < text.length) {
			const candidateEnd = lineEndWithNewline(text, cursor);
			const candidate = text.slice(cursor, lineContentEnd(text, candidateEnd));
			if (fenceCloser(candidate, char, opener.length)) {
				spanEnd = candidateEnd;
				break;
			}
			cursor = candidateEnd;
		}

		spans.push({ start: lineStart, end: spanEnd });
		lineStart = spanEnd;
	}

	return spans;
}

function inlineCodeSpans(text: string, start: number, end: number): TextSpan[] {
	const spans: TextSpan[] = [];
	let cursor = start;
	while (cursor < end) {
		if (text[cursor] !== "`") {
			cursor++;
			continue;
		}
		const openStart = cursor;
		while (cursor < end && text[cursor] === "`") cursor++;
		const length = cursor - openStart;

		let search = cursor;
		let closeEnd: number | undefined;
		while (search < end) {
			const next = text.indexOf("`", search);
			if (next < 0 || next >= end) break;
			let runEnd = next;
			while (runEnd < end && text[runEnd] === "`") runEnd++;
			if (runEnd - next === length) {
				closeEnd = runEnd;
				break;
			}
			search = runEnd;
		}
		if (closeEnd === undefined) continue;
		spans.push({ start: openStart, end: closeEnd });
		cursor = closeEnd;
	}
	return spans;
}

function markdownCodeSpans(text: string): TextSpan[] {
	const fenced = fencedCodeSpans(text);
	const spans: TextSpan[] = [];
	let cursor = 0;
	for (const fence of fenced) {
		spans.push(...inlineCodeSpans(text, cursor, fence.start));
		spans.push(fence);
		cursor = fence.end;
	}
	spans.push(...inlineCodeSpans(text, cursor, text.length));
	return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

function markdownProseSpans(text: string): TextSpan[] {
	const spans: TextSpan[] = [];
	let cursor = 0;
	for (const code of markdownCodeSpans(text)) {
		if (code.start > cursor) spans.push({ start: cursor, end: code.start });
		cursor = Math.max(cursor, code.end);
	}
	if (cursor < text.length) spans.push({ start: cursor, end: text.length });
	return spans;
}

function transformMarkdownProse(text: string, transform: (text: string) => string): string {
	let output = "";
	let cursor = 0;
	for (const code of markdownCodeSpans(text)) {
		output += transform(text.slice(cursor, code.start));
		output += text.slice(code.start, code.end);
		cursor = code.end;
	}
	output += transform(text.slice(cursor));
	return output;
}

function blankMarkdownCode(text: string): string {
	let output = "";
	let cursor = 0;
	for (const code of markdownCodeSpans(text)) {
		output += text.slice(cursor, code.start);
		output += " ".repeat(code.end - code.start);
		cursor = code.end;
	}
	output += text.slice(cursor);
	return output;
}

function isUsefulInlineMath(tex: string): boolean {
	if (tex.length > 220) return false;
	if (/^\d+(?:\.\d{2})?$/.test(tex.trim())) return false;
	return /[\\_^{}=<>+\-*/]|\b(?:frac|sum|int|prod|lim|sqrt|mathbb|mathcal|operatorname|exp|log|Pr|Var|Cov|sim|geq?|leq?|to)\b/.test(tex);
}

function snippetFromRegexMatch(match: RegExpMatchArray): LatexSnippet | undefined {
	if (match[1]) return { tex: match[1].trim(), display: true, delimiter: "$$" };
	if (match[2]) return { tex: match[2].trim(), display: true, delimiter: "\\[" };
	if (match[3]) return { tex: match[3].trim(), display: true, delimiter: "environment" };
	return undefined;
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

function stripLatexComments(tex: string): string {
	return tex
		.split(/\r?\n/)
		.map((line) => {
			for (let index = 0; index < line.length; index++) {
				if (line[index] !== "%") continue;
				let backslashes = 0;
				for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) backslashes++;
				if (backslashes % 2 === 0) return line.slice(0, index);
			}
			return line;
		})
		.join("\n");
}

export function validateLatexSnippet(snippet: LatexSnippet): string | undefined {
	if (snippet.tex.length > MAX_TEX_SNIPPET_CHARS) {
		return `LaTeX preview blocked: snippet exceeds ${MAX_TEX_SNIPPET_CHARS} characters.`;
	}
	const source = stripLatexComments(snippet.tex);
	const match = source.match(BLOCKED_LATEX_COMMAND_PATTERN);
	if (match) {
		const command = match[0].match(/\\[A-Za-z]+\d*/)?.[0] ?? "blocked command";
		return `LaTeX preview blocked: disallowed command ${command}.`;
	}
	return undefined;
}

function latexProcessEnv(workdir: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		TEXMFOUTPUT: workdir,
		openin_any: "p",
		openout_any: "p",
	};
}

export async function renderLatexSnippet(snippet: LatexSnippet, options: RenderOptions = { textRgb: DEFAULT_TEXT_RGB }): Promise<RenderResult> {
	const validationError = validateLatexSnippet(snippet);
	if (validationError) return { error: validationError };

	const workdir = await mkdtemp(join(tmpdir(), "pi-latex-preview-"));
	try {
		await writeFile(join(workdir, "formula.tex"), latexDocument(snippet, options), "utf8");
		await execFileAsync("pdflatex", ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "formula.tex"], {
			cwd: workdir,
			env: latexProcessEnv(workdir),
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

const COMMAND_SYMBOLS: Record<string, string> = {
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ε",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	pi: "π",
	varpi: "ϖ",
	rho: "ρ",
	varrho: "ϱ",
	sigma: "σ",
	varsigma: "ς",
	tau: "τ",
	upsilon: "υ",
	phi: "φ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	ge: "≥",
	geq: "≥",
	le: "≤",
	leq: "≤",
	ne: "≠",
	neq: "≠",
	approx: "≈",
	simeq: "≃",
	sim: "∼",
	to: "→",
	rightarrow: "→",
	leftarrow: "←",
	mapsto: "↦",
	Rightarrow: "⇒",
	Leftarrow: "⇐",
	Leftrightarrow: "⇔",
	iff: "⇔",
	in: "∈",
	notin: "∉",
	subset: "⊂",
	subseteq: "⊆",
	supset: "⊃",
	supseteq: "⊇",
	cup: "∪",
	cap: "∩",
	forall: "∀",
	exists: "∃",
	nabla: "∇",
	partial: "∂",
	infty: "∞",
	pm: "±",
	times: "×",
	cdot: "·",
	ldots: "...",
	dots: "...",
	mid: "|",
	vert: "|",
	lvert: "|",
	rvert: "|",
	parallel: "∥",
	perp: "⟂",
	propto: "∝",
	emptyset: "∅",
	varnothing: "∅",
	angle: "∠",
	Pr: "ℙ",
	P: "ℙ",
	E: "𝔼",
	R: "ℝ",
	N: "ℕ",
	Z: "ℤ",
	C: "ℂ",
	Q: "ℚ",
};

const DOUBLE_STRUCK: Record<string, string> = {
	A: "𝔸",
	C: "ℂ",
	E: "𝔼",
	H: "ℍ",
	N: "ℕ",
	P: "ℙ",
	Q: "ℚ",
	R: "ℝ",
	Z: "ℤ",
	1: "𝟙",
};

// Mathematical script glyphs often fall back to fonts with odd terminal metrics.
// For inline terminal prose, keep \mathcal legible and baseline-stable as ASCII.
const CALLIGRAPHIC: Record<string, string> = {
	A: "A",
	B: "B",
	C: "C",
	D: "D",
	E: "E",
	F: "F",
	G: "G",
	H: "H",
	I: "I",
	J: "J",
	K: "K",
	L: "L",
	M: "M",
	N: "N",
	O: "O",
	P: "P",
	Q: "Q",
	R: "R",
	S: "S",
	T: "T",
	U: "U",
	V: "V",
	W: "W",
	X: "X",
	Y: "Y",
	Z: "Z",
};

const SUPERSCRIPT: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	i: "ⁱ",
	n: "ⁿ",
};

const SUBSCRIPT: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
};

function scriptText(text: string, alphabet: Record<string, string>): string | undefined {
	let output = "";
	for (const char of text.replace(/\s+/g, "")) {
		const replacement = alphabet[char];
		if (!replacement) return undefined;
		output += replacement;
	}
	return output;
}

function replaceScripts(text: string, marker: "_" | "^", alphabet: Record<string, string>): string {
	let output = text.replace(new RegExp(`\\${marker}\\{([^{}]{1,16})\\}`, "g"), (raw, body: string) => {
		return scriptText(body, alphabet) ?? raw;
	});
	output = output.replace(new RegExp(`\\${marker}([A-Za-z0-9+\\-=()])`, "g"), (raw, body: string) => {
		return scriptText(body, alphabet) ?? raw;
	});
	return output;
}

function replaceAlphabetCommand(text: string, command: string, alphabet: Record<string, string>): string {
	const braced = new RegExp(`\\\\${command}\\s*\\{([^{}]{1,4})\\}`, "g");
	const unbraced = new RegExp(`\\\\${command}\\s+([A-Za-z0-9])`, "g");
	return text
		.replace(braced, (raw, body: string) => {
			return body.length === 1 ? alphabet[body] ?? raw : raw;
		})
		.replace(unbraced, (raw, body: string) => alphabet[body] ?? raw);
}

function prettifySimpleFraction(text: string): string {
	return text
		.replace(/\\frac\s*\{([^{}]{1,16})\}\s*\{([^{}]{1,16})\}/g, (_raw, numerator: string, denominator: string) => {
			return `${numerator}/${denominator}`;
		})
		.replace(/\\frac\s*([A-Za-z0-9])\s*([A-Za-z0-9])/g, (_raw, numerator: string, denominator: string) => {
			return `${numerator}/${denominator}`;
		});
}

const COMBINING_ACCENTS: Record<string, string> = {
	hat: "̂",
	widehat: "̂",
	bar: "̄",
	overline: "̄",
	tilde: "̃",
	widetilde: "̃",
	vec: "⃗",
	dot: "̇",
	ddot: "̈",
};

function prettifyInlineAtom(tex: string): string | undefined {
	let output = tex.trim();
	if (!output || output.length > 40) return undefined;
	output = replaceAlphabetCommand(output, "mathbb", DOUBLE_STRUCK);
	output = replaceAlphabetCommand(output, "mathcal", CALLIGRAPHIC);
	output = output.replace(/\\(?:operatorname|mathrm|text|textnormal|mathbf)\s*\{([^{}]{1,24})\}/g, "$1");
	output = output.replace(/\\([A-Za-z]+)/g, (raw, command: string) => COMMAND_SYMBOLS[command] ?? raw);
	output = replaceScripts(output, "_", SUBSCRIPT);
	output = replaceScripts(output, "^", SUPERSCRIPT);
	output = output.replace(/[{}]/g, "").trim();
	if (!output || /\\|[_^{}]/.test(output)) return undefined;
	return output;
}

function replaceAccentCommands(text: string): string {
	const names = Object.keys(COMBINING_ACCENTS).join("|");
	return text
		.replace(new RegExp(`\\\\(${names})(?![A-Za-z])\\s*\\{([^{}]{1,24})\\}`, "g"), (raw, command: string, body: string) => {
			const atom = prettifyInlineAtom(body);
			return atom ? `${atom}${COMBINING_ACCENTS[command]}` : raw;
		})
		.replace(new RegExp(`\\\\(${names})(?![A-Za-z])\\s*(\\\\[A-Za-z]+|[A-Za-z0-9])`, "g"), (raw, command: string, body: string) => {
			const atom = prettifyInlineAtom(body);
			return atom ? `${atom}${COMBINING_ACCENTS[command]}` : raw;
		});
}

function replaceSimpleSqrt(text: string): string {
	return text.replace(/\\sqrt\s*\{([^{}]{1,32})\}/g, (raw, body: string) => {
		const prettyBody = prettifyInlineExpression(body);
		if (!prettyBody) return raw;
		return /\s|[+\-*/=<>≤≥≠≈]/.test(prettyBody) ? `√(${prettyBody})` : `√${prettyBody}`;
	});
}

function prettifyInlineExpression(tex: string): string | undefined {
	if (tex.length > 180 || /\n|\\begin\b|\\end\b/.test(tex)) return undefined;
	let output = tex.trim();
	if (!output) return undefined;

	output = output.replace(/\\(?:left|right)\b/g, "");
	output = prettifySimpleFraction(output);
	output = replaceAlphabetCommand(output, "mathbb", DOUBLE_STRUCK);
	output = replaceAlphabetCommand(output, "mathcal", CALLIGRAPHIC);
	output = output.replace(/\\mathbf\s*\{1\}/g, "𝟙");
	output = output.replace(/\\(?:operatorname|mathrm|text|textnormal|mathbf)\s*\{([^{}]{1,40})\}/g, "$1");
	output = replaceAccentCommands(output);
	output = replaceSimpleSqrt(output);
	output = output.replace(/\\(?:,|;|:|!)/g, " ");
	output = output.replace(/\\qquad\b/g, "  ").replace(/\\quad\b/g, " ");
	output = output.replace(/\\([A-Za-z]+)/g, (raw, command: string) => COMMAND_SYMBOLS[command] ?? raw);
	output = replaceScripts(output, "_", SUBSCRIPT);
	output = replaceScripts(output, "^", SUPERSCRIPT);
	output = output.replace(/[{}]/g, "");
	output = output.replace(/\s*([=<>+\-≤≥≠≈≃∼→←↦⇒⇐⇔∈∉⊂⊆⊃⊇∪∩±×·])\s*/g, " $1 ");
	output = output.replace(/\s+/g, " ").replace(/\s+([,.;:)\]])/g, "$1").replace(/([([{])\s+/g, "$1").trim();

	if (!output || /\\|[_^{}]/.test(output)) return undefined;
	return output;
}

function prettifyInlineMathInPlainText(text: string): string {
	const inlineMath = /\\\(([\s\S]+?)\\\)|(?<!\\)\$(?![\s\d])([^\n$]{1,220}?)(?<![\\\s])\$/g;
	return text.replace(inlineMath, (raw, parenTex: string | undefined, dollarTex: string | undefined) => {
		const tex = (parenTex ?? dollarTex ?? "").trim();
		if (!tex) return raw;
		if (dollarTex !== undefined && !isUsefulInlineMath(tex)) return raw;
		return prettifyInlineExpression(tex) ?? raw;
	});
}

export function prettifyInlineMathInMarkdown(text: string): string {
	return transformMarkdownProse(text, prettifyInlineMathInPlainText);
}

export function sanitizeMarkdownForLatexPreview(text: string): string {
	return transformMarkdownProse(prettifyInlineMathInMarkdown(text), (prose) =>
		prose
			.replace(/\\\[/g, "`\\\\[`")
			.replace(/\\\]/g, "`\\\\]`")
			.replace(/(?<!\\)\$(?![\s\d])/g, "\\$")
			.replace(/\n{4,}/g, "\n\n\n"),
	);
}

export async function buildPreviewPayload(
	text: string,
	renderOptions: RenderOptions,
	renderSnippet: (snippet: LatexSnippet, options: RenderOptions) => Promise<RenderResult> = renderLatexSnippet,
): Promise<PreviewPayload | undefined> {
	const blocks: PreviewBlock[] = [];
	let cursor = 0;
	let renderedBlocks = 0;
	let omittedBlocks = 0;
	for (const span of markdownProseSpans(text)) {
		const prose = text.slice(span.start, span.end);
		for (const match of prose.matchAll(DISPLAY_MATH_PATTERN)) {
			const start = span.start + (match.index ?? 0);
			const raw = match[0];
			const snippet = snippetFromRegexMatch(match);
			if (!snippet) continue;

			pushMarkdown(blocks, text.slice(cursor, start));
			if (renderedBlocks >= MAX_RENDERED_DISPLAY_MATH_BLOCKS) {
				omittedBlocks++;
				cursor = start + raw.length;
				continue;
			}
			const result = await renderSnippet(snippet, renderOptions);
			blocks.push({ type: "math", math: { tex: snippet.tex, display: snippet.display, delimiter: snippet.delimiter, ...result } });
			renderedBlocks++;
			cursor = start + raw.length;
		}
	}

	if (!blocks.some((block) => block.type === "math")) return undefined;
	pushMarkdown(blocks, text.slice(cursor));
	if (omittedBlocks > 0) pushMarkdown(blocks, `\n\n_LaTeX preview omitted ${omittedBlocks} additional display equation(s)._`);
	return { blocks };
}

function targetWidthCells(math: RenderedMath, availableWidthCells = MAX_MATH_WIDTH_CELLS): number {
	const widthPx = math.dimensions?.widthPx;
	const limit = Math.max(1, Math.min(MAX_MATH_WIDTH_CELLS, Math.floor(availableWidthCells)));
	if (!widthPx) return Math.min(48, limit);

	const naturalWidth = Math.max(MIN_MATH_WIDTH_CELLS, Math.ceil(widthPx / PREVIEW_PX_PER_CELL));
	return Math.max(1, Math.min(limit, naturalWidth));
}

function centeredImageLine(sequence: string, width: number, imageWidthCells: number, rows: number): string {
	const indent = Math.max(0, Math.floor((width - imageWidthCells) / 2));
	const moveUp = rows > 1 ? `\x1b[${rows - 1}A` : "";
	return moveUp + " ".repeat(indent) + sequence;
}

function terminalImageLines(
	base64Data: string,
	dimensions: PngDimensions | undefined,
	width: number,
	imageWidthCells: number,
	filename: string,
	theme: Theme,
): string[] {
	const resolvedDimensions = dimensions ?? { widthPx: 800, heightPx: 600 };
	const { calculateImageRows, getCapabilities, getCellDimensions } = runtimeDeps();
	const rows = calculateImageRows(resolvedDimensions, imageWidthCells, getCellDimensions());
	const caps = getCapabilities();
	let sequence: string | undefined;

	if (caps.images === "kitty") {
		// Deliberately omit `rows`: Kitty then preserves the PNG's native aspect
		// ratio instead of stretching it to a quantized terminal-cell rectangle.
		sequence = runtimeDeps().encodeKitty(base64Data, { columns: imageWidthCells });
	} else if (caps.images === "iterm2") {
		sequence = runtimeDeps().encodeITerm2(base64Data, {
			width: imageWidthCells,
			height: "auto",
			name: filename,
			preserveAspectRatio: true,
		});
	}

	if (!sequence) {
		return [theme.fg("muted", runtimeDeps().imageFallback("image/png", resolvedDimensions, filename))];
	}

	const lines = Array.from({ length: Math.max(0, rows - 1) }, () => "");
	lines.push(centeredImageLine(sequence, width, imageWidthCells, rows));
	return lines;
}

function compactTexSource(tex: string, maxLength = 240): string {
	const compact = tex.replace(/\s+/g, " ").trim();
	return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

class ResponsiveMathImage {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly math: RenderedMath;
	private readonly index: number;
	private readonly theme: Theme;

	constructor(math: RenderedMath, index: number, theme: Theme) {
		this.math = math;
		this.index = index;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		if (!this.math.pngBase64) {
			const { Text } = runtimeDeps();
			const error = new Text(this.theme.fg("warning", this.math.error ?? "LaTeX render failed"), 1, 0);
			const source = new Text(this.theme.fg("muted", `TeX: ${compactTexSource(this.math.tex)}`), 1, 0);
			this.cachedLines = [...error.render(width), ...source.render(width)];
			this.cachedWidth = width;
			return this.cachedLines;
		}

		const maxWidthCells = targetWidthCells(this.math, Math.max(1, width - 2));
		this.cachedLines = terminalImageLines(
			this.math.pngBase64,
			this.math.dimensions,
			width,
			maxWidthCells,
			`latex-${this.index + 1}.png`,
			this.theme,
		);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function addMathImage(container: { addChild: (child: unknown) => void }, math: RenderedMath, index: number, theme: Theme): void {
	container.addChild(new ResponsiveMathImage(math, index, theme));
}

class SafeMarkdownBlock {
	private markdownComponent: { render: (width: number) => string[] } | undefined;
	private fallbackComponent: { render: (width: number) => string[] } | undefined;
	private readonly text: string;
	private readonly theme: Theme;
	private readonly markdownTheme: unknown;

	constructor(text: string, theme: Theme, markdownTheme: unknown) {
		this.text = sanitizeMarkdownForLatexPreview(text.trim());
		this.theme = theme;
		this.markdownTheme = markdownTheme;
	}

	render(width: number): string[] {
		const { Markdown, Text } = runtimeDeps();
		try {
			this.markdownComponent ??= new Markdown(this.text, 1, 0, this.markdownTheme) as { render: (width: number) => string[] };
			return this.markdownComponent.render(width);
		} catch {
			this.fallbackComponent ??= new Text(
				this.theme.fg("warning", "LaTeX preview Markdown fallback (plain text)") + "\n" + this.theme.fg("muted", this.text),
				1,
				0,
			) as { render: (width: number) => string[] };
			return this.fallbackComponent.render(width);
		}
	}
}

function addSafeMarkdown(container: { addChild: (child: unknown) => void }, text: string, theme: Theme, markdownTheme: unknown): void {
	if (!text.trim()) return;
	container.addChild(new SafeMarkdownBlock(text, theme, markdownTheme));
}

function latexPreviewComponent(payload: PreviewPayload, theme: Theme) {
	const { Container, Spacer, Text, getMarkdownTheme } = runtimeDeps();
	const container = new Container();
	const mdTheme = getMarkdownTheme();
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold("Rendered LaTeX preview")), 1, 0));
	let mathIndex = 0;
	for (const block of payload.blocks) {
		if (block.type === "markdown") {
			addSafeMarkdown(container, block.text, theme, mdTheme);
		} else {
			container.addChild(new Spacer(1));
			addMathImage(container, block.math, mathIndex, theme);
			container.addChild(new Spacer(1));
			mathIndex++;
		}
	}
	return container;
}

export type LatexPreviewController = {
	clearPreview: (ctx?: ExtensionContext) => void;
	handleAgentEnd: (event: { messages: unknown[] }, ctx: ExtensionContext) => Promise<void>;
};

export function createLatexPreviewController(): LatexPreviewController {
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
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => latexPreviewComponent(payload, theme) as any, { placement: "aboveEditor" });
		clearTimer = setTimeout(() => {
			try {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			} catch {
				// The extension context may be stale after reload/session switch.
			} finally {
				clearTimer = undefined;
			}
		}, PREVIEW_AUTO_CLEAR_MS);
		clearTimer.unref?.();
	}

	async function handleAgentEnd(event: { messages: unknown[] }, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const lastAssistant = [...event.messages].reverse().find((message) => (message as AssistantLike).role === "assistant") as AssistantLike | undefined;
		const text = assistantText(lastAssistant);
		if (!text) return;
		const payload = await buildPreviewPayload(text, renderOptionsFromTheme(ctx.ui.theme));
		if (!payload) return;
		showPreview(ctx, payload);
	}

	return { clearPreview, handleAgentEnd };
}

export default function latexPreview(pi: ExtensionAPI) {
	const controller = createLatexPreviewController();

	pi.on("input", (_event, ctx) => {
		controller.clearPreview(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		controller.clearPreview(ctx);
	});

	pi.on("session_shutdown", () => {
		controller.clearPreview();
	});

	pi.on("agent_end", controller.handleAgentEnd);
}
