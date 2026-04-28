import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Image, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CUSTOM_TYPE = "latex-preview";
const MAX_RENDERED_SNIPPETS = 10;
const LATEX_TIMEOUT_MS = 12_000;
const DISPLAY_ENVIRONMENT = /^(equation\*?|align\*?|gather\*?|multline\*?|flalign\*?|alignat\*?)$/;

export type LatexSnippet = {
	tex: string;
	display: boolean;
	delimiter: string;
};

type RenderedSnippet = LatexSnippet & {
	pngBase64?: string;
	error?: string;
};

type PreviewDetails = {
	snippets: RenderedSnippet[];
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

const renderCache = new Map<string, Promise<Pick<RenderedSnippet, "pngBase64" | "error">>>();

export async function renderLatexSnippet(snippet: LatexSnippet): Promise<Pick<RenderedSnippet, "pngBase64" | "error">> {
	const key = createHash("sha256").update(JSON.stringify(snippet)).digest("hex");
	const cached = renderCache.get(key);
	if (cached) return cached;

	const renderPromise = (async () => {
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
			return { pngBase64: png.toString("base64") };
		} catch (error) {
			return { error: errorSummary(error) };
		} finally {
			await rm(workdir, { recursive: true, force: true });
		}
	})();

	renderCache.set(key, renderPromise);
	return renderPromise;
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

async function buildPreviewDetails(text: string): Promise<PreviewDetails | undefined> {
	const { snippets, truncated } = extractLatexSnippets(text);
	if (snippets.length === 0) return undefined;

	const rendered: RenderedSnippet[] = [];
	for (const snippet of snippets) {
		const result = await renderLatexSnippet(snippet);
		rendered.push({ ...snippet, ...result });
	}
	return { snippets: rendered, truncated };
}

function sendWhenIdle(pi: ExtensionAPI, ctx: ExtensionContext, details: PreviewDetails, attempts = 30): void {
	if (!ctx.hasUI) return;
	if (ctx.isIdle()) {
		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: "Rendered LaTeX preview for the previous assistant response.",
			display: true,
			details,
		});
		return;
	}
	if (attempts <= 0) return;
	setTimeout(() => sendWhenIdle(pi, ctx, details, attempts - 1), 50);
}

function latexPreviewComponent(details: PreviewDetails, expanded: boolean, theme: Theme): Container {
	const container = new Container();
	const mdTheme = getMarkdownTheme();
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold("Rendered LaTeX")), 1, 0));

	if (details.truncated) {
		container.addChild(new Text(theme.fg("dim", `Showing first ${details.snippets.length} math snippets.`), 1, 0));
	}

	for (let i = 0; i < details.snippets.length; i++) {
		const snippet = details.snippets[i];
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `${i + 1}. ${snippet.display ? "display" : "inline"} math`), 1, 0));
		if (expanded) {
			container.addChild(new Markdown(`\`\`\`latex\n${snippet.tex}\n\`\`\``, 1, 0, mdTheme));
		}
		if (snippet.pngBase64) {
			container.addChild(
				new Image(
					snippet.pngBase64,
					"image/png",
					{ fallbackColor: (text: string) => theme.fg("muted", text) },
					{ maxWidthCells: 88, filename: `latex-${i + 1}.png` },
				),
			);
		} else {
			container.addChild(new Text(theme.fg("warning", snippet.error ?? "LaTeX render failed"), 1, 0));
		}
	}
	return container;
}

export default function latexPreview(pi: ExtensionAPI) {
	pi.registerMessageRenderer<PreviewDetails>(CUSTOM_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		if (!details || !Array.isArray(details.snippets)) return undefined;
		return latexPreviewComponent(details, expanded, theme);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant") as AssistantLike | undefined;
		const text = assistantText(lastAssistant);
		if (!text) return;
		const details = await buildPreviewDetails(text);
		if (!details) return;
		sendWhenIdle(pi, ctx, details);
	});
}
