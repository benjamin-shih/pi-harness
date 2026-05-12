import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ORCHESTRATOR_PREFIX = "[ORCHESTRATOR]";

type SessionNamingAPI = ExtensionAPI & {
	getSessionName?: () => string | undefined;
	setSessionName?: (name: string) => void;
};

function stripOrchestratorPrefix(name: string): string {
	return name.replace(/^\s*\[ORCHESTRATOR\]\s*/i, "").trim();
}

function defaultLabel(pi: SessionNamingAPI): string {
	const existing = stripOrchestratorPrefix(pi.getSessionName?.() || "");
	return existing || "front-door";
}

export function registerOrchestratorCommand(pi: ExtensionAPI): void {
	const namedPi = pi as SessionNamingAPI;
	pi.registerCommand("orchestrator", {
		description: "Tag this Pi session as an [ORCHESTRATOR] for pi -r selectors; use `off` to clear",
		handler: async (args, ctx) => {
			if (typeof namedPi.setSessionName !== "function") {
				ctx.ui.notify("This Pi runtime does not expose session naming.", "error");
				return;
			}
			const trimmed = args.trim();
			const [first, ...rest] = trimmed.split(/\s+/).filter(Boolean);
			const action = (first || "on").toLowerCase();
			if (action === "off" || action === "clear" || action === "disable") {
				const next = stripOrchestratorPrefix(namedPi.getSessionName?.() || "");
				namedPi.setSessionName(next);
				ctx.ui.notify(next ? `Cleared orchestrator tag: ${next}` : "Cleared orchestrator tag.", "info");
				return;
			}
			if (action === "status") {
				const current = namedPi.getSessionName?.() || "";
				const tagged = /^\s*\[ORCHESTRATOR\]/i.test(current);
				ctx.ui.notify(tagged ? `Orchestrator tag active: ${current}` : "Orchestrator tag is not active.", "info");
				return;
			}
			const explicitLabel = action === "on" || action === "enable" ? rest.join(" ") : trimmed;
			const label = stripOrchestratorPrefix(explicitLabel || defaultLabel(namedPi));
			const next = `${ORCHESTRATOR_PREFIX} ${label}`.trim();
			namedPi.setSessionName(next);
			ctx.ui.notify(`Tagged session as ${next}. It should appear that way in pi -r selectors.`, "info");
		},
	});
}
