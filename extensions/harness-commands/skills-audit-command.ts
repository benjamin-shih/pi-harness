import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { skillsRoot } from "../shared/config";
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
			...(data.issues.length ? ["", "## Issues", ...data.issues.map((issue) => `- ${issue}`)] : []),
			...(data.warnings.length ? ["", "## Warnings", ...data.warnings.map((warning) => `- ${warning}`)] : []),
		].join("\n");
	} catch {
		return stdout.trim() || "skills audit produced no output";
	}
}
export function registerSkillsAuditCommand(pi: ExtensionAPI, packageRoot: string): void {
	pi.registerCommand("skills-audit", {
		description: "Audit the shared .agents skill graph for schema, registry, link, and bloat issues",
		handler: async (args: string, ctx: ExtensionContext) => {
			const root = args.trim() || skillsRoot();
			const script = join(packageRoot, "scripts", "skills-audit.mjs");
			const result = await pi.exec("node", [script, "--root", root, "--json"], { cwd: packageRoot, timeout: 15_000 });
			const content = result.code === 0 ? formatAudit(result.stdout) : `## Skills audit failed\n\n${result.stderr || result.stdout}`;
			pi.sendMessage({ customType: "skills-audit", content, display: true, details: { root, exitCode: result.code } });
			ctx.ui.notify(result.code === 0 ? "Skills audit completed" : "Skills audit failed", result.code === 0 ? "info" : "error");
		},
	});
}
