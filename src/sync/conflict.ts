import type { IFileSystem } from "../fs/interface";
import type { FileEntity, ConflictStrategy, SyncRecord } from "../fs/types";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import { getFileExtension } from "../utils/path";
import { isMergeEligible, threeWayMerge } from "./merge";

export interface ConflictResolutionResult {
	/** The action that was taken */
	action: "kept_local" | "kept_remote" | "duplicated" | "merged";
	/** If a duplicate was created, its path */
	duplicatePath?: string;
	/** True if the merged result contains unresolved conflict markers */
	hasConflictMarkers?: boolean;
}

/**
 * Resolve a conflict between local and remote versions of a file.
 * Supports: keep_newer, keep_local, keep_remote, duplicate, three_way_merge, ask.
 */
export type FallbackResolver = ConflictStrategy | (() => Promise<ConflictStrategy>);

export async function resolveConflict(
	path: string,
	strategy: ConflictStrategy,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	local?: FileEntity,
	remote?: FileEntity,
	prevSync?: SyncRecord,
	stateStore?: SyncStateStore,
	fallback?: FallbackResolver,
	logger?: Logger
): Promise<ConflictResolutionResult> {
	switch (strategy) {
		case "keep_local":
			return keepLocal(path, localFs, remoteFs, local);

		case "keep_remote":
			return keepRemote(path, localFs, remoteFs, remote);

		case "keep_newer":
			return keepNewer(path, localFs, remoteFs, local, remote);

		case "duplicate":
			return duplicate(path, localFs, remoteFs, local, remote);

		case "three_way_merge":
			return attemptThreeWayMerge(
				path, localFs, remoteFs, local, remote, prevSync,
				stateStore, fallback ?? "keep_newer", logger
			);

		case "ask":
			// Handled by executor via onConflict callback before reaching here.
			// If we get here, it means the callback was not provided — fall back safely.
			console.warn(
				`Smart Sync: "ask" strategy reached resolveConflict without callback for "${path}", falling back to keep_newer`
			);
			logger?.warn("Ask strategy reached resolveConflict without callback, falling back to keep_newer", { path });
			return keepNewer(path, localFs, remoteFs, local, remote);
	}
}

async function keepLocal(
	path: string,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	local?: FileEntity
): Promise<ConflictResolutionResult> {
	if (local) {
		const content = await localFs.read(path);
		await remoteFs.write(path, content, local.mtime);
	} else {
		await remoteFs.delete(path);
	}
	return { action: "kept_local" };
}

async function keepRemote(
	path: string,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	remote?: FileEntity
): Promise<ConflictResolutionResult> {
	if (remote) {
		const content = await remoteFs.read(path);
		await localFs.write(path, content, remote.mtime);
	} else {
		await localFs.delete(path);
	}
	return { action: "kept_remote" };
}

async function keepNewer(
	path: string,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	local?: FileEntity,
	remote?: FileEntity
): Promise<ConflictResolutionResult> {
	// If one side is deleted, the other side wins
	if (!local && remote) {
		return keepRemote(path, localFs, remoteFs, remote);
	}
	if (local && !remote) {
		return keepLocal(path, localFs, remoteFs, local);
	}
	if (!local && !remote) {
		return { action: "kept_local" };
	}

	// Both exist — compare mtime only when both are known (> 0)
	if (local!.mtime > 0 && remote!.mtime > 0) {
		if (local!.mtime > remote!.mtime) {
			return keepLocal(path, localFs, remoteFs, local);
		}
		if (local!.mtime < remote!.mtime) {
			return keepRemote(path, localFs, remoteFs, remote);
		}
	}
	// Same mtime or unknown mtime: compare by hash — if identical content, keep local; otherwise duplicate
	if (local!.hash && remote!.hash && local!.hash === remote!.hash) {
		return keepLocal(path, localFs, remoteFs, local); // content identical
	}
	return duplicate(path, localFs, remoteFs, local, remote); // safe fallback
}

async function duplicate(
	path: string,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	local?: FileEntity,
	remote?: FileEntity
): Promise<ConflictResolutionResult> {
	// Delete-vs-modify: local deleted, remote has content → restore remote version locally
	if (!local && remote) {
		const remoteContent = await remoteFs.read(path);
		await localFs.write(path, remoteContent, remote.mtime);
		return { action: "duplicated" };
	}

	// Delete-vs-modify: remote deleted, local has content → restore local version remotely
	if (local && !remote) {
		const localContent = await localFs.read(path);
		await remoteFs.write(path, localContent, local.mtime);
		return { action: "duplicated" };
	}

	// Both deleted — nothing to do
	if (!local && !remote) {
		return { action: "kept_local" };
	}

	// Both exist: save remote as .conflict duplicate on both sides, keep local at original path
	const remoteContent = await remoteFs.read(path);
	const duplicatePath = await generateConflictPath(path, localFs, remoteFs);
	await localFs.write(duplicatePath, remoteContent, remote!.mtime);
	await remoteFs.write(duplicatePath, remoteContent, remote!.mtime);

	const localContent = await localFs.read(path);
	await remoteFs.write(path, localContent, local!.mtime);

	return { action: "duplicated", duplicatePath };
}

/** Generate a conflict file path with sequential numbering to avoid overwrites.
 *  e.g. "notes/file.conflict.md" → "notes/file.conflict-2.md" if the first exists.
 *  Checks all provided filesystems to prevent overwriting on any side.
 */
