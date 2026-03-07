import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { ConflictRecord, ConflictStrategy, SyncDecision, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import type { OnConflict, SyncResult } from "./executor";
import { resolveConflict, buildSyncRecord } from "./conflict";
import { isMergeEligible } from "./merge";

export interface ExecutorContext {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	stateStore: SyncStateStore;
	defaultStrategy: ConflictStrategy;
	enableThreeWayMerge: boolean;
	onConflict?: OnConflict;
	logger?: Logger;
}

export async function executePush(
	ctx: ExecutorContext,
	decision: SyncDecision,
	result: SyncResult,
): Promise<void> {
	const { path } = decision;
	const content = await ctx.localFs.read(path);
	const remoteResult = await ctx.remoteFs.write(path, content, decision.local!.mtime);
	// Re-stat local to get fresh mtime (file may have changed since decision)
	const freshLocal = await ctx.localFs.stat(path);
	await updateSyncRecord(ctx, path, freshLocal ?? decision.local!, remoteResult);
	result.pushed++;
}

export async function executePull(
	ctx: ExecutorContext,
	decision: SyncDecision,
	result: SyncResult,
): Promise<void> {
	const { path } = decision;
	const content = await ctx.remoteFs.read(path);
	const localResult = await ctx.localFs.write(path, content, decision.remote!.mtime);
	// Re-stat remote to get fresh metadata (symmetric with push flow)
	const freshRemote = await ctx.remoteFs.stat(path);
	await updateSyncRecord(ctx, path, localResult, freshRemote ?? decision.remote!);
	result.pulled++;
}

export async function executeDeletePropagation(
	ctx: ExecutorContext,
	decision: SyncDecision,
	result: SyncResult,
	reDispatch: (d: SyncDecision) => Promise<void>,
): Promise<void> {
	const { path } = decision;

	if (decision.decision === "remote_deleted_propagate") {
		// TOCTOU guard: check if remote was re-created since decision
		const remoteCheck = await ctx.remoteFs.stat(path);
		if (remoteCheck) {
			const localCheck = await ctx.localFs.stat(path);
			await reDispatch({
				...decision,
				decision: "conflict_delete_vs_modify",
				local: localCheck ?? decision.local,
				remote: remoteCheck,
			});
			return;
		}
		await ctx.localFs.delete(path);
		await ctx.stateStore.delete(path);
		result.pulled++;
	} else {
		// local_deleted_propagate
		// TOCTOU guard: check if local was re-created since decision
		const localCheck = await ctx.localFs.stat(path);
		if (localCheck) {
			const remoteCheck = await ctx.remoteFs.stat(path);
			await reDispatch({
				...decision,
				decision: "conflict_delete_vs_modify",
				local: localCheck,
				remote: remoteCheck ?? decision.remote,
			});
			return;
		}
		await ctx.remoteFs.delete(path);
		await ctx.stateStore.delete(path);
		await removeEmptyParents(ctx.remoteFs, path);
		result.pushed++;
	}
}

export async function executeConflict(
	ctx: ExecutorContext,
	decision: SyncDecision,
	result: SyncResult,
): Promise<void> {
	const { path } = decision;
	let strategy = ctx.defaultStrategy;

	if (
		ctx.enableThreeWayMerge &&
		decision.prevSync &&
		(strategy === "keep_newer" || strategy === "ask")
	) {
		strategy = "three_way_merge";
	} else if (strategy === "ask" && ctx.onConflict) {
		strategy = await ctx.onConflict(decision);
	}

	// Lazy fallback: only prompts the user if 3-way merge actually fails
	const getFallback = async (): Promise<ConflictStrategy> => {
		if (ctx.defaultStrategy === "ask" && ctx.onConflict) {
			return ctx.onConflict(decision);
		}
		return ctx.defaultStrategy;
	};

	const conflictCtx = {
		path,
		localFs: ctx.localFs,
		remoteFs: ctx.remoteFs,
		local: decision.local,
		remote: decision.remote,
		prevSync: decision.prevSync,
		stateStore: ctx.stateStore,
		logger: ctx.logger,
	};

	const resolution = await resolveConflict(conflictCtx, strategy, getFallback);

	// Record conflict metadata for history
	const conflictRecord: ConflictRecord = {
		path,
		decisionType: decision.decision,
		strategy,
		action: resolution.action,
		local: decision.local,
		remote: decision.remote,
		duplicatePath: resolution.duplicatePath,
		hasConflictMarkers: resolution.hasConflictMarkers,
		resolvedAt: new Date().toISOString(),
		sessionId: "",
	};
	result.conflictRecords.push(conflictRecord);

	// Track paths with unresolved merge conflicts
	if (resolution.hasConflictMarkers) {
		result.mergeConflictPaths.push(path);
	}

	// Update sync record based on resolution
	const buildCtx = {
		path,
		localFs: ctx.localFs,
		remoteFs: ctx.remoteFs,
		stateStore: ctx.stateStore,
		logger: ctx.logger,
	};
	const record = await buildSyncRecord(buildCtx, ctx.enableThreeWayMerge);
	if (record) {
		await ctx.stateStore.put(record);
	}

	// If duplicated, also save a record for the duplicate
	if (resolution.duplicatePath) {
		const dupRecord = await buildSyncRecord(
			{ ...buildCtx, path: resolution.duplicatePath },
			ctx.enableThreeWayMerge,
		);
		if (dupRecord) {
			await ctx.stateStore.put(dupRecord);
		}
	}

	result.conflicts++;
}

export async function updateSyncRecord(
	ctx: ExecutorContext,
	path: string,
	localEntity: FileEntity,
	remoteEntity: FileEntity,
): Promise<void> {
	const record: SyncRecord = {
		path,
		hash: localEntity.hash || remoteEntity.hash,
		localMtime: localEntity.mtime,
		remoteMtime: remoteEntity.mtime,
		localSize: localEntity.size,
		remoteSize: remoteEntity.size,
		backendMeta: remoteEntity.backendMeta,
		syncedAt: Date.now(),
	};

	await ctx.stateStore.put(record);

	if (ctx.enableThreeWayMerge && isMergeEligible(path, record.localSize)) {
		// Store content separately for future 3-way merges (text files only)
		try {
			const content = await ctx.localFs.read(path);
			await ctx.stateStore.putContent(path, content);
		} catch (err) {
			console.warn(`Smart Sync: failed to store content for 3-way merge (${path}):`, err);
			ctx.logger?.warn("Failed to store content for 3-way merge", { path, error: err instanceof Error ? err.message : String(err) });
		}
	}
}

export async function removeEmptyParents(fs: IFileSystem, filePath: string): Promise<void> {
	let dir = filePath.substring(0, filePath.lastIndexOf("/"));
	while (dir) {
		const children = await fs.listDir(dir);
		if (children.length > 0) break;
		await fs.delete(dir);
		dir = dir.substring(0, dir.lastIndexOf("/"));
	}
}
