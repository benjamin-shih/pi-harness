import { MAX_COMPACTION_PROMPT_CHARS, MAX_CONVERSATION_CHARS, MAX_CUSTOM_INSTRUCTIONS_CHARS, MAX_GIT_STATUS_CHARS, MAX_LEDGER_FILES, MAX_PREVIOUS_SUMMARY_CHARS, MAX_TURN_PREFIX_CHARS, MIN_COMPACTION_PROMPT_CHARS } from "./constants";
import { uniqueSorted } from "./checkpoints";
import { compactSerializedConversation, redactSensitiveText, truncateMiddle, truncateText } from "./redaction";
import type { ContinuityCommand, ContinuityLedger, CompactionDiagnosticReason, PromptSizing } from "./types";

function bulletList(items: string[], empty = "- None recorded."): string {
	if (!items.length) return empty;
	return items.map((item) => `- ${item}`).join("\n");
}

function commandList(commands: ContinuityCommand[]): string {
	if (!commands.length) return "- None recorded.";
	return commands.map((command) => `- ${command.status}: ${command.command}`).join("\n");
}

function checkpointList(checkpoints: ContinuityLedger["checkpoints"]): string {
	if (!checkpoints.length) return "- None recorded.";
	return checkpoints
		.slice(-8)
		.map((checkpoint) => {
			const parts = [checkpoint.timestamp, checkpoint.reason, checkpoint.prompt ? `prompt: ${checkpoint.prompt}` : undefined]
				.filter(Boolean)
				.join(" | ");
			return `- ${parts}`;
		})
		.join("\n");
}

type SummaryFileOps = { readFiles?: string[]; modifiedFiles?: string[] };
type PiFileOps = { read?: Iterable<string>; written?: Iterable<string>; edited?: Iterable<string> };
type FileOpsInput = SummaryFileOps | PiFileOps;

function toArray(value: Iterable<string> | undefined): string[] {
	return value ? Array.from(value) : [];
}

function normalizeFileOps(fileOps: FileOpsInput | undefined): SummaryFileOps {
	if (!fileOps) return {};
	if ("readFiles" in fileOps || "modifiedFiles" in fileOps) return fileOps;
	const piFileOps = fileOps as PiFileOps;
	const modified = new Set([...toArray(piFileOps.written), ...toArray(piFileOps.edited)]);
	const readFiles = toArray(piFileOps.read).filter((file) => !modified.has(file));
	return { readFiles, modifiedFiles: Array.from(modified) };
}

function fileOpsList(fileOps: FileOpsInput | undefined, key: "readFiles" | "modifiedFiles"): string {
	const normalized = normalizeFileOps(fileOps);
	return bulletList(uniqueSorted(normalized[key] ?? [], MAX_LEDGER_FILES));
}

export function buildContinuitySummaryPrompt(args: {
	previousSummary?: string;
	conversationText: string;
	turnPrefixText?: string;
	ledger: ContinuityLedger;
	fileOps?: FileOpsInput;
	customInstructions?: string;
	gitStatus?: string;
	maxPromptChars?: number;
}): string {
	const maxPromptChars = Math.max(MIN_COMPACTION_PROMPT_CHARS, Math.min(args.maxPromptChars ?? MAX_COMPACTION_PROMPT_CHARS, MAX_COMPACTION_PROMPT_CHARS));
	const previous = truncateMiddle(redactSensitiveText(args.previousSummary?.trim() || "None."), MAX_PREVIOUS_SUMMARY_CHARS, "previous summary");
	const conversationText = truncateMiddle(compactSerializedConversation(args.conversationText || "None."), MAX_CONVERSATION_CHARS, "conversation");
	const turnPrefix = truncateMiddle(compactSerializedConversation(args.turnPrefixText?.trim() || "None."), MAX_TURN_PREFIX_CHARS, "turn prefix");
	const customInstructions = truncateMiddle(redactSensitiveText(args.customInstructions?.trim() || "None."), MAX_CUSTOM_INSTRUCTIONS_CHARS, "custom instructions");
	const gitStatus = truncateMiddle(redactSensitiveText(args.gitStatus?.trim() || "Not checked."), MAX_GIT_STATUS_CHARS, "git status");

	const prompt = `You are generating a durable continuity summary for a long-running pi coding-agent session.

Your job is to preserve exactly what a future agent needs to continue after compaction. Be concise, factual, and operational. Do not invent work. Do not include secret values, command output, or credentials. If something is unknown, say unknown.

Use exactly these markdown sections:

## Goal
## Current State
## Constraints / Preferences
## Decisions Made
## Files Read
## Files Modified
## Commands / Verification
## Active Skills / Routing
## Subagents / Intercom State
## Blockers / Open Questions
## Next Exact Actions
## Critical Continuation Notes

Previous continuity summary:
<previous-summary>
${previous}
</previous-summary>

Custom compaction instructions:
<custom-instructions>
${customInstructions}
</custom-instructions>

Current git status summary:
<git-status>
${gitStatus}
</git-status>

Deterministic continuity ledger:
<ledger>
Recent checkpoints:
${checkpointList(args.ledger.checkpoints)}

Files read from checkpoints:
${bulletList(args.ledger.filesRead)}

Files modified from checkpoints:
${bulletList(args.ledger.filesModified)}

Commands recorded from checkpoints:
${commandList(args.ledger.commands)}

Tool errors recorded from checkpoints:
${bulletList(args.ledger.toolErrors)}
</ledger>

Pi file operation tracker:
<file-ops>
Files read:
${fileOpsList(args.fileOps, "readFiles")}

Files modified:
${fileOpsList(args.fileOps, "modifiedFiles")}
</file-ops>

Split-turn prefix, if any:
<turn-prefix>
${turnPrefix}
</turn-prefix>

Conversation being compacted:
<conversation>
${conversationText}
</conversation>`;

	return prompt.length <= maxPromptChars
		? prompt
		: truncateMiddle(prompt, maxPromptChars, "continuity compaction prompt");
}

