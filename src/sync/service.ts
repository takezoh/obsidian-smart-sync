import type { SmartSyncSettings } from "../settings";
import type { IFileSystem } from "../fs/interface";
import type { IBackendProvider } from "../fs/backend";
import type { ConflictStrategy, MixedEntity, SyncDecision } from "./types";
import { AsyncMutex } from "../queue/async-queue";
import { isIgnored } from "../utils/ignore";
import { sha256 } from "../utils/hash";
import { SyncStateStore } from "./state";
import { buildMixedEntities, computeDecisions } from "./engine";
import { SyncExecutor, SyncProgress, SyncResult } from "./executor";
import type { Logger } from "../logging/logger";
import { getErrorInfo, isRateLimitError, sleep } from "./error";
import { ConflictHistory } from "./conflict-history";

export type { ErrorInfo } from "./error";
export { getErrorInfo, isRateLimitError } from "./error";

export type SyncStatus = "idle" | "syncing" | "error" | "partial_error" | "not_connected";
const MAX_RETRIES = 3;


export interface SyncServiceDeps {
	getSettings: () => SmartSyncSettings;
	saveSettings: () => Promise<void>;
	localFs: () => IFileSystem | null;
	remoteFs: () => IFileSystem | null;
	backendProvider: () => IBackendProvider | null;
	onStatusChange: (status: SyncStatus) => void;
	onProgress: (text: string) => void;
	notify: (message: string, durationMs?: number) => void;
	resolveConflict: (decision: SyncDecision) => Promise<ConflictStrategy>;
	resolveConflictBatch: (conflicts: SyncDecision[]) => Promise<ConflictStrategy | null>;
	/** Returns true when running on mobile (used for mobile sync restrictions) */
	isMobile: () => boolean;
	logger?: Logger;
}

/**
 * Orchestrates the sync lifecycle: retry logic, progress reporting,
 * conflict resolution UI, and exclusion filtering.
 */
export class SyncService {
	private syncMutex = new AsyncMutex();
	private stateStore: SyncStateStore;
	private syncPending = false;
	private deps: SyncServiceDeps;

	constructor(deps: SyncServiceDeps) {
		this.deps = deps;
		const vaultId = deps.getSettings().vaultId;
		this.stateStore = new SyncStateStore(vaultId);
	}

	get state(): SyncStateStore {
		return this.stateStore;
	}

	get isLocked(): boolean {
		return this.syncMutex.isLocked;
	}

	async close(): Promise<void> {
		await this.stateStore.close();
	}

	async clearSyncState(): Promise<void> {
		this.deps.logger?.info("Clearing sync state");
		await this.stateStore.clear();
	}

	shouldSync(): boolean {
		const hasRemote = !!this.deps.remoteFs();
		const isLocked = this.syncMutex.isLocked;
		if (!hasRemote || isLocked) {
			this.deps.logger?.debug("shouldSync: skipped", { hasRemote, isLocked });
		}
		return hasRemote && !isLocked;
	}

	isExcluded(path: string): boolean {
		return isIgnored(path, this.deps.getSettings().ignorePatterns);
	}

