import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TaskWeight } from "../shared/prompt-guidance";

export type BindAction = "created" | "claimed_existing" | "refreshed_existing" | "skipped" | "blocked" | "error";

export type BindResult = {
	task_api_version?: number;
	action: BindAction;
	bound: boolean;
	blocked: boolean;
	reason: string;
	task_id: string;
	project_root: string;
};

export type TaskClassification = {
	task_api_version?: number;
	weight: TaskWeight;
	binding_mode: "auto" | "skip" | "reuse_only";
};

export type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

export type TaskApiInfo = {
	task_api_version: number;
	agents_shared_root: string;
	capabilities: string[];
};

export type ArtifactAddResult = {
	artifact_api_version?: number;
	recorded: boolean;
};

export type ArtifactListResult = {
	artifact_api_version?: number;
	count: number;
};

export type TaskLifecycleResult = {
	task_api_version?: number;
	status: string;
	valid_status: boolean;
	terminal: boolean;
	active: boolean;
	next_action: string;
	blockers_count: number;
	closed_at: string;
	has_closure_reason: boolean;
	lease: { state: "none" | "live" | "expired"; runtime: string; owner: string; session: string; expires_at: string };
	route: { primary_runtime: string; review_runtime: string; effort: string; handoff_required: boolean };
	events: { count: number; last_type: string; last_timestamp: string };
};

export type CandidateRootResult = {
	task_api_version: number;
	project_root: string;
	bindable: boolean;
	auto_create: "auto" | "never";
};

export type TaskActivity = {
	reads: number;
	writes: number;
	commands: number;
	errors: number;
};

export type TaskLayerState = {
	sessionId: string;
	apiChecked: boolean;
	apiAvailable: boolean;
	apiInfo?: TaskApiInfo;
	currentPromptWeight: TaskWeight;
	currentBindingMode: TaskClassification["binding_mode"];
	currentPromptNeedsTask: boolean;
	meaningfulActivity: boolean;
	activity: TaskActivity;
	artifactCount: number;
	artifactRecordedThisTurn: number;
	artifactSkipped: number;
	active?: BindResult;
	context?: string;
	lastAction?: BindAction;
	lastReason?: string;
	lastError?: string;
	lastHeartbeatAt: number;
};

export const SUPPORTED_TASK_API_VERSION = 1;
export const SUPPORTED_ARTIFACT_API_VERSION = 1;
export const HEARTBEAT_INTERVAL_MS = 60_000;

export function emptyActivity(): TaskActivity {
	return { reads: 0, writes: 0, commands: 0, errors: 0 };
}

export function supportsTaskArtifacts(state: TaskLayerState): boolean {
	return Boolean(state.apiInfo?.capabilities?.includes("task_artifacts"));
}

export function supportsTaskLifecycle(state: TaskLayerState): boolean {
	return Boolean(state.apiInfo?.capabilities?.includes("task_lifecycle"));
}
