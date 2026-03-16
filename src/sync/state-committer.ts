import type { FileEntity } from "../fs/types";
import type { SyncAction, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import { isMergeEligible } from "./merge";

export interface StateCommitterContext {
	stateStore: SyncStateStore;
	localFs?: { read(path: string): Promise<ArrayBuffer> };
	enableThreeWayMerge?: boolean;
	logger?: Logger;
}

/**
 * Build a SyncRecord from a local and remote FileEntity.
 * Moved from conflict.ts to centralise record construction in the v2 pipeline.
 */
export function buildSyncRecord(local: FileEntity | undefined, remote: FileEntity | undefined, path: string): SyncRecord {
	return {
		path,
		hash: local?.hash || remote?.hash || "",
		localMtime: local?.mtime ?? 0,
		remoteMtime: remote?.mtime ?? 0,
		localSize: local?.size ?? 0,
		remoteSize: remote?.size ?? 0,
		backendMeta: remote?.backendMeta,
		syncedAt: Date.now(),
	};
}

/**
 * Commit the state change for a single successfully-executed action.
 *
 * - push/pull/match/conflict → upsert SyncRecord (+ optionally store merge-base content)
 * - delete_local/delete_remote → delete SyncRecord
 * - cleanup → delete SyncRecord
 *
 * Note: this function is only called for successful actions.
 * Failed actions are skipped by the caller; they will be re-detected on the next sync cycle.
 */
export async function commitAction(
	action: SyncAction,
	localEntity: FileEntity | undefined,
	remoteEntity: FileEntity | undefined,
	ctx: StateCommitterContext,
): Promise<void> {
	const { path } = action;
	const { stateStore, localFs, enableThreeWayMerge, logger } = ctx;

	switch (action.action) {
		case "push":
		case "pull":
		case "match":
		case "conflict": {
			const record = buildSyncRecord(localEntity, remoteEntity, path);
			await stateStore.put(record);

			if (enableThreeWayMerge && localFs && localEntity && isMergeEligible(path, record.localSize)) {
				try {
					const content = await localFs.read(path);
					await stateStore.putContent(path, content);
				} catch (err) {
					logger?.warn("Failed to store content for 3-way merge", {
						path,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			break;
		}

		case "delete_local":
		case "delete_remote":
		case "cleanup":
			await stateStore.delete(path);
			break;

		default: {
			// Exhaustive check: if a new SyncActionType is added, TypeScript will error here
			const _exhaustive: never = action.action;
			void _exhaustive;
			break;
		}
	}
}
