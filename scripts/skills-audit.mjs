import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_ROOT = "/Users/benjaminshih/.agents/skills";

function parseArgs(argv) {
	const args = { root: DEFAULT_ROOT, json: false, allowMissing: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") args.json = true;
		else if (arg === "--allow-missing") args.allowMissing = true;
		else if (arg === "--root") args.root = argv[++i] ?? args.root;
		else if (!arg.startsWith("--")) args.root = arg;
	}
	return args;
}

function frontmatter(text) {
	const match = text.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	const out = {};
	for (const line of match[1].split(/\r?\n/)) {
		const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!m) continue;
		out[m[1]] = m[2].trim().replace(/^['\"]|['\"]$/g, "");
	}
	return out;
}

function markdownLinks(text) {
	return Array.from(text.matchAll(/\]\(([^)]+)\)/g)).map((match) => match[1]);
}

function skillSectionLinks(text, heading) {
	const lines = text.split(/\r?\n/);
	const links = [];
	let active = false;
	for (const line of lines) {
		if (line.trim() === `## ${heading}`) {
			active = true;
			continue;
		}
		if (active && line.startsWith("## ")) break;
		if (!active || !line.trim().startsWith("-")) continue;
		const match = line.match(/\]\(([^)]+)\)/);
		if (match) links.push(match[1]);
	}
	return links;
}

function audit(rootPath) {
	const root = resolve(rootPath);
	const result = {
		root,
		skills: [],
		issues: [],
		warnings: [],
		metrics: {
			skillCount: 0,
			skillLinks: 0,
			descriptionChars: 0,
		},
	};

	if (!existsSync(root)) {
		result.issues.push(`skills root does not exist: ${root}`);
		return result;
	}

	const indexPath = join(root, "SKILLS.md");
	const indexText = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
	if (!indexText) result.issues.push("missing SKILLS.md");

	const skillFiles = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name, "SKILL.md"))
		.filter((path) => existsSync(path))
		.sort();

	const names = new Map();
	for (const skillPath of skillFiles) {
		const dirName = basename(dirname(skillPath));
		const text = readFileSync(skillPath, "utf8");
		const fm = frontmatter(text);
		const name = fm.name ?? "";
		const description = fm.description ?? "";
		const dependsOn = skillSectionLinks(text, "Depends on");
		const related = skillSectionLinks(text, "Related");
		const links = markdownLinks(text).filter((link) => link.includes("SKILL.md"));

		result.skills.push({
			dir: dirName,
			name,
			descriptionChars: description.length,
			lines: text.split(/\r?\n/).length,
			dependsOn: dependsOn.length,
			related: related.length,
		});
		result.metrics.descriptionChars += description.length;
		result.metrics.skillLinks += links.length;

		if (!name) result.issues.push(`${dirName}: missing frontmatter name`);
		if (!description) result.issues.push(`${dirName}: missing frontmatter description`);
		if (name && name !== dirName) result.issues.push(`${dirName}: frontmatter name does not match directory (${name})`);
		if (description.length > 280) result.warnings.push(`${dirName}: long description (${description.length} chars)`);
		if (indexText && !indexText.includes(`${dirName}/SKILL.md`)) result.issues.push(`${dirName}: missing from SKILLS.md`);
		if (names.has(name)) result.issues.push(`${dirName}: duplicate skill name ${name}`);
		if (name) names.set(name, dirName);

		for (const link of links) {
			const target = resolve(dirname(skillPath), link);
			if (!existsSync(target)) result.issues.push(`${dirName}: broken skill link ${link}`);
		}
	}

	result.metrics.skillCount = skillFiles.length;
	return result;
}

function printText(result) {
	console.log(`Skills audit: ${result.root}`);
	console.log(`- skills: ${result.metrics.skillCount}`);
	console.log(`- skill links: ${result.metrics.skillLinks}`);
	console.log(`- description chars: ${result.metrics.descriptionChars}`);
	console.log(`- approx description tokens: ${Math.ceil(result.metrics.descriptionChars / 4)}`);
	console.log(`- issues: ${result.issues.length}`);
	console.log(`- warnings: ${result.warnings.length}`);
	if (result.issues.length) {
		console.log("\nIssues:");
		for (const issue of result.issues) console.log(`- ${issue}`);
	}
	if (result.warnings.length) {
		console.log("\nWarnings:");
		for (const warning of result.warnings) console.log(`- ${warning}`);
	}
}

const args = parseArgs(process.argv.slice(2));
const result = audit(args.root);
if (args.json) console.log(JSON.stringify(result, null, 2));
else printText(result);

if (result.issues.length && !(args.allowMissing && result.issues.every((issue) => issue.startsWith("skills root does not exist")))) {
	process.exitCode = 1;
}
