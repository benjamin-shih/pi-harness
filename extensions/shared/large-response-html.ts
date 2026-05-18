import { join } from "node:path";
import { agentsRoot } from "./config";
import type { TaskWeight } from "./prompt-guidance";

function htmlArtifactSourcePaths() {
	const root = agentsRoot();
	const templatesRoot = join(root, "shared", "templates", "html-artifacts");
	return {
		policy: join(root, "policy", "html-artifacts.json"),
		templateReadme: join(templatesRoot, "README.md"),
		reportTemplate: join(templatesRoot, "benjamin-report-template.html"),
		dashboardTemplate: join(templatesRoot, "benjamin-dashboard-template.html"),
	};
}

function cleanInline(value: string): string {
	return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function explicitlyInlineOnly(text: string): boolean {
	return /\b(no html|do not use html|don't use html|inline only|chat only|no artifact|do not create an artifact|don't create an artifact)\b/i.test(text);
}

function mentionsHtmlArtifact(text: string): boolean {
	return /\b(html|artifact|dashboard|local[- ]artifact|\.html)\b/i.test(text);
}

function asksForStructuredDeliverable(text: string): boolean {
	return /\b(report|plan|roadmap|status update|implementation status|review|decision memo|brief|explainer|dashboard|control center|architecture|writeup|postmortem|retrospective|where we are|what'?s next|next steps)\b/i.test(text);
}

function asksForLongOrVisual(text: string): boolean {
	return /\b(long|lengthy|large|comprehensive|detailed|thorough|manager[- ]ready|decision[- ]grade|presentation|visual|diagram|flowchart|workflow|timeline|table|comparison)\b/i.test(text);
}

function taskContextMentionsHtmlArtifact(taskContext: string | undefined): boolean {
	return Boolean(taskContext && /\b(html artifacts?|html_report|html_dashboard|local-artifacts|\.html)\b/i.test(taskContext));
}

export function shouldUseLargeResponseHtmlGuidance(prompt: string, weight: TaskWeight, taskContext?: string): boolean {
	if (weight === "trivial") return false;
	const text = cleanInline(prompt);
	if (!text || explicitlyInlineOnly(text)) return false;
	if (mentionsHtmlArtifact(text)) return true;
	if (asksForStructuredDeliverable(text) && asksForLongOrVisual(text)) return true;
	if (taskContextMentionsHtmlArtifact(taskContext) && (asksForStructuredDeliverable(text) || asksForLongOrVisual(text))) return true;
	return false;
}

export function largeResponseHtmlGuidance(prompt: string, weight: TaskWeight, taskContext?: string): string | undefined {
	if (!shouldUseLargeResponseHtmlGuidance(prompt, weight, taskContext)) return undefined;
	const paths = htmlArtifactSourcePaths();
	return [
		"## Large Response HTML Medium",
		"When the substantive answer would become a lengthy report, plan, status update, review, dashboard, explainer, or other visually structured deliverable, use a local HTML artifact as the medium instead of a long chat wall.",
		"Keep the chat response concise: conclusion/current state, local artifact path, what changed, and recommended next action.",
		`Before creating or substantially editing an artifact, read ${paths.policy} and ${paths.templateReadme}. Use the Benjamin-themed report/dashboard/article templates such as ${paths.reportTemplate} or ${paths.dashboardTemplate} unless explicitly told otherwise.`,
		"Do not force required sections; choose the sections, tables, timelines, or SVG diagrams that best communicate the actual content. Preserve any existing artifact's presentation contract before editing it.",
		"Keep artifacts local/static and exclude raw prompts, transcripts, private IDs, credentials, raw stdout/stderr, raw worker summaries, and private artifact/lane paths unless explicitly safe and requested.",
	].join("\n");
}

export function largeResponseHtmlCompactionReminder(artifactPaths: Iterable<string>, guidanceActive: boolean): string | undefined {
	const paths = [...new Set([...artifactPaths].filter(Boolean))].slice(0, 8);
	if (!guidanceActive && paths.length === 0) return undefined;
	const sources = htmlArtifactSourcePaths();
	return [
		"## Large Response HTML Artifact Continuity",
		"For lengthy reports, plans, implementation status updates, reviews, dashboards, or explainers, continue using a local HTML artifact as the primary medium with a concise chat summary.",
		`Policy/template source files to reread after compaction: ${sources.policy}; ${sources.templateReadme}.`,
		"Use the Benjamin-themed report/dashboard/article visual system unless explicitly told otherwise. Do not replace a rich artifact with an ad hoc simplified layout; inspect the current artifact and preserve its presentation contract before editing.",
		"Do not force fixed required sections; choose content-specific tables, timelines, SVG diagrams, and next-action sections only when they clarify the report.",
		...(paths.length ? ["Known local HTML artifact paths from this session:", ...paths.map((path) => `- ${path}`)] : []),
	].join("\n");
}
