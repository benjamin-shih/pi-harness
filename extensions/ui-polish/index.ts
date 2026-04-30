import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installCatppuccinFooter } from "./footer";
import { installPromptPolish } from "./prompt";
import { installTitlebarSpinner } from "./titlebar";

export { calculateFooterUsage, compactExtensionStatusItems } from "./footer";
export { piTitle, TITLE_SPINNER_FRAMES } from "./titlebar";

export default function uiPolish(pi: ExtensionAPI) {
	installPromptPolish(pi);
	installCatppuccinFooter(pi);
	installTitlebarSpinner(pi);
}
