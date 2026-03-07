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
	/** Backend-specific metadata snapshot (e.g. Drive file ID) */
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

/** Possible sync decisions */
export type DecisionType =
	| "local_created_push"
	| "remote_created_pull"
	| "local_modified_push"
	| "remote_modified_pull"
	| "local_deleted_propagate"
	| "remote_deleted_propagate"
	| "initial_match"
	| "conflict_both_modified"
	| "conflict_both_created"
	| "conflict_delete_vs_modify"
	| "both_deleted_cleanup"
	| "no_action";

/** Strategy for resolving conflicts */
export type ConflictStrategy =
	| "keep_newer"
	| "keep_local"
	| "keep_remote"
	| "duplicate"
	| "three_way_merge"
	| "ask";

/** A computed sync decision for a single path */
export interface SyncDecision {
	path: string;
	decision: DecisionType;
	local?: FileEntity;
	remote?: FileEntity;
	prevSync?: SyncRecord;
}

/** A record of a conflict resolution for audit/history purposes */
export interface ConflictRecord {
	path: string;
	decisionType: DecisionType;
	strategy: ConflictStrategy;
	action: "kept_local" | "kept_remote" | "duplicated" | "merged";
	local?: FileEntity;
	remote?: FileEntity;
	duplicatePath?: string;
	hasConflictMarkers?: boolean;
	resolvedAt: string;
	sessionId: string;
}
