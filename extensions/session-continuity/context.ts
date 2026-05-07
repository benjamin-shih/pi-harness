import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function contextSummary(ctx: ExtensionContext): string | undefined {
	const usage = ctx.getContextUsage();
	if (!usage) return undefined;
	if (usage.tokens === null || usage.percent === null) return `unknown/${usage.contextWindow}`;
	return `${usage.percent.toFixed(1)}% (${usage.tokens}/${usage.contextWindow})`;
}

export function modelSummary(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}
