import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SKILLS_ROOT = "/Users/benjaminshih/.agents/skills";

function formatAudit(stdout: string): string {
	try {
		const data = JSON.parse(stdout) as {
			root: string;
			issues: string[];
			warnings: string[];
			metrics: { skillCount: number; skillLinks: number; descriptionChars: number };
		};
		return [
			"## Skills audit",
			`- root: ${data.root}`,
			`- skills: ${data.metrics.skillCount}`,
			`- skill links: ${data.metrics.skillLinks}`,
			`- description chars: ${data.metrics.descriptionChars} (~${Math.ceil(data.metrics.descriptionChars / 4)} tokens)`,
			`- issues: ${data.issues.length}`,
			`- warnings: ${data.warnings.length}`,
			...(data.issues.length ? ["", "### Issues", ...data.issues.map((issue) => `- ${issue}`)] : []),
			...(data.warnings.length ? ["", "### Warnings", ...data.warnings.map((warning) => `- ${warning}`)] : []),
		].join("\n");
	} catch {
		return stdout.trim() || "skills audit produced no output";
	}
}

export default function skillsAudit(pi: ExtensionAPI) {
	pi.registerCommand("skills-audit", {
		description: "Audit the shared .agents skill graph for schema, registry, link, and bloat issues",
		handler: async (args, ctx) => {
			const root = args.trim() || DEFAULT_SKILLS_ROOT;
			const script = join(PACKAGE_ROOT, "scripts", "skills-audit.mjs");
			const result = await pi.exec("node", [script, "--root", root, "--json"], { cwd: PACKAGE_ROOT, timeout: 15_000 });
			const content = result.code === 0 ? formatAudit(result.stdout) : `## Skills audit failed\n\n${result.stderr || result.stdout}`;
			pi.sendMessage({ customType: "skills-audit", content, display: true, details: { root, exitCode: result.code } });
			if (result.code === 0) ctx.ui.notify("Skills audit completed", "info");
			else ctx.ui.notify("Skills audit failed", "error");
		},
	});
}
