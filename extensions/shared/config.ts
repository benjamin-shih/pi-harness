import { homedir } from "node:os";
import path from "node:path";

const FALLBACK_AGENTS_ROOT = path.join(homedir(), ".agents");

function normalizeRoot(rawPath: string): string {
	let expanded = rawPath;
	if (expanded === "~" || expanded === "$HOME" || expanded === "${HOME}") expanded = homedir();
	else if (expanded.startsWith("~/")) expanded = path.join(homedir(), expanded.slice(2));
	else if (expanded.startsWith("$HOME/")) expanded = path.join(homedir(), expanded.slice(6));
	else if (expanded.startsWith("${HOME}/")) expanded = path.join(homedir(), expanded.slice(8));
	return path.resolve(expanded);
}

export function agentsRoot(): string {
	return normalizeRoot(process.env.AGENTS_SHARED_ROOT || FALLBACK_AGENTS_ROOT);
}

export function agentsScriptPath(scriptName: string): string {
	return path.join(agentsRoot(), "scripts", scriptName);
}

export function skillsRoot(): string {
	return process.env.AGENTS_SKILLS_ROOT ? normalizeRoot(process.env.AGENTS_SKILLS_ROOT) : path.join(agentsRoot(), "skills");
}
