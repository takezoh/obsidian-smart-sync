import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { SyncAction, SyncPlan } from "./types";
import type { StateCommitterContext } from "./state-committer";
import type { ConflictResolverContext, SimplifiedConflictStrategy, ConflictResolutionResult } from "./conflict-resolver";
import type { Logger } from "../logging/logger";
import { commitAction } from "./state-committer";
import { resolveConflictV2 } from "./conflict-resolver";
import { AuthError } from "../fs/errors";
import { AsyncPool } from "../queue/async-queue";

export interface CompletedAction {
	action: SyncAction;
	localEntity?: FileEntity;
	remoteEntity?: FileEntity;
}

export interface FailedAction {
	action: SyncAction;
	error: Error;
}

export interface ResolvedConflict {
	action: SyncAction;
	resolution: ConflictResolutionResult;
	localEntity?: FileEntity;
	remoteEntity?: FileEntity;
}

export interface ExecutionResult {
	succeeded: CompletedAction[];
	failed: FailedAction[];
	conflicts: ResolvedConflict[];
}

export interface ExecutionContext {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	committer: StateCommitterContext;
	conflictStrategy: SimplifiedConflictStrategy;
	onConfirmation?: () => Promise<boolean>;
	onProgress?: (completed: number, total: number) => void;
	logger?: Logger;
}

const POOL_CONCURRENCY = 5;

export async function executePlan(
	plan: SyncPlan,
	ctx: ExecutionContext,
): Promise<ExecutionResult> {
	const result: ExecutionResult = {
		succeeded: [],
		failed: [],
		conflicts: [],
	};

	if (plan.safetyCheck.shouldAbort) {
		ctx.logger?.warn("executePlan: aborting — safety check triggered", {
			deletionRatio: plan.safetyCheck.deletionRatio,
			deletionCount: plan.safetyCheck.deletionCount,
		});
		return result;
	}

	if (plan.safetyCheck.requiresConfirmation && !ctx.onConfirmation) {
		ctx.logger?.warn("executePlan: requiresConfirmation is true but no onConfirmation callback provided — proceeding without confirmation");
	}

	if (plan.safetyCheck.requiresConfirmation && ctx.onConfirmation) {
		const confirmed = await ctx.onConfirmation();
		if (!confirmed) {
			ctx.logger?.info("executePlan: aborted by user confirmation");
			return result;
		}
	}

	const groupA: SyncAction[] = [];
	const groupB: SyncAction[] = [];
	const groupC: SyncAction[] = [];
	const groupD: SyncAction[] = [];

	for (const action of plan.actions) {
		switch (action.action) {
			case "push":
			case "pull":
			case "match":
			case "cleanup": // cleanup is state-only (no I/O), safe to run in parallel with Group A
				groupA.push(action);
				break;
			case "delete_remote":
				groupB.push(action);
				break;
			case "delete_local":
				groupC.push(action);
				break;
			case "conflict":
				groupD.push(action);
				break;
		}
	}

	const total = plan.actions.length;
	let completed = 0;
	const reportProgress = () => {
		completed++;
		ctx.onProgress?.(completed, total);
	};

	// Group A: parallel with AsyncPool(5)
	const pool = new AsyncPool(POOL_CONCURRENCY);
	await Promise.all(
		groupA.map((action) =>
			pool.run(() => executeAction(action, ctx, result, reportProgress))
		)
	);

	// Group B: delete_remote — serial
	for (const action of groupB) {
		await executeAction(action, ctx, result, reportProgress);
	}

	// Group C: delete_local — serial
	for (const action of groupC) {
		await executeAction(action, ctx, result, reportProgress);
	}

	// Group D: conflict — serial (may show UI modal)
	for (const action of groupD) {
		await executeConflictAction(action, ctx, result, reportProgress);
	}

	return result;
}

async function executeAction(
	action: SyncAction,
	ctx: ExecutionContext,
	result: ExecutionResult,
	reportProgress: () => void,
): Promise<void> {
	try {
		const { localEntity, remoteEntity } = await runActionIO(action, ctx);
		await commitAction(action, localEntity, remoteEntity, ctx.committer);
		result.succeeded.push({ action, localEntity, remoteEntity });
	} catch (err) {
		if (err instanceof AuthError) throw err;
		const error = err instanceof Error ? err : new Error(String(err));
		ctx.logger?.error("executePlan: action failed", {
			path: action.path,
			action: action.action,
			error: error.message,
		});
		result.failed.push({ action, error });
	} finally {
		reportProgress();
	}
}

async function runActionIO(
	action: SyncAction,
	ctx: ExecutionContext,
): Promise<{ localEntity?: FileEntity; remoteEntity?: FileEntity }> {
	const { localFs, remoteFs } = ctx;
	const { path } = action;

	switch (action.action) {
		case "push": {
			if (!action.local) throw new Error(`push action requires local entity: ${path}`);
			const content = await localFs.read(path);
			const remoteEntity = await remoteFs.write(path, content, action.local.mtime);
			// stat() may return null if the file was deleted between read and stat (race condition);
			// fall back to action.local which is the pre-sync metadata
			const localEntity = await localFs.stat(path) ?? action.local;
			return { localEntity, remoteEntity };
		}

		case "pull": {
			if (!action.remote) throw new Error(`pull action requires remote entity: ${path}`);
			const content = await remoteFs.read(path);
			const localEntity = await localFs.write(path, content, action.remote.mtime);
			// stat() may return null if the file was deleted between write and stat (race condition);
			// fall back to action.remote which is the pre-sync metadata
			const remoteEntity = await remoteFs.stat(path) ?? action.remote;
			return { localEntity, remoteEntity };
		}

		case "match": {
			return { localEntity: action.local, remoteEntity: action.remote };
		}

		case "delete_remote": {
			await remoteFs.delete(path);
			return {};
		}

		case "delete_local": {
			await localFs.delete(path);
			return {};
		}

		case "cleanup": {
			return {};
		}

		// "conflict" is routed through executeConflictAction, not this function
		case "conflict": {
			return {};
		}
	}
}

async function executeConflictAction(
	action: SyncAction,
	ctx: ExecutionContext,
	result: ExecutionResult,
	reportProgress: () => void,
): Promise<void> {
	try {
		const conflictCtx: ConflictResolverContext = {
			path: action.path,
			localFs: ctx.localFs,
			remoteFs: ctx.remoteFs,
			local: action.local,
			remote: action.remote,
			baseline: action.baseline,
			stateStore: ctx.committer.stateStore,
			logger: ctx.logger,
		};

		const resolution = await resolveConflictV2(conflictCtx, ctx.conflictStrategy);

		const localEntity = await ctx.localFs.stat(action.path) ?? action.local;
		const remoteEntity = await ctx.remoteFs.stat(action.path) ?? action.remote;

		await commitAction(action, localEntity, remoteEntity, ctx.committer);

		result.conflicts.push({ action, resolution, localEntity, remoteEntity });
		result.succeeded.push({ action, localEntity, remoteEntity });
	} catch (err) {
		if (err instanceof AuthError) throw err;
		const error = err instanceof Error ? err : new Error(String(err));
		ctx.logger?.error("executePlan: conflict action failed", {
			path: action.path,
			error: error.message,
		});
		result.failed.push({ action, error });
	} finally {
		reportProgress();
	}
}
