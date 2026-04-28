import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

function formatCount(n: number): string {
	if (n < 1_000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}m`;
}

const SEGMENT_BG = "customMessageBg";

function fgFromBg(theme: any, bgColor: string, text: string): string {
	const bgAnsi = theme.getBgAnsi(bgColor) as string;
	const fgAnsi = bgAnsi.replace("[48;", "[38;");
	return `${fgAnsi}${text}\x1b[39m`;
}

function segment(theme: any, label: string, value: string, color = "text"): string {
	return (
		fgFromBg(theme, SEGMENT_BG, "") +
		theme.bg(
			SEGMENT_BG,
			theme.fg("customMessageLabel", ` ${label} `) + theme.fg(color, ` ${value} `),
		) +
		fgFromBg(theme, SEGMENT_BG, "")
	);
}

function fits(width: number, left: string, right: string): boolean {
	const gap = left && right ? 1 : 0;
	return visibleWidth(left) + gap + visibleWidth(right) <= width;
}

function footerLine(width: number, left: string, right: string): string {
	if (width <= 0) return "";
	if (!left) return truncateToWidth(right, width, "");
	if (!right) return truncateToWidth(left, width, "");

	const minGap = 1;
	const rightWidth = visibleWidth(right);
	const maxLeftWidth = width - rightWidth - minGap;
	if (maxLeftWidth <= 0) return truncateToWidth(right, width, "");

	const safeLeft = truncateToWidth(left, maxLeftWidth, "");
	const padding = " ".repeat(Math.max(minGap, width - visibleWidth(safeLeft) - rightWidth));
	return truncateToWidth(safeLeft + padding + right, width, "");
}

export default function catppuccinFooter(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;
					let compacts = 0;

					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "compaction") {
							compacts++;
							continue;
						}

						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const message = entry.message as AssistantMessage;
						const usage = message.usage;
						if (!usage) continue;

						input += usage.input ?? 0;
						output += usage.output ?? 0;
						cacheRead += usage.cacheRead ?? 0;
						cacheWrite += usage.cacheWrite ?? 0;
						cost += usage.cost?.total ?? 0;
					}

					const cache = cacheRead + cacheWrite;
					const total = input + output + cache;
					const branch = footerData.getGitBranch();
					const model = ctx.model?.id ?? "no-model";
					const thinkingLevel = pi.getThinkingLevel();
					const sep = theme.fg("dim", " ");

					const piMark = theme.fg("accent", " π ");
					const fullLeft = [
						piMark,
						segment(theme, "tok", formatCount(total), "text"),
						segment(theme, "in", formatCount(input), "syntaxFunction"),
						segment(theme, "out", formatCount(output), "success"),
						segment(theme, "cache", formatCount(cache), "mdCode"),
						segment(theme, "compact", `${compacts}`, compacts > 0 ? "warning" : "dim"),
						segment(theme, "$", cost.toFixed(3), "syntaxNumber"),
					].join(sep);

					const mediumLeft = [
						piMark,
						segment(theme, "tok", formatCount(total), "text"),
						segment(theme, "in", formatCount(input), "syntaxFunction"),
						segment(theme, "out", formatCount(output), "success"),
						segment(theme, "$", cost.toFixed(3), "syntaxNumber"),
						compacts > 0 ? segment(theme, "cmp", `${compacts}`, "warning") : "",
					]
						.filter(Boolean)
						.join(sep);

					const compactLeft = [
						piMark,
						theme.fg("muted", `tok ${formatCount(total)}`),
						theme.fg("dim", `$${cost.toFixed(3)}`),
					].join(sep);

					const modelAndThinking = [
						segment(theme, "model", model, "borderAccent"),
						segment(theme, "think", thinkingLevel, thinkingLevel === "off" ? "dim" : "warning"),
					].join(sep);
					const branchSegment = branch ? segment(theme, "git", ` ${branch}`, "muted") : undefined;
					const fullRight = branchSegment
						? [modelAndThinking, branchSegment].join(theme.fg("dim", "  │  "))
						: modelAndThinking;

					const variants = [
						{ left: fullLeft, right: fullRight },
						{ left: fullLeft, right: modelAndThinking },
						{ left: mediumLeft, right: fullRight },
						{ left: mediumLeft, right: modelAndThinking },
						{ left: compactLeft, right: modelAndThinking },
						{ left: piMark, right: modelAndThinking },
						{ left: "", right: modelAndThinking },
					];
					const selected = variants.find((variant) => fits(width, variant.left, variant.right)) ?? variants.at(-1)!;
					return [footerLine(width, selected.left, selected.right)];
				},
			};
		});
	});
}
