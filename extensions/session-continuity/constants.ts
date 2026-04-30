export const CHECKPOINT_TYPE = "ben-continuity-checkpoint";
export const COMPACTION_DIAGNOSTIC_TYPE = "ben-continuity-compaction-diagnostic";
export const CONTINUITY_VERSION = 1;

export const MAX_PROMPT_CHARS = 600;
export const MAX_ITEMS_PER_CHECKPOINT = 24;
export const MAX_LEDGER_CHECKPOINTS = 24;
export const MAX_LEDGER_COMMANDS = 40;
export const MAX_LEDGER_FILES = 80;
export const MAX_SUMMARY_TOKENS = 8192;
export const MIN_CHECKPOINT_INTERVAL_MS = 5 * 60_000;
export const MAX_COMPACTION_PROMPT_CHARS = 120_000;
export const MAX_PREVIOUS_SUMMARY_CHARS = 20_000;
export const MAX_TURN_PREFIX_CHARS = 20_000;
export const MAX_CONVERSATION_CHARS = 70_000;
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 4_000;
export const MAX_GIT_STATUS_CHARS = 4_000;
export const MIN_COMPACTION_PROMPT_CHARS = 2_000;
export const MODEL_PROMPT_CHARS_PER_TOKEN = 3;

export const COMPACTION_SYSTEM_PROMPT = [
	"You are a continuity summarizer for a long-running pi coding-agent session.",
	"Return only the requested structured markdown summary. Preserve facts, blockers, file context, and next actions. Do not expose secrets or command output.",
].join(" ");
