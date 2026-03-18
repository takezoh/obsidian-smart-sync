import type { AirSyncSettings } from "../settings";
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
import type { ExecutionContext, ExecutionResult } from "./plan-executor";
import { AuthError } from "../fs/errors";
import { getErrorInfo, isRateLimitError, sleep } from "./error";
import type { SyncStatus } from "./types";
import { buildSyncRecord } from "./state-committer";

export type { SyncStatus };

interface SyncCycleResult {
	result: ExecutionResult;
	succeeded: number;
	failed: number;
	conflicts: number;
}

function buildNotificationMessage(cycle: SyncCycleResult): string {
	const counts = { pushed: 0, pulled: 0, matched: 0, deleted: 0 };
	for (const a of cycle.result.succeeded) {
		if (a.action.action === "push") counts.pushed++;
		else if (a.action.action === "pull") counts.pulled++;
		else if (a.action.action === "match") counts.matched++;
		else if (a.action.action === "delete_local" || a.action.action === "delete_remote") counts.deleted++;
	}
	const parts: string[] = [];
	if (counts.pushed > 0) parts.push(`${counts.pushed} pushed`);
	if (counts.pulled > 0) parts.push(`${counts.pulled} pulled`);
	if (counts.matched > 0) parts.push(`${counts.matched} matched`);
	if (counts.deleted > 0) parts.push(`${counts.deleted} deleted`);
	if (cycle.conflicts > 0) parts.push(`${cycle.conflicts} conflicts`);
	if (cycle.failed > 0) parts.push(`${cycle.failed} errors`);
	return parts.length === 0 ? "Everything up to date" : `Sync: ${parts.join(", ")}`;
}

export interface SyncOrchestratorDeps {
	getSettings: () => AirSyncSettings;
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

				const result = await this.executeWithRetry();
				if (!result) return; // Fatal error already handled

				const { succeeded, failed, conflicts } = result;
				if (failed > 0) {
					this.deps.onStatusChange("partial_error");
					this.deps.logger?.warn("Sync completed with errors", { succeeded, conflicts, failed });
				} else {
					this.deps.onStatusChange("idle");
					this.deps.logger?.info("Sync completed", { succeeded, conflicts, failed });
				}

				if (this.deps.getSettings().enableLogging) {
					this.deps.notify(buildNotificationMessage(result));
				}
				await this.deps.logger?.flush();

				const allPaths = this.deps.localTracker.getDirtyPaths();
				this.deps.localTracker.acknowledge(allPaths);
			} while (this.syncPending);
		});
	}

	/**
	 * Execute sync with retry logic. Returns null on fatal error (already reported).
	 */
	private async executeWithRetry(): Promise<SyncCycleResult | null> {
		let lastError: unknown = null;
		let lastResult: ExecutionResult | null = null;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				lastResult = await this.executeSyncOnce();
				return {
					result: lastResult,
					succeeded: lastResult.succeeded.length,
					failed: lastResult.failed.length,
					conflicts: lastResult.conflicts.length,
				};
			} catch (err) {
				lastError = err;
				const { status, retryAfter } = getErrorInfo(err);
				this.deps.logger?.error(
					`Sync error (attempt ${attempt}/${MAX_RETRIES})`,
					{ status, message: err instanceof Error ? err.message : String(err) },
				);

				if (err instanceof AuthError) {
					this.deps.onStatusChange("error");
					this.deps.notify("Authentication error. Please reconnect in settings.");
					return null;
				}
				if (status === 403 && !isRateLimitError(err)) {
					this.deps.onStatusChange("error");
					this.deps.notify("Permission denied. Please check your Google Drive permissions.");
					return null;
				}
				if (status === 404) break;
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

		this.deps.onStatusChange("error");
		const msg = lastError instanceof Error ? lastError.message : "Unknown error";
		this.deps.notify(`Sync error: ${msg}`);
		this.deps.logger?.error("Sync failed after retries", { message: msg });
		await this.deps.logger?.flush();
		return null;
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

		const remoteOnlyPaths = changeSet.entries.filter((e) => !e.local && e.remote).map((e) => e.path);
		this.deps.logger?.info("Change detection completed", {
			temperature: changeSet.temperature,
			entries: changeSet.entries.length,
			localOnly: changeSet.entries.filter((e) => e.local && !e.remote).length,
			remoteOnly: remoteOnlyPaths.length,
			both: changeSet.entries.filter((e) => e.local && e.remote).length,
			enriched: changeSet.entries.filter((e) => e.local?.hash?.startsWith("md5:")).length,
		});
		if (remoteOnlyPaths.length > 0) {
			this.deps.logger?.debug("Remote-only paths", { paths: remoteOnlyPaths });
		}

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

		const actionBreakdown: Record<string, number> = {};
		for (const a of plan.actions) {
			actionBreakdown[a.action] = (actionBreakdown[a.action] ?? 0) + 1;
		}
		this.deps.logger?.info("Sync plan created", {
			total: plan.actions.length,
			...actionBreakdown,
			safetyCheck: plan.safetyCheck,
		});

		const total = plan.actions.length;

		const ctx: ExecutionContext = {
			localFs,
			remoteFs,
			committer: {
				stateStore: this.stateStore,
				enableThreeWayMerge: settings.enableThreeWayMerge,
				localFs,
				logger: this.deps.logger,
			},
			conflictStrategy: settings.conflictStrategy,
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
