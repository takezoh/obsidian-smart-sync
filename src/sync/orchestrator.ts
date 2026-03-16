import type { SmartSyncSettings } from "../settings";
import type { IFileSystem } from "../fs/interface";
import type { IBackendProvider } from "../fs/backend";
import type { Logger } from "../logging/logger";
import { AsyncMutex } from "../queue/async-queue";
import { isIgnored } from "../utils/ignore";
import { SyncStateStore } from "./state";
import { LocalChangeTracker } from "./local-tracker";
import { collectChanges } from "./change-detector";
import { planSync } from "./decision-engine";
import { executePlan } from "./plan-executor";
import type { ExecutionContext } from "./plan-executor";
import type { SimplifiedConflictStrategy } from "./conflict-resolver";
import { AuthError } from "../fs/errors";
import { getErrorInfo, isRateLimitError, sleep } from "./error";
import type { SyncStatus } from "./service";
import { buildSyncRecord } from "./state-committer";

export type { SyncStatus };

export interface SyncOrchestratorDeps {
	getSettings: () => SmartSyncSettings;
	saveSettings: () => Promise<void>;
	localFs: () => IFileSystem | null;
	remoteFs: () => IFileSystem | null;
	backendProvider: () => IBackendProvider | null;
	onStatusChange: (status: SyncStatus) => void;
	onProgress: (text: string) => void;
	notify: (message: string, durationMs?: number) => void;
	/** Returns true when running on mobile (used for mobile sync restrictions) */
	isMobile: () => boolean;
	localTracker: LocalChangeTracker;
	logger?: Logger;
}

const MAX_RETRIES = 3;

export class SyncOrchestrator {
	private syncMutex = new AsyncMutex();
	private stateStore: SyncStateStore;
	private syncPending = false;
	private deps: SyncOrchestratorDeps;

	constructor(deps: SyncOrchestratorDeps) {
		this.deps = deps;
		const vaultId = deps.getSettings().vaultId;
		this.stateStore = new SyncStateStore(vaultId);
	}

	get state(): SyncStateStore {
		return this.stateStore;
	}

	isSyncing(): boolean {
		return this.syncMutex.isLocked;
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
				let succeeded = 0;
				let failed = 0;
				let conflicts = 0;

				for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
					try {
						const result = await this.executeSyncOnce();
						succeeded = result.succeeded.length;
						failed = result.failed.length;
						conflicts = result.conflicts.length;
						lastError = null;
						break;
					} catch (err) {
						lastError = err;
						const { status, retryAfter } = getErrorInfo(err);
						this.deps.logger?.error(
							`Sync error (attempt ${attempt}/${MAX_RETRIES})`,
							{ status, message: err instanceof Error ? err.message : String(err) },
						);

						if (err instanceof AuthError) {
							this.deps.onStatusChange("error");
							this.deps.notify(
								"Authentication error. Please reconnect in settings."
							);
							return;
						}
						if (status === 403 && !isRateLimitError(err)) {
							this.deps.onStatusChange("error");
							this.deps.notify(
								"Permission denied. Please check your Google Drive permissions."
							);
							return;
						}
						if (status === 404) {
							break;
						}

						if (attempt === MAX_RETRIES) break;

						let delay: number;
						if ((status === 429 || status === 403) && retryAfter !== null) {
							delay = retryAfter * 1000;
						} else {
							const base = Math.pow(2, attempt - 1) * 1000;
							delay = base * (0.5 + Math.random());
						}
						await sleep(delay);
					}
				}

				if (lastError) {
					this.deps.onStatusChange("error");
					const msg =
						lastError instanceof Error ? lastError.message : "Unknown error";
					this.deps.notify(`Sync error: ${msg}`);
					this.deps.logger?.error("Sync failed after retries", { message: msg });
					await this.deps.logger?.flush();
					return;
				}

				if (failed > 0) {
					this.deps.onStatusChange("partial_error");
					this.deps.logger?.warn("Sync completed with errors", {
						succeeded,
						conflicts,
						failed,
					});
				} else {
					this.deps.onStatusChange("idle");
					this.deps.logger?.info("Sync completed", {
						succeeded,
						conflicts,
						failed,
					});
				}

