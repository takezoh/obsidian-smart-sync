import type { DriveFile } from "./types";
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
	try {
		let pageToken: string | undefined;
		let currentToken = changesPageToken;

		let totalChanges = 0;
		const updatedRecords: { path: string; file: DriveFile; isFolder: boolean }[] = [];
		const deletedPaths: string[] = [];

		do {
			const result = await ctx.client.listChanges(
				changesPageToken,
				pageToken
			);

			// Process folder changes first (shallow before deep) so paths resolve correctly
			const sorted = [...result.changes].sort((a, b) => {
				const aIsFolder =
					a.file?.mimeType === FOLDER_MIME ? 0 : 1;
				const bIsFolder =
					b.file?.mimeType === FOLDER_MIME ? 0 : 1;
				if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
				// Among folders, sort by cached path depth (shallow first)
				if (aIsFolder === 0) {
					const aPath = ctx.cache.getPathById(a.fileId) ?? "";
					const bPath = ctx.cache.getPathById(b.fileId) ?? "";
					return aPath.split("/").length - bPath.split("/").length;
				}
				return 0;
			});

			totalChanges += sorted.length;
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

			pageToken = result.nextPageToken;
			if (result.newStartPageToken) {
				currentToken = result.newStartPageToken;
			}
		} while (pageToken);

		if (totalChanges > 0) {
			ctx.logger?.info("Incremental changes applied", { changeCount: totalChanges });
			void persistIncrementalChanges(ctx, updatedRecords, deletedPaths, currentToken);
		}

		// Collect changed file paths (not folders)
		const changedPaths = new Set<string>();
		for (const r of updatedRecords) {
			if (!r.isFolder) changedPaths.add(r.path);
		}
		for (const p of deletedPaths) {
			changedPaths.add(p);
		}

		return { newToken: currentToken, needsFullScan: false, changedPaths };
	} catch (err) {
		if (isHttpError(err, 410)) {
			// Token expired, fall back to full scan
			ctx.logger?.info("Changes token expired (410), falling back to full scan");
			return { needsFullScan: true };
		}
		if (isHttpError(err, 401)) {
			// Page token may be invalid, fall back to full scan
			ctx.logger?.warn("listChanges returned 401 — page token may be invalid, falling back to full scan");
			return { needsFullScan: true };
		}
		throw err;
	}
}

/** Result of a lightweight incremental sync (no full cache) */
export interface LightweightIncrementalResult {
	needsFullScan: false;
	newToken: string;
	/** Changed file paths (not folders) */
	changedPaths: Set<string>;
	/** FileEntity for each changed/added file (not deleted files) */
	changedFiles: Map<string, FileEntity>;
	/** Raw DriveFile objects for cache pre-population during delta sync execution */
	changedDriveFiles: Map<string, DriveFile>;
	/** True if the folder hierarchy was modified */
	hierarchyChanged: boolean;
}

/**
 * Apply incremental changes using only the folder hierarchy (no full metadata cache).
 * Used by getRemoteChangedPaths() to detect remote changes without loading the full cache.
 *
 * Limitations:
 * - If any file is remotely deleted/trashed, returns needsFullScan=true
 *   (can't resolve path without idToPath cache)
 * - Only handles file additions and modifications in the lightweight path
 */
export async function applyIncrementalChangesLightweight(
	client: DriveClient,
	hierarchy: FolderHierarchy,
	changesPageToken: string,
	logger?: Logger,
): Promise<LightweightIncrementalResult | { needsFullScan: true }> {
	try {
		let pageToken: string | undefined;
		let currentToken = changesPageToken;
		let hierarchyChanged = false;

		const changedPaths = new Set<string>();
		const changedFiles = new Map<string, FileEntity>();
		const changedDriveFiles = new Map<string, DriveFile>();

		do {
			const result = await client.listChanges(changesPageToken, pageToken);

			// If any change is a removal/trash, we can't resolve the path → full scan
			for (const change of result.changes) {
				if (change.removed || change.file?.trashed) {
					logger?.info("Lightweight incremental: remote deletion detected, falling back to full scan");
					return { needsFullScan: true };
				}
			}

			// Process folder changes first (shallow before deep)
			const sorted = [...result.changes].sort((a, b) => {
				const aIsFolder = a.file?.mimeType === FOLDER_MIME ? 0 : 1;
				const bIsFolder = b.file?.mimeType === FOLDER_MIME ? 0 : 1;
				return aIsFolder - bIsFolder;
			});

			for (const change of sorted) {
				if (!change.file) continue;
				const file = change.file;

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

			pageToken = result.nextPageToken;
			if (result.newStartPageToken) {
				currentToken = result.newStartPageToken;
			}
		} while (pageToken);

		return { needsFullScan: false, newToken: currentToken, changedPaths, changedFiles, changedDriveFiles, hierarchyChanged };
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
