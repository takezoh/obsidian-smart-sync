import type { DriveFile, DriveChange } from "./types";
import { FOLDER_MIME } from "./types";
import type { DriveMetadataCache } from "./metadata-cache";
import type { DriveClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import type { FolderHierarchy } from "./folder-hierarchy";
import { resolvePathFromHierarchy } from "./folder-hierarchy";
import type { FileEntity } from "../types";

/** Context for incremental sync operations */
export interface IncrementalSyncContext {
	cache: DriveMetadataCache;
	client: DriveClient;
	metadataStore?: MetadataStore<DriveFile>;
	logger?: Logger;
}

/**
 * Fetch all changes across pages, handling 410/401 errors.
 * Returns the accumulated changes and the new start page token,
 * or signals that a full scan is needed.
 *
 * @param onPage Optional callback invoked per page before accumulation.
 *               Return `true` to abort and trigger a full scan.
 */
async function fetchAllChanges(
	client: DriveClient,
	changesPageToken: string,
	logger?: Logger,
	onPage?: (changes: DriveChange[]) => boolean,
): Promise<{ changes: DriveChange[]; newToken: string } | { needsFullScan: true }> {
	try {
		let pageToken: string | undefined;
		let currentToken = changesPageToken;
		const allChanges: DriveChange[] = [];

		do {
			const result = await client.listChanges(changesPageToken, pageToken);

			if (onPage?.(result.changes)) {
				return { needsFullScan: true };
			}

			allChanges.push(...result.changes);
			pageToken = result.nextPageToken;
			if (result.newStartPageToken) {
				currentToken = result.newStartPageToken;
			}
		} while (pageToken);

		return { changes: allChanges, newToken: currentToken };
	} catch (err) {
		if (isHttpError(err, 410)) {
			logger?.info("Changes token expired (410), falling back to full scan");
			return { needsFullScan: true };
		}
		if (isHttpError(err, 401)) {
			logger?.warn("listChanges returned 401 — page token may be invalid, falling back to full scan");
			return { needsFullScan: true };
		}
		throw err;
	}
}

/**
 * Sort changes so folders come first (shallow before deep for full cache mode).
 * When a getPath function is provided, folders are additionally sorted by path depth.
 */
function sortChanges(
	changes: DriveChange[],
	getPath?: (fileId: string) => string | undefined,
): DriveChange[] {
	return [...changes].sort((a, b) => {
		const aIsFolder = a.file?.mimeType === FOLDER_MIME ? 0 : 1;
		const bIsFolder = b.file?.mimeType === FOLDER_MIME ? 0 : 1;
		if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
		// Among folders, sort by cached path depth (shallow first)
		if (aIsFolder === 0 && getPath) {
			const aPath = getPath(a.fileId) ?? "";
			const bPath = getPath(b.fileId) ?? "";
			return aPath.split("/").length - bPath.split("/").length;
		}
		return 0;
	});
}

/**
 * Apply incremental changes from the Drive changes.list API.
 * Updates the metadata cache and returns the new page token and changed paths.
 * Falls back to full re-scan (by setting initialized=false) on 410.
 *
 * @returns The new changes page token + changed file paths, or needsFullScan=true.
 */
export async function applyIncrementalChanges(
	ctx: IncrementalSyncContext,
	changesPageToken: string,
): Promise<{ newToken: string; needsFullScan: false; changedPaths: Set<string> } | { needsFullScan: true }> {
	const fetchResult = await fetchAllChanges(ctx.client, changesPageToken, ctx.logger);
	if ("needsFullScan" in fetchResult) return fetchResult;

	const sorted = sortChanges(fetchResult.changes, (id) => ctx.cache.getPathById(id));

	const updatedRecords: { path: string; file: DriveFile; isFolder: boolean }[] = [];
	const deletedPaths: string[] = [];

	for (const change of sorted) {
		if (change.removed || change.file?.trashed) {
			const path = ctx.cache.getPathById(change.fileId);
			if (path) {
				// Collect descendants before removing
				deletedPaths.push(path, ...ctx.cache.collectDescendants(path));
				ctx.cache.removePath(path);
			}
		} else if (change.file) {
			ctx.cache.applyFileChange(change.file);
			const updatedPath = ctx.cache.getPathById(change.file.id);
			if (updatedPath) {
				updatedRecords.push({
					path: updatedPath,
					file: change.file,
					isFolder: change.file.mimeType === FOLDER_MIME,
				});
			}
		}
	}

	if (sorted.length > 0) {
		ctx.logger?.info("Incremental changes applied", { changeCount: sorted.length });
		void persistIncrementalChanges(ctx, updatedRecords, deletedPaths, fetchResult.newToken);
	}

	// Collect changed file paths (not folders)
	const changedPaths = new Set<string>();
	for (const r of updatedRecords) {
		if (!r.isFolder) changedPaths.add(r.path);
	}
	for (const p of deletedPaths) {
		changedPaths.add(p);
	}

	return { newToken: fetchResult.newToken, needsFullScan: false, changedPaths };
}

/** Result of a lightweight incremental sync (no full cache) */
export interface LightweightIncrementalResult {
	needsFullScan: false;
	newToken: string;
	/** Changed file paths (not folders) — includes both modified and deleted paths */
	changedPaths: Set<string>;
	/** FileEntity for each changed/added file (not deleted files) */
	changedFiles: Map<string, FileEntity>;
	/** Raw DriveFile objects for cache pre-population during delta sync execution */
	changedDriveFiles: Map<string, DriveFile>;
	/** Paths of remotely deleted files (resolved via MetadataStore) */
	deletedPaths: string[];
	/** True if the folder hierarchy was modified */
	hierarchyChanged: boolean;
}

/**
 * Apply incremental changes using only the folder hierarchy (no full metadata cache).
 * Used by getRemoteChangedPaths() to detect remote changes without loading the full cache.
 *
 * When deletions are detected and a MetadataStore is available, resolves deleted file
 * paths via the fileId index instead of falling back to a full scan.
 * Falls back to needsFullScan=true only when MetadataStore is unavailable.
 */
export async function applyIncrementalChangesLightweight(
	client: DriveClient,
	hierarchy: FolderHierarchy,
	changesPageToken: string,
	logger?: Logger,
	metadataStore?: MetadataStore<DriveFile>,
): Promise<LightweightIncrementalResult | { needsFullScan: true }> {
	const deletedFileIds: string[] = [];

	const fetchResult = await fetchAllChanges(
		client,
		changesPageToken,
		logger,
		// Collect deleted fileIds; abort only if we can't resolve them
		!metadataStore
			? (changes) => {
					for (const change of changes) {
						if (change.removed || change.file?.trashed) {
							logger?.info("Lightweight incremental: remote deletion detected, no metadata store — falling back to full scan");
							return true;
						}
					}
					return false;
				}
			: (changes) => {
					for (const change of changes) {
						if (change.removed || change.file?.trashed) {
							deletedFileIds.push(change.fileId);
						}
					}
					return false;
				},
	);
	if ("needsFullScan" in fetchResult) return fetchResult;

	const sorted = sortChanges(fetchResult.changes);

	let hierarchyChanged = false;
	const changedPaths = new Set<string>();
	const changedFiles = new Map<string, FileEntity>();
	const changedDriveFiles = new Map<string, DriveFile>();

	for (const change of sorted) {
		if (!change.file) continue;
		const file = change.file;

		// Skip deleted/trashed files — handled separately below
		if (change.removed || file.trashed) continue;

		if (file.mimeType === FOLDER_MIME) {
			// Update folder hierarchy
			const parentId = file.parents?.find(
				(p) => p === hierarchy.rootFolderId || hierarchy.folders.has(p)
			);
			if (parentId) {
				hierarchy.folders.set(file.id, { name: file.name, parentId });
				hierarchyChanged = true;
			}
		} else {
			// Resolve file path via folder hierarchy
			const parentId = file.parents?.find(
				(p) => p === hierarchy.rootFolderId || hierarchy.folders.has(p)
			);
			if (!parentId) continue; // Can't resolve — skip (conservative: might miss some changes → next full scan)

			const path = resolvePathFromHierarchy(hierarchy, parentId, file.name);
			if (!path) continue;

			changedPaths.add(path);
			changedDriveFiles.set(path, file);
			// Build FileEntity from Drive metadata
			const mtime = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;
			changedFiles.set(path, {
				path,
				isDirectory: false,
				size: parseInt(file.size ?? "0", 10),
				mtime: Number.isNaN(mtime) ? 0 : mtime,
				hash: "",
				backendMeta: {
					driveId: file.id,
					contentChecksum: file.md5Checksum,
				},
			});
		}
	}

	// Resolve paths for deleted files via MetadataStore
	const deletedPaths: string[] = [];
	if (deletedFileIds.length > 0 && metadataStore) {
		try {
			await metadataStore.open();
			const records = await metadataStore.getByFileIds(deletedFileIds);
			for (const record of records) {
				deletedPaths.push(record.path);
				changedPaths.add(record.path);
			}
			if (records.length < deletedFileIds.length) {
				logger?.info("Lightweight incremental: some deleted fileIds not found in metadata store", {
					requested: deletedFileIds.length,
					resolved: records.length,
				});
			}
		} catch (err) {
			logger?.warn("Lightweight incremental: failed to resolve deleted file paths, falling back to full scan", {
				message: err instanceof Error ? err.message : String(err),
			});
			return { needsFullScan: true };
		}
	}

	return { needsFullScan: false, newToken: fetchResult.newToken, changedPaths, changedFiles, changedDriveFiles, deletedPaths, hierarchyChanged };
}

/** Persist incremental changes to IndexedDB */
async function persistIncrementalChanges(
	ctx: IncrementalSyncContext,
	updated: { path: string; file: DriveFile; isFolder: boolean }[],
	deleted: string[],
	changesPageToken: string,
): Promise<void> {
	if (!ctx.metadataStore) return;
	try {
		if (updated.length > 0) await ctx.metadataStore.putFiles(updated);
		if (deleted.length > 0) await ctx.metadataStore.deleteFiles(deleted);
		await ctx.metadataStore.putMeta("changesStartPageToken", changesPageToken);
	} catch (err) {
		ctx.logger?.warn("Failed to persist incremental changes to IndexedDB", {
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Check if an error is an HTTP error with the given status code */
export function isHttpError(err: unknown, status: number): boolean {
	if (err && typeof err === "object" && "status" in err) {
		return (err as { status: number }).status === status;
	}
	return false;
}
