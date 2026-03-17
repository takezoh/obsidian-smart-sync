import type { DriveFile } from "./types";
import { FOLDER_MIME } from "./types";
import type { DriveMetadataCache } from "./metadata-cache";
import type { DriveClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";

/** Context for incremental sync operations */
export interface IncrementalSyncContext {
	cache: DriveMetadataCache;
	client: DriveClient;
	metadataStore?: MetadataStore<DriveFile>;
	logger?: Logger;
}

export type IncrementalChangesResult =
	| { needsFullScan: false; newToken: string; changedPaths: Set<string> }
	| { needsFullScan: true; changedPaths: Set<string> };

/**
 * Apply incremental changes from the Drive changes.list API.
 * Updates the metadata cache and returns the new page token.
 * Falls back to full re-scan (by setting initialized=false) on 410.
 *
 * @returns The new changes page token, or null if a full scan is needed.
 */
export async function applyIncrementalChanges(
	ctx: IncrementalSyncContext,
	changesPageToken: string,
): Promise<IncrementalChangesResult> {
	try {
		let pageToken: string | undefined;
		let currentToken = changesPageToken;

		let totalChanges = 0;
		const updatedRecords: { path: string; file: DriveFile; isFolder: boolean }[] = [];
		const deletedPaths: string[] = [];
		const changedPaths = new Set<string>();

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
						const descendants = ctx.cache.collectDescendants(path);
						deletedPaths.push(path, ...descendants);
						changedPaths.add(path);
						for (const d of descendants) changedPaths.add(d);
						ctx.cache.removeTree(path);
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
						changedPaths.add(updatedPath);
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

		return { newToken: currentToken, needsFullScan: false, changedPaths };
	} catch (err) {
		if (isHttpError(err, 410)) {
			// Token expired, fall back to full scan
			ctx.logger?.info("Changes token expired (410), falling back to full scan");
			return { needsFullScan: true, changedPaths: new Set<string>() };
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
