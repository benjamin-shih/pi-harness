import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installCatppuccinFooter } from "./footer";
import { installPromptPolish } from "./prompt";

export { calculateFooterUsage, compactExtensionStatusItems } from "./footer";

export default function uiPolish(pi: ExtensionAPI) {
	installPromptPolish(pi);
	installCatppuccinFooter(pi);
}
