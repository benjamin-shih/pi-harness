export type InboxProject = { id?: string; name?: string; root?: string; match_type?: string } | null;

export type InboxItem = {
	id?: string;
	status?: string;
	priority?: string;
	safe_title?: string;
	project?: InboxProject;
	relation?: { kind?: string; target_item_id?: string; reason?: string };
	route?: { confidence?: number; match_type?: string };
	execution?: { worker_run_id?: string; backend?: string; async_dir?: string };
	summary?: { available?: boolean; safe_text?: string };
	control?: { state?: string; status?: string; gate_state?: string; needs_review?: boolean; needs_apply?: boolean; next_action?: string; cleanup?: { state?: string; diagnostic_available?: boolean; destructive_actions?: boolean } };
};

export type InboxListPayload = { inbox_api_version?: number; count?: number; returned?: number; summary?: { by_status?: Record<string, number>; by_control_state?: Record<string, number>; by_cleanup_state?: Record<string, number>; by_project?: Record<string, number>; active_by_project?: Record<string, number>; queued_by_project?: Record<string, number>; review_by_project?: Record<string, number>; apply_by_project?: Record<string, number>; cleanup_by_project?: Record<string, number> }; items?: InboxItem[] };
export type InboxEnqueuePayload = { inbox_api_version?: number; enqueued?: boolean; item?: InboxItem; warnings?: string[] };

export type InboxLaunchSpec = {
	backend?: string;
	worker_run_id?: string;
	params?: Record<string, unknown>;
	policy?: Record<string, unknown>;
};

export type InboxSchedulePayload = {
	inbox_api_version?: number;
	action?: string;
	items?: Array<{ item?: InboxItem; action?: string; reason?: string; launch_spec?: InboxLaunchSpec }>;
	launch_specs?: InboxLaunchSpec[];
	warnings?: string[];
};
