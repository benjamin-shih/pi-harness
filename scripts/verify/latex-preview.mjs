import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, loadExtensionModule, loadModuleAt, readJson, requireFromVerify as require, root } from "./harness.mjs";

function commandExists(command) {
	try {
		execFileSync("sh", ["-c", "command -v -- \"$1\"", "sh", command], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function latexPreviewTempDirs() {
	return readdirSync(tmpdir()).filter((name) => name.startsWith("pi-latex-preview-"));
}

export async function runLatexPreviewBehaviorTests() {
	const optionalPackageJson = readJson("packages/ben-pi-latex-preview/package.json");
	assert(optionalPackageJson?.pi?.extensions?.includes("./extensions"), "optional latex-preview package should expose its extensions directory");
	const latexLoader = loadExtensionModule("packages/ben-pi-latex-preview/extensions/latex-preview.ts");
	assert(typeof (latexLoader.default ?? latexLoader) === "function", "optional latex-preview loader should export a default extension");
	assert(typeof latexLoader.looksLikeTexProject === "function", "latex-preview loader should export looksLikeTexProject for verification");
	assert(typeof latexLoader.messageLooksMathHeavy === "function", "latex-preview loader should export messageLooksMathHeavy for verification");
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-latex-preview-verify-"));
	try {
		const plainDir = join(tempRoot, "plain");
		const texDir = join(tempRoot, "tex");
		mkdirSync(plainDir);
		mkdirSync(texDir);
		writeFileSync(join(texDir, "main.tex"), "\\documentclass{article}\n", "utf8");
		assert(!latexLoader.looksLikeTexProject(plainDir), "latex-preview loader should stay inactive for plain directories");
		assert(latexLoader.looksLikeTexProject(texDir), "latex-preview loader should auto-activate for TeX projects");
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
	assert(
		latexLoader.messageLooksMathHeavy({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Use \\[x^2+y^2=z^2\\]." }] }] }.messages),
		"latex-preview loader should auto-activate on math-heavy assistant output",
	);
	assert(
		latexLoader.messageLooksMathHeavy({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: String.raw`Use \begin{displaymath}x^2+y^2=z^2\end{displaymath}.` }] }] }.messages),
		"latex-preview loader should auto-activate on displaymath assistant output",
	);

	const loaderHandlers = new Map();
	let loaderWidgetFactory;
	const loaderFactory = latexLoader.default ?? latexLoader;
	loaderFactory({ on: (event, handler) => loaderHandlers.set(event, handler) });
	const loaderTheme = {
		getFgAnsi: () => "\u001b[38;2;205;214;244m",
		fg: (_color, text) => text,
		bold: (text) => text,
	};
	const loaderCtx = {
		cwd: root,
		hasUI: true,
		ui: { theme: loaderTheme, setStatus: () => {}, notify: () => {}, setWidget: (_key, widget) => (loaderWidgetFactory = widget) },
	};
	await loaderHandlers.get("session_start")({ reason: "startup" }, loaderCtx);
	await loaderHandlers.get("agent_end")(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: String.raw`Bad:
\[\input{x}\]` }] }] },
		loaderCtx,
	);
	assert(typeof loaderWidgetFactory === "function", "latex-preview loader should lazy-load core and render math previews on demand");
	loaderHandlers.get("session_shutdown")?.({}, loaderCtx);

	const isolatedRoot = mkdtempSync(join(tmpdir(), "pi-latex-preview-isolated-"));
	try {
		const isolatedPackage = join(isolatedRoot, "ben-pi-latex-preview");
		cpSync(join(root, "packages", "ben-pi-latex-preview"), isolatedPackage, { recursive: true });
		const isolatedLoader = loadModuleAt(join(isolatedPackage, "extensions", "latex-preview.ts"));
		const isolatedHandlers = new Map();
		let isolatedWidgetFactory;
		(isolatedLoader.default ?? isolatedLoader)({ on: (event, handler) => isolatedHandlers.set(event, handler) });
		await isolatedHandlers.get("session_start")({ reason: "startup" }, loaderCtx);
		await isolatedHandlers.get("agent_end")(
			{ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: String.raw`Bad:
\[\input{x}\]` }] }] },
			{ ...loaderCtx, ui: { ...loaderCtx.ui, setWidget: (_key, widget) => (isolatedWidgetFactory = widget) } },
		);
		assert(typeof isolatedWidgetFactory === "function", "latex-preview should lazy-load from an isolated optional package copy");
		isolatedHandlers.get("session_shutdown")?.({}, loaderCtx);
	} finally {
		rmSync(isolatedRoot, { recursive: true, force: true });
	}

	const latexPreview = require(join(root, "packages", "ben-pi-latex-preview", "src", "latex-preview-core.ts"));
	const prettify = latexPreview.prettifyInlineMathInMarkdown;
	const validate = latexPreview.validateLatexSnippet;
	const render = latexPreview.renderLatexSnippet;
	assert(typeof prettify === "function", "latex-preview should export prettifyInlineMathInMarkdown");
	assert(typeof validate === "function", "latex-preview should export validateLatexSnippet");
	assert(typeof render === "function", "latex-preview should export renderLatexSnippet");
	assert(typeof latexPreview.buildPreviewPayload === "function", "latex-preview should export buildPreviewPayload for regression coverage");
	assert(typeof latexPreview.sanitizeMarkdownForLatexPreview === "function", "latex-preview should export sanitizeMarkdownForLatexPreview for regression coverage");

	assert(
		prettify("For \\(Y_1\\), \\(y\\ge 0\\), and \\(Z\\sim \\mathcal N(0,1)\\).") ===
			"For Y₁, y ≥ 0, and Z ∼ N(0,1).",
		"latex-preview should prettify common inline math",
	);
	assert(
		prettify("Use \\(\\mathcal F\\), \\(\\mathcal L\\), and \\(\\mathcal{X}\\) inline.") ===
			"Use F, L, and X inline.",
		"latex-preview should render inline mathcal as plain ASCII generally",
	);
	assert(
		prettify("Use \\(\\hat\\theta\\), \\(\\bar X\\), \\(\\sqrt{x^2+1}\\), and \\(\\frac12\\).") ===
			"Use θ̂, X̄, √(x² + 1), and 1/2.",
		"latex-preview should prettify common accents, roots, and compact fractions",
	);
	assert(
		prettify("Use \\(x_1, \\ldots, x_n\\) and \\(y_1, \\dots, y_n\\) inline.") === "Use x₁,..., xₙ and y₁,..., yₙ inline.",
		"latex-preview should render inline LaTeX dots as plain ellipses",
	);
	assert(
		prettify("Keep `\\(X_1\\)` code literal.") === "Keep `\\(X_1\\)` code literal.",
		"latex-preview should not prettify inline code",
	);
	assert(
		prettify("Cost is $12.50, but math $X_n\\to X$ is useful.") === "Cost is $12.50, but math Xₙ → X is useful.",
		"latex-preview should avoid currency-like dollars and prettify useful dollar math",
	);
	assert(
		latexPreview.sanitizeMarkdownForLatexPreview(String.raw`Use unmatched \[ and $X_n`) === String.raw`Use unmatched ` + "`\\\\[`" + String.raw` and \$X_n`,
		"latex-preview should sanitize fragile unmatched math delimiters before Markdown rendering",
	);

	const mathHeavyWithCode = [
		String.raw`Before code.`,
		"",
		String.raw`\[A_n \xrightarrow{D} A\]`,
		"",
		"```ts",
		String.raw`const broken = text.replace(/\\\[/g, "\\n\\n").replace(/\\\]/g, "\\n\\n");`,
		String.raw`const shouldNotRender = "\\[\\input{x}\\]";`,
		"```",
		"",
		String.raw`After code.`,
		"",
		String.raw`\[`,
		String.raw`x^2 + y^2 = z^2`,
		String.raw`\]`,
	].join("\n");
	const payload = await latexPreview.buildPreviewPayload(mathHeavyWithCode, { textRgb: { r: 1, g: 2, b: 3 } }, async (snippet) => ({ error: `rendered:${snippet.tex}` }));
	const mathBlocks = payload?.blocks.filter((block) => block.type === "math") ?? [];
	assert(mathBlocks.length === 2, "latex-preview should render display math in prose while ignoring code-fence math lookalikes");
	assert(mathBlocks.every((block) => !block.math.tex.includes("input")), "latex-preview should not extract TeX from code fences");
	assert(payload.blocks.some((block) => block.type === "markdown" && block.text.includes("shouldNotRender")), "latex-preview should preserve code fences as markdown prose blocks");

	const displaymathPayload = await latexPreview.buildPreviewPayload(
		String.raw`Use \begin{displaymath}W_n = \sqrt{n}(X_n/n - 1/2)\end{displaymath} in prose.`,
		{ textRgb: { r: 1, g: 2, b: 3 } },
		async (snippet) => ({ error: `rendered:${snippet.delimiter}:${snippet.tex}` }),
	);
	const displaymathBlocks = displaymathPayload?.blocks.filter((block) => block.type === "math") ?? [];
	assert(displaymathBlocks.length === 1, "latex-preview should render displaymath environments as display math");
	assert(displaymathBlocks[0].math.delimiter === "environment", "latex-preview should classify displaymath as an environment delimiter");
	assert(displaymathBlocks[0].math.tex.includes("\\begin{displaymath}"), "latex-preview should preserve the full displaymath environment for rendering");

	const manyDisplaymath = Array.from({ length: 12 }, (_, index) => String.raw`\begin{displaymath}x_${index}=y_${index}\end{displaymath}`).join("\n\n");
	const manyPayload = await latexPreview.buildPreviewPayload(manyDisplaymath, { textRgb: { r: 1, g: 2, b: 3 } }, async (snippet) => ({ error: `rendered:${snippet.tex}` }));
	const manyMathBlocks = manyPayload?.blocks.filter((block) => block.type === "math") ?? [];
	assert(manyMathBlocks.length === 12, "latex-preview should render every display equation in a response, not just the first ten");
	let cappedRenderCalls = 0;
	const cappedDisplaymath = Array.from({ length: 25 }, (_value, index) => String.raw`\begin{displaymath}x_${index}=y_${index}\end{displaymath}`).join("\n\n");
	const cappedPayload = await latexPreview.buildPreviewPayload(cappedDisplaymath, { textRgb: { r: 1, g: 2, b: 3 } }, async (snippet) => {
		cappedRenderCalls++;
		return { error: `rendered:${snippet.tex}` };
	});
	assert(cappedRenderCalls === 20, "latex-preview should cap rendered display equations per response");
	assert(cappedPayload?.blocks.some((block) => block.type === "markdown" && block.text.includes("omitted 5 additional")), "latex-preview should report omitted display equations after the render cap");

	const trickyMarkdownCode = [
		"~~~ts",
		String.raw`const tildeFence = "\\[\\input{tilde}\\]";`,
		"~~~",
		String.raw`\[real_1\]`,
		"Inline ``\\\\[\\\\input{inline}\\\\]`` should stay code.",
		"````ts",
		"``` nested fence marker",
		String.raw`const longFence = "\\[\\input{long}\\]";`,
		"````",
		String.raw`\[real_2\]`,
	].join("\n");
	const trickyPayload = await latexPreview.buildPreviewPayload(trickyMarkdownCode, { textRgb: { r: 1, g: 2, b: 3 } }, async (snippet) => ({ error: `rendered:${snippet.tex}` }));
	const trickyMath = trickyPayload?.blocks.filter((block) => block.type === "math") ?? [];
	assert(trickyMath.length === 2, "latex-preview should ignore tilde fences, long fences, and multi-backtick inline code while rendering prose math");
	assert(trickyMath.every((block) => /^real_[12]$/.test(block.math.tex)), "latex-preview should only extract prose display math from tricky Markdown code cases");

	const unclosedFence = [
		"```ts",
		String.raw`const evil = "\\[\\input{unclosed}\\]";`,
		String.raw`\[not_math_because_fence_is_unclosed\]`,
	].join("\n");
	assert(
		(await latexPreview.buildPreviewPayload(unclosedFence, { textRgb: { r: 1, g: 2, b: 3 } }, async () => ({ error: "should not render" }))) === undefined,
		"latex-preview should treat unclosed fenced code blocks as code through EOF",
	);

	const listFenceMarkdown = [
		"1. ```ts",
		String.raw`   const ordered = "\\[\\input{ordered}\\]";`,
		"   ```",
		String.raw`\[real_ordered\]`,
		"- ~~~ts",
		String.raw`  const tilde = "\\[\\input{list_tilde}\\]";`,
		"  ~~~",
		String.raw`\[real_tilde\]`,
	].join("\n");
	const listFencePayload = await latexPreview.buildPreviewPayload(listFenceMarkdown, { textRgb: { r: 1, g: 2, b: 3 } }, async (snippet) => ({ error: `rendered:${snippet.tex}` }));
	const listFenceMath = listFencePayload?.blocks.filter((block) => block.type === "math") ?? [];
	assert(listFenceMath.length === 2, "latex-preview should ignore fenced code opened inside Markdown list items");
	assert(listFenceMath.every((block) => /^real_(ordered|tilde)$/.test(block.math.tex)), "latex-preview should only extract prose math after list-item fenced code blocks");
	assert(
		latexPreview.sanitizeMarkdownForLatexPreview(listFenceMarkdown).includes(String.raw`\\[\\input{ordered}\\]`),
		"latex-preview sanitizer should not mutate code inside list-item fenced blocks",
	);

	for (const command of ["input", "include", "openin", "read", "write18", "includegraphics", "usepackage", "directlua", "catcode"]) {
		const error = validate({ tex: `x + \\${command}{secret}`, display: true, delimiter: "\\\\[" });
		assert(error?.includes("blocked"), `latex-preview should block \\${command}`);
	}
	assert(!validate({ tex: "x^2 + y^2 = z^2", display: true, delimiter: "\\\\[" }), "latex-preview should allow simple display math");
	assert(
		(await render({ tex: "\\input{/etc/passwd}", display: true, delimiter: "\\\\[" })).error?.includes("blocked"),
		"latex-preview render should fail closed for dangerous snippets before compiling",
	);

	const factory = latexPreview.default ?? latexPreview;
	const handlers = new Map();
	let widgetFactory;
	factory({ on: (event, handler) => handlers.set(event, handler) });
	const theme = {
		getFgAnsi: () => "\u001b[38;2;205;214;244m",
		fg: (_color, text) => text,
		bold: (text) => text,
	};
	const ctx = { hasUI: true, ui: { theme, setWidget: (_key, widget) => (widgetFactory = widget) } };
	await handlers.get("agent_end")(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: String.raw`Bad:
\[\input{x}\]` }] }] },
		ctx,
	);
	const fallbackLines = widgetFactory({}, theme).render(80).join("\n");
	assert(fallbackLines.includes("Rendered LaTeX preview"), "latex-preview should keep a compact widget heading");
	assert(!fallbackLines.includes("Not saved to session"), "latex-preview should not show transient-storage help text in the widget");
	assert(!fallbackLines.includes("inline math stays in prose"), "latex-preview should not show inline/display policy help text in the widget");
	assert(fallbackLines.includes("LaTeX preview blocked"), "latex-preview should show blocked render errors in the widget");
	assert(fallbackLines.includes("TeX: \\input{x}"), "latex-preview should include original TeX in render fallbacks");
	await handlers.get("agent_end")(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: mathHeavyWithCode }] }] },
		ctx,
	);
	const realMarkdownRegressionLines = widgetFactory({}, theme).render(80).join("\n");
	handlers.get("session_shutdown")?.({}, ctx);
	assert(realMarkdownRegressionLines.includes("After code."), "latex-preview real Markdown renderer should preserve prose after regex-like code fences");
	assert(realMarkdownRegressionLines.includes("shouldNotRender"), "latex-preview real Markdown renderer should preserve code-fence text without compiling it as TeX");

	class FakeContainer {
		constructor() { this.children = []; }
		addChild(child) { this.children.push(child); }
		render(width) { return this.children.flatMap((child) => typeof child.render === "function" ? child.render(width) : []); }
	}
	class ThrowingMarkdown {
		render() { throw new Error("markdown render failed"); }
	}
	class FakeText {
		constructor(text) { this.text = text; }
		render() { return String(this.text).split("\n"); }
	}
	class FakeSpacer {
		render() { return [""]; }
	}
	latexPreview.configureLatexPreviewRuntime({
		calculateImageRows: () => 1,
		Container: FakeContainer,
		encodeITerm2: () => "",
		encodeKitty: () => "",
		getCapabilities: () => ({}),
		getCellDimensions: () => ({}),
		getMarkdownTheme: () => ({}),
		imageFallback: () => "[image fallback]",
		Markdown: ThrowingMarkdown,
		Spacer: FakeSpacer,
		Text: FakeText,
	});
	const fallbackHandlers = new Map();
	let fallbackWidgetFactory;
	factory({ on: (event, handler) => fallbackHandlers.set(event, handler) });
	await fallbackHandlers.get("agent_end")(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: mathHeavyWithCode }] }] },
		{ hasUI: true, ui: { theme, setWidget: (_key, widget) => (fallbackWidgetFactory = widget) } },
	);
	const markdownFallbackLines = fallbackWidgetFactory({}, theme).render(80).join("\n");
	fallbackHandlers.get("session_shutdown")?.({}, ctx);
	assert(markdownFallbackLines.includes("LaTeX preview Markdown fallback"), "latex-preview should fall back to plain text when Markdown rendering fails");
	assert(markdownFallbackLines.includes("After code."), "latex-preview Markdown fallback should preserve prose after fragile code/math blocks");

	const loaderSource = readFileSync(join(root, "packages", "ben-pi-latex-preview", "extensions", "latex-preview.ts"), "utf8");
	assert(loaderSource.includes("requireCore"), "latex-preview loader should lazy-load the heavy core renderer");
	assert(loaderSource.includes("configureLatexPreviewRuntime"), "latex-preview loader should inject pi runtime dependencies before loading previews");
	const source = readFileSync(join(root, "packages", "ben-pi-latex-preview", "src", "latex-preview-core.ts"), "utf8");
	assert(!source.includes('from "@earendil-works/pi-tui"'), "latex-preview core should not native-require pi-tui peer imports");
	assert(source.includes('"-no-shell-escape"'), "latex-preview should run pdflatex with -no-shell-escape");
	assert(!source.includes("sendMessage"), "latex-preview should not persist preview messages");
	assert(source.includes("encodeKitty(base64Data, { columns: imageWidthCells })"), "latex-preview should not force Kitty image rows");

	if (commandExists("pdflatex") && commandExists("pdftocairo")) {
		const before = latexPreviewTempDirs().length;
		const rendered = await render({ tex: "x^2 + y^2 = z^2", display: true, delimiter: "\\\\[" });
		assert(Boolean(rendered.pngBase64), `latex-preview should render simple math locally: ${rendered.error ?? "no PNG"}`);
		assert(latexPreviewTempDirs().length === before, "latex-preview should clean temporary render directories");
	}
}
