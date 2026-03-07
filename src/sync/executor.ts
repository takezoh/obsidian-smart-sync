import type { ConflictRecord, ConflictStrategy, SyncDecision, SyncRecord } from "./types";
import type { IFileSystem } from "../fs/interface";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import { AsyncPool } from "../queue/async-queue";
import {
	executePush,
	executePull,
	executeDeletePropagation,
	executeConflict,
} from "./executor-ops";
import type { ExecutorContext } from "./executor-ops";

export interface SyncProgress {
	total: number;
	completed: number;
	currentPath: string;
}

export interface SyncResult {
	pushed: number;
	pulled: number;
	conflicts: number;
	/** Paths where 3-way merge left unresolved conflict markers */
	mergeConflictPaths: string[];
	conflictRecords: ConflictRecord[];
	errors: string[];
}

export type OnProgress = (progress: SyncProgress) => void;
export type OnConflict = (
	decision: SyncDecision
) => Promise<ConflictStrategy>;

/**
 * Execute sync decisions against the local and remote filesystems.
 */
export class SyncExecutor implements ExecutorContext {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	stateStore: SyncStateStore;
	defaultStrategy: ConflictStrategy;
	enableThreeWayMerge: boolean;
	private onProgress?: OnProgress;
	onConflict?: OnConflict;
	logger?: Logger;

	constructor(options: {
		localFs: IFileSystem;
		remoteFs: IFileSystem;
		stateStore: SyncStateStore;
		defaultStrategy: ConflictStrategy;
		enableThreeWayMerge: boolean;
		onProgress?: OnProgress;
		onConflict?: OnConflict;
		logger?: Logger;
	}) {
		if (options.defaultStrategy === "ask" && !options.onConflict) {
			throw new Error(
				'SyncExecutor: defaultStrategy "ask" requires an onConflict callback'
			);
		}
		this.localFs = options.localFs;
		this.remoteFs = options.remoteFs;
		this.stateStore = options.stateStore;
		this.defaultStrategy = options.defaultStrategy;
		this.enableThreeWayMerge = options.enableThreeWayMerge;
		this.onProgress = options.onProgress;
		this.onConflict = options.onConflict;
		this.logger = options.logger;
	}

	async execute(decisions: SyncDecision[]): Promise<SyncResult> {
		const actionable = decisions.filter(
			(d) => d.decision !== "no_action"
		);

		const breakdown: Record<string, number> = {};
		for (const d of actionable) {
			breakdown[d.decision] = (breakdown[d.decision] ?? 0) + 1;
		}
		this.logger?.info("Executing sync decisions", { total: actionable.length, breakdown });

		const result: SyncResult = {
			pushed: 0,
			pulled: 0,
			conflicts: 0,
			mergeConflictPaths: [],
			conflictRecords: [],
			errors: [],
		};

		// Partition decisions into three groups by execution constraints
		const parallelSafe: SyncDecision[] = [];
		const serialDeletes: SyncDecision[] = [];
		const conflicts: SyncDecision[] = [];

		for (const d of actionable) {
			if (d.decision.startsWith("conflict_")) {
				conflicts.push(d);
			} else if (d.decision === "local_deleted_propagate") {
				serialDeletes.push(d);
			} else {
				parallelSafe.push(d);
			}
		}

		let completed = 0;
		const total = actionable.length;

		const executeWithProgress = async (decision: SyncDecision): Promise<void> => {
			this.onProgress?.({ total, completed, currentPath: decision.path });
			try {
				await this.executeOne(decision, result);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				result.errors.push(`${decision.path}: ${msg}`);
				this.logger?.error("File sync failed", { path: decision.path, decision: decision.decision, error: msg });
			}
			completed++;
		};

		// Phase A: parallel-safe decisions (push, pull, initial_match, etc.)
		const pool = new AsyncPool(3);
		await Promise.all(
			parallelSafe.map((d) => pool.run(() => executeWithProgress(d)))
		);

		// Phase B: local_deleted_propagate (removeEmptyParents may race)
		for (const d of serialDeletes) {
			await executeWithProgress(d);
		}

		// Phase C: conflicts (may show UI modals)
		for (const d of conflicts) {
			await executeWithProgress(d);
		}

		this.onProgress?.({
			total,
			completed: total,
			currentPath: "",
		});

		return result;
	}

	private async executeOne(
		decision: SyncDecision,
		result: SyncResult
	): Promise<void> {
		const { path } = decision;

		switch (decision.decision) {
			case "local_created_push":
			case "local_modified_push":
				return executePush(this, decision, result);

			case "remote_created_pull":
			case "remote_modified_pull":
				return executePull(this, decision, result);

			case "remote_deleted_propagate":
			case "local_deleted_propagate":
				return executeDeletePropagation(
					this, decision, result,
					(d) => this.executeOne(d, result),
				);

			case "conflict_both_modified":
			case "conflict_both_created":
			case "conflict_delete_vs_modify":
				return executeConflict(this, decision, result);

			case "both_deleted_cleanup":
				await this.stateStore.delete(path);
				break;

			case "initial_match": {
				const record: SyncRecord = {
					path,
					hash: decision.local!.hash ?? decision.remote!.hash ?? "",
					localMtime: decision.local!.mtime,
					remoteMtime: decision.remote!.mtime,
					localSize: decision.local!.size,
					remoteSize: decision.remote!.size,
					backendMeta: decision.remote!.backendMeta,
					syncedAt: Date.now(),
				};
				await this.stateStore.put(record);
				break;
			}

			case "no_action":
				break;
		}
	}
}
