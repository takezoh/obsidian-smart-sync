import type { IFileSystem } from "../fs/interface";
import type { ConflictStrategy, FileEntity, SyncDecision, SyncRecord } from "../fs/types";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import { resolveConflict, buildSyncRecord } from "./conflict";
import { isMergeEligible } from "./merge";
import { AsyncPool } from "../queue/async-queue";

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
	errors: string[];
}

export type OnProgress = (progress: SyncProgress) => void;
export type OnConflict = (
	decision: SyncDecision
) => Promise<ConflictStrategy>;

/**
 * Execute sync decisions against the local and remote filesystems.
 */
export class SyncExecutor {
	private localFs: IFileSystem;
	private remoteFs: IFileSystem;
	private stateStore: SyncStateStore;
	private defaultStrategy: ConflictStrategy;
	private enableThreeWayMerge: boolean;
	private onProgress?: OnProgress;
	private onConflict?: OnConflict;
	private logger?: Logger;

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
			case "local_modified_push": {
				const content = await this.localFs.read(path);
				const remoteResult = await this.remoteFs.write(path, content, decision.local!.mtime);
				// Re-stat local to get fresh mtime (file may have changed since decision)
				const freshLocal = await this.localFs.stat(path);
				await this.updateSyncRecord(path, freshLocal ?? decision.local!, remoteResult);
				result.pushed++;
				break;
			}

			case "remote_created_pull":
			case "remote_modified_pull": {
				const content = await this.remoteFs.read(path);
				const localResult = await this.localFs.write(path, content, decision.remote!.mtime);
				// Re-stat remote to get fresh metadata (symmetric with push flow)
				const freshRemote = await this.remoteFs.stat(path);
				await this.updateSyncRecord(path, localResult, freshRemote ?? decision.remote!);
				result.pulled++;
				break;
			}

			case "remote_deleted_propagate": {
				// TOCTOU guard: check if remote was re-created since decision
				const remoteCheck = await this.remoteFs.stat(path);
				if (remoteCheck) {
					const localCheck = await this.localFs.stat(path);
					const conflictDecision: SyncDecision = {
						...decision,
						decision: "conflict_delete_vs_modify",
						local: localCheck ?? decision.local,
						remote: remoteCheck,
					};
					await this.executeOne(conflictDecision, result);
					return;
				}
				await this.localFs.delete(path);
				await this.stateStore.delete(path);
				result.pulled++;
				break;
			}

			case "local_deleted_propagate": {
				// TOCTOU guard: check if local was re-created since decision
				const localCheck = await this.localFs.stat(path);
				if (localCheck) {
					const remoteCheck = await this.remoteFs.stat(path);
					const conflictDecision: SyncDecision = {
						...decision,
						decision: "conflict_delete_vs_modify",
						local: localCheck,
						remote: remoteCheck ?? decision.remote,
					};
					await this.executeOne(conflictDecision, result);
					return;
				}
				await this.remoteFs.delete(path);
				await this.stateStore.delete(path);
				await this.removeEmptyParents(this.remoteFs, path);
				result.pushed++;
				break;
			}

			case "conflict_both_modified":
			case "conflict_both_created":
			case "conflict_delete_vs_modify": {
				let strategy = this.defaultStrategy;

				if (
					this.enableThreeWayMerge &&
					decision.prevSync &&
					(strategy === "keep_newer" || strategy === "ask")
				) {
					strategy = "three_way_merge";
				} else if (strategy === "ask" && this.onConflict) {
					strategy = await this.onConflict(decision);
				}

				// Lazy fallback: only prompts the user if 3-way merge actually fails
				const getFallback = async (): Promise<ConflictStrategy> => {
					if (this.defaultStrategy === "ask" && this.onConflict) {
						return this.onConflict(decision);
					}
					return this.defaultStrategy;
				};

				const resolution = await resolveConflict(
					path,
					strategy,
					this.localFs,
					this.remoteFs,
					decision.local,
					decision.remote,
					decision.prevSync,
					this.stateStore,
					getFallback,
					this.logger
				);

				// Track paths with unresolved merge conflicts
				if (resolution.hasConflictMarkers) {
					result.mergeConflictPaths.push(path);
				}

				// Update sync record based on resolution
				const record = await buildSyncRecord(
					path,
					this.localFs,
					this.remoteFs,
					this.enableThreeWayMerge,
					this.stateStore,
					this.logger
				);
				if (record) {
					await this.stateStore.put(record);
				}

				// If duplicated, also save a record for the duplicate
				if (resolution.duplicatePath) {
					const dupRecord = await buildSyncRecord(
						resolution.duplicatePath,
						this.localFs,
						this.remoteFs,
						this.enableThreeWayMerge,
						this.stateStore,
						this.logger
					);
					if (dupRecord) {
						await this.stateStore.put(dupRecord);
					}
				}

				result.conflicts++;
				break;
			}

			case "both_deleted_cleanup": {
				await this.stateStore.delete(path);
				break;
			}

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

	/**
	 * Walk up from a deleted file's path and remove each parent directory
	 * that is now empty, stopping at the sync root.
	 */
	private async removeEmptyParents(fs: IFileSystem, filePath: string): Promise<void> {
		let dir = filePath.substring(0, filePath.lastIndexOf("/"));
		while (dir) {
			const children = await fs.listDir(dir);
			if (children.length > 0) break;
			await fs.delete(dir);
			dir = dir.substring(0, dir.lastIndexOf("/"));
		}
	}

	private async updateSyncRecord(
		path: string,
		localEntity: FileEntity,
		remoteEntity: FileEntity
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

		await this.stateStore.put(record);

		if (this.enableThreeWayMerge && isMergeEligible(path, record.localSize)) {
			// Store content separately for future 3-way merges (text files only)
			try {
				const content = await this.localFs.read(path);
				await this.stateStore.putContent(path, content);
			} catch (err) {
				console.warn(`Smart Sync: failed to store content for 3-way merge (${path}):`, err);
				this.logger?.warn("Failed to store content for 3-way merge", { path, error: err instanceof Error ? err.message : String(err) });
			}
		}
	}
}