export function extractSummaryText(response: { content?: Array<{ type: string; text?: string }> }): string {
	return (response.content ?? [])
		.filter((content): content is { type: "text"; text: string } => content.type === "text" && typeof content.text === "string")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

export function buildDeterministicContinuitySummary(args: {
	ledger: ContinuityLedger;
	fileOps?: FileOpsInput;
	previousSummary?: string;
	customInstructions?: string;
	gitStatus?: string;
	reason: CompactionDiagnosticReason;
	error?: string;
	promptSizing?: PromptSizing;
}): string {
	const recentPrompts = args.ledger.checkpoints.map((checkpoint) => checkpoint.prompt).filter((prompt): prompt is string => Boolean(prompt));
	const previous = truncateMiddle(redactSensitiveText(args.previousSummary?.trim() || "None recorded."), 8_000, "previous summary");
	return redactSensitiveText(`## Goal
${recentPrompts.length ? bulletList(recentPrompts.slice(-5)) : "- Unknown from deterministic fallback. Use recent checkpoints and preserved files to continue."}

## Current State
- Memory spine used deterministic fallback during compaction.
- Fallback reason: ${args.reason}.
${args.error ? `- Error: ${truncateText(args.error, 500)}.` : "- Error: None recorded."}
${args.promptSizing ? `- Tokens before compaction: ${args.promptSizing.tokensBefore}.` : "- Tokens before compaction: unknown."}
${args.promptSizing ? `- Prompt chars: ${args.promptSizing.promptChars}.` : "- Prompt chars: unknown."}

## Constraints / Preferences
- Preserve session continuity without command output or secrets.
- Prefer checkpoint/file metadata when model summarization fails.
- Previous summary: ${previous}
- Custom instructions: ${truncateMiddle(redactSensitiveText(args.customInstructions?.trim() || "None."), 2_000, "custom instructions")}

## Decisions Made
- Custom model compaction did not complete; harness fallback summary was returned instead of pi default compaction.

## Files Read
${bulletList(uniqueSorted([...(args.ledger.filesRead ?? []), ...(normalizeFileOps(args.fileOps).readFiles ?? [])], MAX_LEDGER_FILES))}

## Files Modified
${bulletList(uniqueSorted([...(args.ledger.filesModified ?? []), ...(normalizeFileOps(args.fileOps).modifiedFiles ?? [])], MAX_LEDGER_FILES))}

## Commands / Verification
${commandList(args.ledger.commands)}

## Active Skills / Routing
- Unknown unless captured in recent checkpoints or previous summary.

## Subagents / Intercom State
- Unknown unless captured in recent checkpoints or previous summary.

## Blockers / Open Questions
- Investigate memory-spine compaction diagnostic reason: ${args.reason}.

## Next Exact Actions
- Inspect recent session entries and files modified above.
- Continue from the latest user request and checkpoint ledger.
- If compaction diagnostics persist, inspect ben-continuity-compaction-diagnostic entries.

## Critical Continuation Notes
- This is a deterministic fallback summary, not an LLM-generated summary.
- Current git status at compaction:
${truncateMiddle(redactSensitiveText(args.gitStatus?.trim() || "Not checked."), 2_000, "git status")}`);
}
