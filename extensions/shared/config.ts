import { homedir } from "node:os";
import path from "node:path";

const FALLBACK_AGENTS_ROOT = path.join(homedir(), ".agents");

export function agentsRoot(): string {
	return process.env.AGENTS_SHARED_ROOT || FALLBACK_AGENTS_ROOT;
}

export function agentsScriptPath(scriptName: string): string {
	return path.join(agentsRoot(), "scripts", scriptName);
}

export function skillsRoot(): string {
	return process.env.AGENTS_SKILLS_ROOT || path.join(agentsRoot(), "skills");
}
