import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const json = process.argv.includes("--json");

const IGNORE_DIRS = new Set([".git", "node_modules"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);
const STALE_PATTERNS = [
	{ pattern: /\bgpt-?5\.2\b|\bgpt5\.2\b/gi, label: "stale GPT-5.2 model reference" },
	{ pattern: /aesthetic-polish\.ts|catppuccin-footer\.ts/g, label: "stale folded UI extension filename" },
	{ pattern: /extensions\/session-continuity\.ts/g, label: "stale session-continuity file path" },
];

function posix(path) {
	return path.split("\\").join("/");
}

function linesOf(file) {
	return readFileSync(file, "utf8").split(/\r?\n/).length;
}

function walk(dir, files = []) {
	if (!existsSync(dir)) return files;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (IGNORE_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, files);
		else if (entry.isFile()) files.push(full);
	}
	return files;
}

function extensionEntrypoints() {
	const dir = join(root, "extensions");
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => {
			const full = join(dir, entry.name);
			if (entry.isFile() && [".ts", ".js"].includes(extname(entry.name))) return [full];
			if (!entry.isDirectory()) return [];
			const packageJson = join(full, "package.json");
			if (existsSync(packageJson)) {
				try {
					const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
					return (manifest.pi?.extensions ?? []).map((path) => join(full, path)).filter(existsSync);
				} catch {
					return [];
				}
			}
			const indexTs = join(full, "index.ts");
			const indexJs = join(full, "index.js");
			if (existsSync(indexTs)) return [indexTs];
			if (existsSync(indexJs)) return [indexJs];
			return [];
		})
		.sort();
}

function groupedExtensionStats(entrypoint) {
	const parent = dirname(entrypoint);
	const isDirectoryEntrypoint = basename(entrypoint).startsWith("index.") && dirname(parent) === join(root, "extensions");
	const files = isDirectoryEntrypoint ? walk(parent).filter((file) => [".ts", ".js"].includes(extname(file))) : [entrypoint];
	return { loc: files.reduce((total, file) => total + linesOf(file), 0), fileCount: files.length };
}

function lineAt(text, index) {
	const start = text.lastIndexOf("\n", index) + 1;
	const end = text.indexOf("\n", index);
	return text.slice(start, end === -1 ? text.length : end);
}

function isAllowedStaleReference(label, line) {
	return label === "stale GPT-5.2 model reference" && /(?:old model|old provider\/model|stale model|call out stale)/i.test(line);
}

function scanStaleReferences(files) {
	const matches = [];
	for (const file of files) {
		const rel = posix(relative(root, file));
		if (rel === "scripts/harness-audit.mjs") continue;
		if (!SOURCE_EXTENSIONS.has(extname(file))) continue;
		const text = readFileSync(file, "utf8");
		for (const { pattern, label } of STALE_PATTERNS) {
			pattern.lastIndex = 0;
			let match;
			while ((match = pattern.exec(text))) {
				if (isAllowedStaleReference(label, lineAt(text, match.index))) continue;
				matches.push({ file: rel, label, match: match[0] });
			}
		}
	}
	return matches;
}

function readJson(relativePath) {
	return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

const issues = [];
const warnings = [];
const packageJson = readJson("package.json");
const entries = extensionEntrypoints();
const extensionGroups = entries.map((entry) => ({ path: posix(relative(root, entry)), ...groupedExtensionStats(entry) }));
const extensionLoc = extensionGroups.reduce((total, entry) => total + entry.loc, 0);
const sourceFiles = walk(root).filter((file) => !posix(relative(root, file)).startsWith("package-lock.json"));
const staleMatches = scanStaleReferences(sourceFiles);

if (!entries.includes(join(root, "extensions", "ui-polish", "index.ts"))) issues.push("missing ui-polish directory extension entrypoint");
if (!entries.includes(join(root, "extensions", "session-continuity", "index.ts"))) issues.push("missing session-continuity directory extension entrypoint");
if (existsSync(join(root, "extensions", "session-continuity.ts"))) issues.push("obsolete extensions/session-continuity.ts still exists");
if (entries.length > 4) issues.push(`runtime extension entrypoint count is ${entries.length}; expected <= 4`);
for (const group of extensionGroups) {
	const limit = group.fileCount > 1 ? 1_200 : 900;
	if (group.loc > limit) warnings.push(`${group.path} is ${group.loc} LOC across ${group.fileCount} file(s); consider another internal split`);
}
for (const match of staleMatches) issues.push(`${match.label}: ${match.file} (${match.match})`);

for (const key of ["extensions", "prompts", "themes"]) {
	if (!Array.isArray(packageJson.pi?.[key]) || packageJson.pi[key].length === 0) issues.push(`package.json pi.${key} must be non-empty`);
}

const optionalLatexFiles = walk(join(root, "packages", "ben-pi-latex-preview")).filter((file) => [".ts", ".js", ".mjs"].includes(extname(file)));
const optionalLatexLoc = optionalLatexFiles.reduce((total, file) => total + linesOf(file), 0);
if (optionalLatexLoc > 1_700) warnings.push(`optional LaTeX preview package is ${optionalLatexLoc} LOC; consider another internal split`);

const result = {
	root,
	packageVersion: packageJson.version,
	metrics: {
		runtimeExtensionEntrypoints: entries.length,
		extensionLoc,
		optionalLatexLoc,
	},
	extensions: extensionGroups,
	issues,
	warnings,
};

if (json) {
	console.log(JSON.stringify(result, null, 2));
} else {
	console.log(`Harness audit: ${root}`);
	console.log(`- version: ${result.packageVersion}`);
	console.log(`- runtime extensions: ${result.metrics.runtimeExtensionEntrypoints}`);
	console.log(`- core extension LOC: ${result.metrics.extensionLoc}`);
	console.log(`- optional LaTeX LOC: ${result.metrics.optionalLatexLoc}`);
	console.log(`- issues: ${issues.length}`);
	console.log(`- warnings: ${warnings.length}`);
	if (issues.length) {
		console.log("\nIssues:");
		for (const issue of issues) console.log(`- ${issue}`);
	}
	if (warnings.length) {
		console.log("\nWarnings:");
		for (const warning of warnings) console.log(`- ${warning}`);
	}
}

if (issues.length) process.exit(1);
