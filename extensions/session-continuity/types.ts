export type ContinuityCommand = {
	command: string;
	status: "ok" | "error" | "unknown";
};

export type ContinuityCheckpoint = {
	version: number;
	reason: "agent_end" | "compact" | "shutdown";
	timestamp: string;
	cwd: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	context?: string;
	prompt?: string;
	filesRead: string[];
	filesModified: string[];
	commands: ContinuityCommand[];
	toolErrors: string[];
};

export type TurnState = {
	prompt?: string;
	filesRead: Set<string>;
	filesModified: Set<string>;
	commands: ContinuityCommand[];
	toolErrors: string[];
};

export type ContinuityLedger = {
	checkpoints: ContinuityCheckpoint[];
	filesRead: string[];
	filesModified: string[];
	commands: ContinuityCommand[];
	toolErrors: string[];
};

export type PromptSizing = {
	promptChars: number;
	conversationChars: number;
	turnPrefixChars: number;
	previousSummaryChars: number;
	customInstructionsChars: number;
	gitStatusChars: number;
	messagesToSummarize: number;
	turnPrefixMessages: number;
	tokensBefore: number;
	promptBudgetChars: number;
	maxSummaryTokens: number;
	isSplitTurn: boolean;
	firstKeptEntryId: string;
};

export type CompactionDiagnosticReason = "no_model" | "no_api_key" | "aborted" | "empty_summary" | "exception" | "default_compaction";

export type ContinuityCompactionDiagnostic = {
	version: number;
	timestamp: string;
	reason: CompactionDiagnosticReason;
	cwd: string;
	model?: string;
	thinking?: string;
	error?: string;
	fallbackReturned: boolean;
	promptSizing?: PromptSizing;
	compactionId?: string;
	fromExtension?: boolean;
};
