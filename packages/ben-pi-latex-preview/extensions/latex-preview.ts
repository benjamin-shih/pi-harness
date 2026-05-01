import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	calculateImageRows,
	Container,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	imageFallback,
	Markdown,
	Spacer,
	Text,
} from "@mariozechner/pi-tui";

const requireCore = createRequire(import.meta.url);
const STATUS_KEY = "latex-preview";
const TEX_PROJECT_FILENAMES = new Set([
	"latexmkrc",
	".latexmkrc",
	"tectonic.toml",
	"typst.toml",
	"_quarto.yml",
	"quarto.yml",
]);
const TEX_PROJECT_EXTENSIONS = new Set([".tex", ".bib", ".sty", ".cls", ".qmd", ".rnw", ".rmd", ".typ"]);
const DISPLAY_MATH_RESPONSE_PATTERN = /\$\$[\s\S]{1,4000}\$\$|\\\[[\s\S]{1,4000}\\\]|\\begin\{(?:displaymath|equation\*?|align\*?|gather\*?|multline\*?|flalign\*?|alignat\*?)\}/;

type LatexPreviewCore = typeof import("../src/latex-preview-core.ts");
type LatexPreviewController = ReturnType<LatexPreviewCore["createLatexPreviewController"]>;

type AssistantLike = {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	stopReason?: string;
};

function extensionOf(file: string): string {
	const index = file.lastIndexOf(".");
	return index >= 0 ? file.slice(index).toLowerCase() : "";
}

function safeList(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function looksLikeTexProject(cwd: string): boolean {
	let dir = resolve(cwd);
	for (let depth = 0; depth < 3; depth++) {
		for (const file of safeList(dir)) {
			const lower = file.toLowerCase();
			if (TEX_PROJECT_FILENAMES.has(lower)) return true;
			if (TEX_PROJECT_EXTENSIONS.has(extensionOf(lower))) return true;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return false;
}

function assistantText(message: AssistantLike | undefined): string {
	if (!message || message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return "";
	return (message.content ?? [])
		.filter((part) => part.type === "text" && part.text?.trim())
		.map((part) => part.text)
		.join("\n\n");
}

export function messageLooksMathHeavy(messages: unknown[]): boolean {
	const lastAssistant = [...messages].reverse().find((message) => (message as AssistantLike).role === "assistant") as AssistantLike | undefined;
	const text = assistantText(lastAssistant);
	return Boolean(text && DISPLAY_MATH_RESPONSE_PATTERN.test(text));
}

export default function latexPreviewLazy(pi: ExtensionAPI) {
	let texProject = false;
	let corePromise: Promise<LatexPreviewController> | undefined;
	let controller: LatexPreviewController | undefined;

	async function loadController(ctx?: ExtensionContext): Promise<LatexPreviewController> {
		if (controller) return controller;
		if (!corePromise) {
			corePromise = Promise.resolve().then(() => {
				const core = requireCore("../src/latex-preview-core.ts") as LatexPreviewCore;
				core.configureLatexPreviewRuntime({
					calculateImageRows,
					Container,
					encodeITerm2,
					encodeKitty,
					getCapabilities,
					getCellDimensions,
					getMarkdownTheme,
					imageFallback,
					Markdown,
					Spacer,
					Text,
				});
				controller = core.createLatexPreviewController();
				return controller;
			});
		}
		try {
			return await corePromise;
		} catch (error) {
			corePromise = undefined;
			const message = error instanceof Error ? error.message : String(error);
			if (ctx?.hasUI) ctx.ui.notify(`LaTeX preview failed to load: ${message}`, "warning");
			throw error;
		}
	}

	function setStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, texProject ? ctx.ui.theme.fg("muted", "latex:auto") : undefined);
	}

	pi.on("session_start", async (_event, ctx) => {
		texProject = isDirectory(ctx.cwd) && looksLikeTexProject(ctx.cwd);
		setStatus(ctx);
		if (texProject) void loadController(ctx).catch((): undefined => undefined);
	});

	pi.on("input", async (_event, ctx) => {
		controller?.clearPreview(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		controller?.clearPreview(ctx);
	});

	pi.on("session_shutdown", async () => {
		controller?.clearPreview();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const shouldPreview = texProject || messageLooksMathHeavy(event.messages);
		if (!shouldPreview) return;
		const loaded = await loadController(ctx);
		await loaded.handleAgentEnd(event, ctx);
	});
}
