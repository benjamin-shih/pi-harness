import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildControlCenterState, formatControlCenter, openControlCenterHtml, startControlCenterWeb, stopControlCenterWeb, type ControlCenterOptions } from "./control-center";

type TaskScopeProvider = { ambientScope?: () => { taskId?: string; projectRoot?: string } };

type ControlCenterMode = "card" | "html" | "web" | "web-stop";

function controlCenterOptions(raw: string, taskLayer: TaskScopeProvider): { mode: ControlCenterMode; options: ControlCenterOptions } {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	let mode: ControlCenterMode = "card";
	if (tokens[0] === "html") { mode = "html"; tokens.shift(); }
	else if (tokens[0] === "web" && tokens[1] === "stop") { mode = "web-stop"; tokens.splice(0, 2); }
	else if (tokens[0] === "web") { mode = "web"; tokens.shift(); }
	let project = "";
	let projectRoot = "";
	const promptParts: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--project" && tokens[i + 1]) { project = tokens[++i]; continue; }
		if (token.startsWith("project:")) { project = token.slice("project:".length); continue; }
		if (token === "--project-root" && tokens[i + 1]) { projectRoot = tokens[++i]; continue; }
		promptParts.push(token);
	}
	const taskScope = taskLayer.ambientScope?.() ?? {};
	const prompt = promptParts.join(" ");
	const fallbackProjectRoot = !project && !projectRoot && !prompt ? taskScope.projectRoot : undefined;
	return { mode, options: { prompt, taskId: taskScope.taskId, project: project || undefined, projectRoot: projectRoot || fallbackProjectRoot || undefined } };
}

export function registerControlCenterCommand(pi: ExtensionAPI, taskLayer: TaskScopeProvider): void {
	pi.registerCommand("control-center", {
		description: "Show the read-only local Agent Control Center; use `html`, `web`, or `--project harness`",
		handler: async (args, ctx) => {
			const { mode, options } = controlCenterOptions(args, taskLayer);
			if (mode === "web-stop") {
				const stopped = await stopControlCenterWeb();
				pi.sendMessage({ customType: "harness-control-center", content: ["## Agent Control Center web", `- stopped: ${stopped ? "yes" : "no active server"}`].join("\n"), display: true });
				return;
			}
			if (mode === "web") {
				const result = await startControlCenterWeb(pi, ctx.cwd, options);
				pi.sendMessage({ customType: "harness-control-center", content: ["## Agent Control Center web", `- url: ${result.url}`, `- opened: ${result.opened ? "yes" : "no"}`, ...(result.error ? [`- warning: ${result.error}`] : []), "- mode: read-only local web dashboard with refresh"].join("\n"), display: true });
				return;
			}
			if (mode === "html") {
				const result = await openControlCenterHtml(pi, ctx.cwd, options);
				pi.sendMessage({ customType: "harness-control-center", content: ["## Agent Control Center v0", `- html: ${result.path ? result.path : "not generated"}`, `- opened: ${result.opened ? "yes" : "no"}`, ...(result.error ? [`- warning: ${result.error}`] : []), "- mode: read-only static dashboard"].join("\n"), display: true });
				return;
			}
			pi.sendMessage({ customType: "harness-control-center", content: formatControlCenter(await buildControlCenterState(pi, ctx.cwd, options)), display: true });
		},
	});
}
