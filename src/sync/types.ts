import type { FileEntity } from "../fs/types";

/** A stored record of the last-known synced state for a file */
export interface SyncRecord {
	/** Relative path (primary key) */
	path: string;
	/** Content hash at last successful sync */
	hash: string;
	/** Local mtime at last successful sync (Unix epoch ms) */
	localMtime: number;
	/** Remote mtime at last successful sync (Unix epoch ms) */
	remoteMtime: number;
	/** Local file size at last successful sync */
	localSize: number;
	/** Remote file size at last successful sync */
	remoteSize: number;
	/** Backend-specific metadata snapshot (e.g. Drive contentChecksum) */
	backendMeta?: Record<string, unknown>;
	/** Timestamp when this sync completed (Unix epoch ms) */
	syncedAt: number;
}

/** Combined view of a path across local, remote, and previous sync state */
export interface MixedEntity {
	path: string;
	local?: FileEntity;
	remote?: FileEntity;
	prevSync?: SyncRecord;
}

/**
 * Strategy for resolving conflicts.
 *
 * v2 simplified strategies: auto_merge, duplicate, ask
 * Legacy strategies (keep_newer, keep_local, keep_remote, three_way_merge)
 * are retained for conflict.ts internal use and migration support.
 */
export type ConflictStrategy =
	| "keep_newer"
	| "keep_local"
	| "keep_remote"
	| "duplicate"
	| "three_way_merge"
	| "auto_merge"
	| "ask";

/** A record of a conflict resolution for audit/history purposes */
export interface ConflictRecord {
	path: string;
	actionType: SyncActionType;
	strategy: ConflictStrategy;
	action: "kept_local" | "kept_remote" | "duplicated" | "merged";
	local?: FileEntity;
	remote?: FileEntity;
	duplicatePath?: string;
	hasConflictMarkers?: boolean;
	resolvedAt: string;
	sessionId: string;
}

/** Sync service status */
export type SyncStatus = "idle" | "syncing" | "error" | "partial_error" | "not_connected";

/** v2 pipeline: action types */
export type SyncActionType =
	| "push"
	| "pull"
	| "delete_local"
	| "delete_remote"
	| "conflict"
	| "match"
	| "cleanup";

/** v2 pipeline: a single planned action for a path */
export interface SyncAction {
	path: string;
	action: SyncActionType;
	local?: FileEntity;
	remote?: FileEntity;
	baseline?: SyncRecord;
}

/** v2 pipeline: result of safety checks before execution */
export interface SafetyCheckResult {
	shouldAbort: boolean;
	requiresConfirmation: boolean;
	deletionRatio?: number;
	deletionCount?: number;
}

/** v2 pipeline: the full sync plan */
export interface SyncPlan {
	actions: SyncAction[];
	safetyCheck: SafetyCheckResult;
}