	async runSync(): Promise<void> {
		const remoteFs = this.deps.remoteFs();
		if (!remoteFs) {
			this.deps.onStatusChange("not_connected");
			this.deps.notify("Not connected to a remote backend");
			return;
		}

		if (this.syncMutex.isLocked) {
			this.syncPending = true;
			return;
		}

		await this.syncMutex.run(async () => {
			do {
				this.syncPending = false;
				this.deps.onStatusChange("syncing");
				this.deps.logger?.info("Sync started");

				let lastError: unknown = null;
				let lastResult: SyncResult | null = null;

				for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
					try {
						lastResult = await this.executeSyncOnce();
						lastError = null;
						break;
					} catch (err) {
						lastError = err;
						const { status, retryAfter } = getErrorInfo(err);
						this.deps.logger?.error(
							`Sync error (attempt ${attempt}/${MAX_RETRIES})`,
							{ status, message: err instanceof Error ? err.message : String(err) },
						);

						// Non-retryable errors: abort immediately
						if (status === 401) {
							this.deps.onStatusChange("error");
							this.deps.notify(
								"Authentication error. Please reconnect in settings."
							);
							return;
						}
						if (status === 403 && !isRateLimitError(err)) {
							this.deps.onStatusChange("error");
							this.deps.notify(
								"Authentication error. Please reconnect in settings."
							);
							return;
						}
						if (status === 400 || status === 404) {
							break;
						}

						if (attempt === MAX_RETRIES) break;

						// 429 or 403 rate limit: respect Retry-After header if present
						let delay: number;
						if ((status === 429 || status === 403) && retryAfter !== null) {
							delay = retryAfter * 1000;
						} else {
							// Exponential backoff with ±50% jitter
							const base = Math.pow(2, attempt - 1) * 1000;
							delay = base * (0.5 + Math.random());
						}
						await sleep(delay);
					}
				}

				if (lastError) {
					this.deps.onStatusChange("error");
					const msg =
						lastError instanceof Error
							? lastError.message
							: "Unknown error";
					this.deps.notify(`Sync error: ${msg}`);
					this.deps.logger?.error("Sync failed after retries", { message: msg });
					await this.deps.logger?.flush();
					return;
				}

				// Set status based on result
				if (lastResult && lastResult.errors.length > 0) {
					this.deps.onStatusChange("partial_error");
					this.deps.logger?.warn("Sync completed with errors", {
						pushed: lastResult.pushed,
						pulled: lastResult.pulled,
						conflicts: lastResult.conflicts,
						errors: lastResult.errors.length,
					});
				} else {
					this.deps.onStatusChange("idle");
					this.deps.logger?.info("Sync completed", {
						pushed: lastResult?.pushed ?? 0,
						pulled: lastResult?.pulled ?? 0,
						conflicts: lastResult?.conflicts ?? 0,
					});
				}
				await this.deps.logger?.flush();
			} while (this.syncPending);
		});
	}

	private async executeSyncOnce(): Promise<SyncResult> {
		const localFs = this.deps.localFs();
		const remoteFs = this.deps.remoteFs();
		if (!localFs || !remoteFs) {
			throw new Error("Cannot sync: local or remote filesystem is not available");
		}
		const settings = this.deps.getSettings();

		const entities = await buildMixedEntities(
			localFs,
			remoteFs,
			this.stateStore
		);

		const isMobile = this.deps.isMobile();
		const maxBytes = settings.mobileMaxFileSizeMB * 1024 * 1024;
		const filtered = entities.filter((e) => {
			if (this.isExcluded(e.path)) return false;
			if (isMobile) {
				const size = Math.max(e.local?.size ?? 0, e.remote?.size ?? 0);
				if (size > maxBytes) return false;
			}
			return true;
		});
		if (filtered.length !== entities.length) {
			this.deps.logger?.debug("Files filtered", {
				total: entities.length,
				afterFilter: filtered.length,
				excluded: entities.length - filtered.length,
			});
		}

		// Resolve empty hashes for initial sync (both exist, no prevSync)
		await this.resolveEmptyHashes(filtered, localFs, remoteFs);

		const decisions = computeDecisions(filtered);

		// Mass deletion safety net: abort if all local files would be deleted
		const deletePropagateCount = decisions.filter(
			(d) => d.decision === "remote_deleted_propagate"
		).length;
		const localFileCount = filtered.filter((e) => e.local).length;

		if (
			deletePropagateCount > 5 &&
			deletePropagateCount === localFileCount
		) {
			this.deps.logger?.error("Mass deletion safety net triggered", {
				deletePropagateCount,
				localFileCount,
			});
			await this.stateStore.clear();
			throw new Error(
				`Aborting sync: all ${deletePropagateCount} local files would be deleted ` +
					`(remote appears empty). Sync state has been reset — please sync again.`
			);
		}

		// Show summary modal for bulk resolution when there are many conflicts
		const conflictDecisions = decisions.filter(
			(d) =>
				d.decision === "conflict_both_modified" ||
				d.decision === "conflict_both_created" ||
				d.decision === "conflict_delete_vs_modify"
		);

		let bulkStrategy: ConflictStrategy | null = null;
		if (conflictDecisions.length >= 5 && settings.conflictStrategy === "ask") {
			this.deps.logger?.info("Showing conflict summary modal", { conflictCount: conflictDecisions.length });
			bulkStrategy = await this.deps.resolveConflictBatch(conflictDecisions);
		}

		const onProgress = (progress: SyncProgress) => {
			if (progress.total > 0) {
				this.deps.onProgress(
					`Syncing ${progress.completed}/${progress.total}...`
				);
			}
		};

		const onConflict = async (
			decision: SyncDecision
		): Promise<ConflictStrategy> => {
			return this.deps.resolveConflict(decision);
		};

		const executor = new SyncExecutor({
			localFs,
			remoteFs,
			stateStore: this.stateStore,
			defaultStrategy: bulkStrategy ?? settings.conflictStrategy,
			enableThreeWayMerge: settings.enableThreeWayMerge,
			onProgress,
			onConflict: bulkStrategy ? undefined : onConflict,
			logger: this.deps.logger,
		});

		const result = await executor.execute(decisions);

		// Write conflict history
		if (result.conflictRecords.length > 0 && this.deps.logger) {
			const sessionId = crypto.randomUUID();
			for (const rec of result.conflictRecords) {
				rec.sessionId = sessionId;
			}
			try {
				const history = new ConflictHistory(
					this.deps.logger.adapter,
					this.deps.logger.sanitizedDeviceName,
				);
				await history.append(result.conflictRecords);
			} catch (err) {
				this.deps.logger.warn("Failed to write conflict history", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Persist backend state (tokens, cursors, etc.) into backendData namespace
		const provider = this.deps.backendProvider();
		if (provider?.readBackendState && remoteFs) {
			const current = settings.backendData[provider.type] ?? {};
			settings.backendData[provider.type] = {
				...current,
				...provider.readBackendState(remoteFs),
			};
		}
		await this.deps.saveSettings();

		const parts: string[] = [];
		if (result.pushed > 0) parts.push(`${result.pushed} pushed`);
		if (result.pulled > 0) parts.push(`${result.pulled} pulled`);
		if (result.conflicts > 0) parts.push(`${result.conflicts} conflicts`);
		if (result.errors.length > 0)
			parts.push(`${result.errors.length} errors`);

		// Notify about files with unresolved merge conflict markers
		if (result.mergeConflictPaths.length > 0) {
			const count = result.mergeConflictPaths.length;
			this.deps.notify(
				`${count} file(s) merged with conflict markers. Please review and resolve manually.`,
				10000
			);
			this.deps.logger?.warn("Files with conflict markers", {
				paths: result.mergeConflictPaths,
			});
		}

		if (parts.length === 0) {
			this.deps.notify("Everything up to date");
		} else {
			this.deps.notify(`Sync: ${parts.join(", ")}`);
		}

		if (result.errors.length > 0) {
			const MAX_SHOW = 3;
			const shown = result.errors.slice(0, MAX_SHOW);
			const more = result.errors.length - shown.length;
			let errorMsg = `Sync errors:\n${shown.join("\n")}`;
			if (more > 0) errorMsg += `\n...and ${more} more`;
			this.deps.notify(errorMsg, 10000);
			this.deps.logger?.error("Per-file sync errors", { errors: result.errors });
			// Per-file errors are reported via notify + partial_error status.
			// Transport errors (network, 5xx) throw from the FS layer directly
			// and are handled by the retry loop in runSync().
		}

		return result;
	}

	/**
	 * For initial sync (both sides exist, no prevSync), list() returns empty hashes.
	 * Read content and compute SHA-256 so the engine can detect identical files.
	 * Only reads when sizes match (different sizes are obviously different content).
	 */
	private async resolveEmptyHashes(
		entities: MixedEntity[],
		localFs: IFileSystem,
		remoteFs: IFileSystem
	): Promise<void> {
		for (const entity of entities) {
			if (entity.local && entity.remote && !entity.prevSync &&
				!entity.local.hash && !entity.remote.hash &&
				entity.local.size === entity.remote.size) {
				const [localContent, remoteContent] = await Promise.all([
					localFs.read(entity.path),
					remoteFs.read(entity.path),
				]);
				const [localHash, remoteHash] = await Promise.all([
					sha256(localContent),
					sha256(remoteContent),
				]);
				entity.local = { ...entity.local, hash: localHash };
				entity.remote = { ...entity.remote, hash: remoteHash };
			}
		}
	}
}