				const parts: string[] = [];
				if (succeeded > 0) parts.push(`${succeeded} synced`);
				if (conflicts > 0) parts.push(`${conflicts} conflicts`);
				if (failed > 0) parts.push(`${failed} errors`);

				if (parts.length === 0) {
					this.deps.notify("Everything up to date");
				} else {
					this.deps.notify(`Sync: ${parts.join(", ")}`);
				}

				await this.deps.logger?.flush();

				// Acknowledge all paths after sync
				const allPaths = this.deps.localTracker.getDirtyPaths();
				this.deps.localTracker.acknowledge(allPaths);
			} while (this.syncPending);
		});
	}

	async pullSingle(path: string): Promise<void> {
		await this.syncMutex.run(async () => {
			const localFs = this.deps.localFs();
			const remoteFs = this.deps.remoteFs();
			if (!localFs || !remoteFs) {
				this.deps.logger?.warn("pullSingle: skipped — no local or remote fs", { path });
				return;
			}

			try {
				const remote = await remoteFs.stat(path);
				if (!remote || remote.isDirectory) {
					this.deps.logger?.warn("pullSingle: remote file not found or is a directory", { path });
					return;
				}

				const content = await remoteFs.read(path);
				const localEntity = await localFs.write(path, content, remote.mtime);
				const remoteEntity = remote;

				const record = buildSyncRecord(localEntity, remoteEntity, path);
				await this.stateStore.put(record);

				this.deps.logger?.info("pullSingle: completed", { path });
			} catch (err) {
				this.deps.logger?.error("pullSingle: failed", {
					path,
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				this.deps.localTracker.acknowledge([path]);
			}
		});
	}

	getStatus(): SyncStatus {
		return this.syncMutex.isLocked ? "syncing" : "idle";
	}

	private async executeSyncOnce() {
		const localFs = this.deps.localFs();
		const remoteFs = this.deps.remoteFs();
		if (!localFs || !remoteFs) {
			throw new Error("Cannot sync: local or remote filesystem is not available");
		}
		const settings = this.deps.getSettings();

		const changeSet = await collectChanges({
			localFs,
			remoteFs,
			stateStore: this.stateStore,
			localTracker: this.deps.localTracker,
		});

		const isMobile = this.deps.isMobile();
		const maxBytes = settings.mobileMaxFileSizeMB * 1024 * 1024;
		const filtered = changeSet.entries.filter((e) => {
			if (this.isExcluded(e.path)) return false;
			if (isMobile) {
				const size = Math.max(e.local?.size ?? 0, e.remote?.size ?? 0);
				if (size > maxBytes) return false;
			}
			return true;
		});

		if (filtered.length !== changeSet.entries.length) {
			this.deps.logger?.debug("Files filtered", {
				total: changeSet.entries.length,
				afterFilter: filtered.length,
				excluded: changeSet.entries.length - filtered.length,
			});
		}

		const plan = planSync(filtered);

		const total = plan.actions.length;

		const s = settings.conflictStrategy;
		const conflictStrategy: SimplifiedConflictStrategy =
			s === "auto_merge" || s === "duplicate" || s === "ask" ? s : "auto_merge";

		const ctx: ExecutionContext = {
			localFs,
			remoteFs,
			committer: {
				stateStore: this.stateStore,
				enableThreeWayMerge: settings.enableThreeWayMerge,
				localFs,
				logger: this.deps.logger,
			},
			conflictStrategy,
			onProgress: (completed: number) => {
				if (total > 0) {
					this.deps.onProgress(`Syncing ${completed}/${total}...`);
				}
			},
			logger: this.deps.logger,
		};

		const result = await executePlan(plan, ctx);

		// Persist backend state
		const provider = this.deps.backendProvider();
		if (provider?.readBackendState && remoteFs) {
			const current = settings.backendData[provider.type] ?? {};
			settings.backendData[provider.type] = {
				...current,
				...provider.readBackendState(remoteFs),
			};
		}
		await this.deps.saveSettings();

		return result;
	}
}
