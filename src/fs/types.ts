/** Represents a file or folder entity from any filesystem */
export interface FileEntity {
	/** Relative path from the sync root (e.g. "notes/hello.md") */
	path: string;
	/** True if this entity is a directory */
	isDirectory: boolean;
	/** File size in bytes (0 for directories) */
	size: number;
	/**
	 * Last modification time as Unix epoch ms.
	 *
	 * Sentinel value `0` means "unknown" — typically for directories
	 * or backends that don't expose mtime. Comparisons should treat
	 * `0` as "no data" rather than the epoch.
	 */
	mtime: number;
	/**
	 * Content hash (SHA-256 hex).
	 *
	 * Sentinel value `""` means "not computed". `list()` may omit
	 * hash computation for performance; use `stat()` when an
	 * accurate hash is needed. Always `""` for directories.
	 */
	hash: string;
	/** Backend-specific metadata (e.g. Drive file ID, md5Checksum) */
	backendMeta?: Record<string, unknown>;
}

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
	/** File size at last successful sync */
	size: number;
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