export async function generateConflictPath(
	path: string,
	...filesystems: IFileSystem[]
): Promise<string> {
	const existsOnAny = async (candidate: string): Promise<boolean> => {
		for (const fs of filesystems) {
			if (await fs.stat(candidate)) return true;
		}
		return false;
	};

	const candidate = insertConflictSuffix(path, 1);
	if (!(await existsOnAny(candidate))) return candidate;

	for (let i = 2; i <= 100; i++) {
		const numbered = insertConflictSuffix(path, i);
		if (!(await existsOnAny(numbered))) return numbered;
	}
	// Extremely unlikely; fall through with timestamp (still check for collision)
	const tsPath = insertConflictSuffix(path, Date.now());
	if (!(await existsOnAny(tsPath))) return tsPath;
	return insertConflictSuffix(path, `${Date.now()}-${Math.floor(Math.random() * 1000)}`);
}

function insertConflictSuffix(path: string, seq: number | string): string {
	const suffix = seq === 1 ? ".conflict" : `.conflict-${seq}`;
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1 || lastDot <= path.lastIndexOf("/")) {
		return `${path}${suffix}`;
	}
	return `${path.substring(0, lastDot)}${suffix}${path.substring(lastDot)}`;
}

async function attemptThreeWayMerge(
	path: string,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	local?: FileEntity,
	remote?: FileEntity,
	prevSync?: SyncRecord,
	stateStore?: SyncStateStore,
	fallback: FallbackResolver = "keep_newer",
	logger?: Logger
): Promise<ConflictResolutionResult> {
	const resolveFallback = async (): Promise<ConflictStrategy> => {
		return typeof fallback === "function" ? await fallback() : fallback;
	};

	// Must have both sides present and a previous sync record
	if (!local || !remote || !prevSync) {
		const fb = await resolveFallback();
		return resolveConflict(path, fb, localFs, remoteFs, local, remote);
	}

	// Retrieve the stored base content
	const prevSyncContent = stateStore ? await stateStore.getContent(path) : undefined;
	if (!prevSyncContent) {
		const fb = await resolveFallback();
		return resolveConflict(path, fb, localFs, remoteFs, local, remote);
	}

	if (!isMergeEligible(path, Math.max(local.size, remote.size))) {
		const fb = await resolveFallback();
		return resolveConflict(path, fb, localFs, remoteFs, local, remote);
	}

	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	const baseText = decoder.decode(prevSyncContent);
	const localContent = await localFs.read(path);
	const localText = decoder.decode(localContent);
	const remoteContent = await remoteFs.read(path);
	const remoteText = decoder.decode(remoteContent);

	let mergeResult;
	try {
		mergeResult = threeWayMerge(baseText, localText, remoteText);
	} catch (mergeErr) {
		console.warn(`Smart Sync: 3-way merge failed for "${path}", falling back:`, mergeErr);
		logger?.warn("3-way merge failed, falling back", { path, error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr) });
		const fb = await resolveFallback();
		return resolveConflict(path, fb, localFs, remoteFs, local, remote);
	}

	// For JSON/Canvas files, validate the merge result
	const ext = getFileExtension(path);
	if (ext === ".json" || ext === ".canvas") {
		if (mergeResult.hasConflicts || !isValidJson(mergeResult.content)) {
			return duplicate(path, localFs, remoteFs, local, remote);
		}
	}

	const mergedBuffer = encoder.encode(mergeResult.content).buffer as ArrayBuffer;

	// Write merged content to both sides (with rollback if remote fails)
	const now = Date.now();
	await localFs.write(path, mergedBuffer, now);
	try {
		await remoteFs.write(path, mergedBuffer, now);
	} catch (remoteWriteErr) {
		// Restore local to pre-merge state
		try {
			await localFs.write(path, encoder.encode(localText).buffer as ArrayBuffer, local.mtime);
		} catch (restoreErr) {
			console.error(`Smart Sync: failed to restore local after merge failure (${path}):`, restoreErr);
			logger?.error("Failed to restore local after merge failure", { path, error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) });
		}
		throw remoteWriteErr;
	}

	return {
		action: "merged",
		hasConflictMarkers: mergeResult.hasConflicts,
	};
}

/** Build sync record from current file state on both sides */
export async function buildSyncRecord(
	path: string,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	storeContent?: boolean,
	stateStore?: SyncStateStore,
	logger?: Logger
): Promise<SyncRecord | null> {
	const localStat = await localFs.stat(path);
	const remoteStat = await remoteFs.stat(path);

	if (!localStat && !remoteStat) return null;
	if (localStat?.isDirectory || remoteStat?.isDirectory) return null;

	const record: SyncRecord = {
		path,
		hash: localStat?.hash || remoteStat?.hash || "",
		localMtime: localStat?.mtime ?? 0,
		remoteMtime: remoteStat?.mtime ?? 0,
		size: localStat?.size ?? remoteStat?.size ?? 0,
		backendMeta: remoteStat?.backendMeta,
		syncedAt: Date.now(),
	};

	if (storeContent && localStat && stateStore && isMergeEligible(path, record.size)) {
		try {
			const content = await localFs.read(path);
			await stateStore.putContent(path, content);
		} catch (err) {
			console.warn(`Smart Sync: failed to store content for 3-way merge (${path}):`, err);
			logger?.warn("Failed to store content for 3-way merge", { path, error: err instanceof Error ? err.message : String(err) });
		}
	}

	return record;
}

function isValidJson(content: string): boolean {
	try {
		JSON.parse(content);
		return true;
	} catch {
		return false;
	}
}
