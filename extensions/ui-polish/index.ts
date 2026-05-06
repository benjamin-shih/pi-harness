import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isPiSubagentChild } from "../shared/runtime";
import { installCatppuccinFooter } from "./footer";
import { installPromptPolish } from "./prompt";
import { installTitlebarSpinner } from "./titlebar";
import { installTurnTimer } from "./turn-timer";

export { calculateFooterUsage, compactExtensionStatusItems, formatCount } from "./footer";
export { piTitle, TITLE_SPINNER_FRAMES } from "./titlebar";
export { appendElapsedToAssistantMessage, formatElapsed } from "./turn-timer";

export default function uiPolish(pi: ExtensionAPI) {
	if (isPiSubagentChild()) return;

	installPromptPolish(pi);
	installCatppuccinFooter(pi);
	installTitlebarSpinner(pi);
	installTurnTimer(pi);
}
