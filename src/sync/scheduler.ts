import type { EventRef, Workspace, Vault, TAbstractFile, TFile } from "obsidian";
import type { IFileSystem } from "../fs/interface";
import type { SyncStateStore } from "./state";
import type { LocalChangeTracker } from "./local-tracker";
import { hasChanged, hasRemoteChanged } from "./change-compare";

const DEBOUNCE_MS = 5000;
const HEARTBEAT_MS = 1000;

export interface SyncOrchestrator {
	runSync(): Promise<void>;
	pullSingle(path: string): Promise<void>;
	isSyncing(): boolean;
}

export interface SyncSchedulerDeps {
	workspace: Workspace;
	vault: Vault;
	localFs: () => IFileSystem | null;
	remoteFs: () => IFileSystem | null;
	stateStore: SyncStateStore;
	localTracker: LocalChangeTracker;
	orchestrator: SyncOrchestrator;
	isExcluded: (path: string) => boolean;
	registerEvent: (ref: EventRef) => void;
	register: (cb: () => void) => void;
	getSlowPollIntervalSec: () => number;
}

export class SyncScheduler {
	private deps: SyncSchedulerDeps;
	private nextSyncAt: number | null = null;
	private lastSyncCompletedAt: number;
	private heartbeatHandle: ReturnType<typeof setInterval> | null = null;

	constructor(deps: SyncSchedulerDeps) {
		this.deps = deps;
		this.lastSyncCompletedAt = 0;
	}

	start(): void {
		this.wireVaultEvents();
		this.wireOnlineEvent();
		this.wireVisibilityEvent();
		this.wireFocusEvent();
		this.wireFileOpenEvent();
		this.heartbeatHandle = setInterval(() => { this.onHeartbeat(); }, HEARTBEAT_MS);
	}

	destroy(): void {
		if (this.heartbeatHandle !== null) {
			clearInterval(this.heartbeatHandle);
			this.heartbeatHandle = null;
		}
		this.nextSyncAt = null;
	}

	/** Called by the orchestrator when a sync cycle completes. */
	notifySyncComplete(): void {
		this.lastSyncCompletedAt = Date.now();
	}

	private onHeartbeat(): void {
		const now = Date.now();
		const remoteFs = this.deps.remoteFs();
		if (!remoteFs) return;
		if (this.deps.orchestrator.isSyncing()) return;

		// Debounce path: a vault change scheduled a sync
		if (this.nextSyncAt !== null && now >= this.nextSyncAt) {
			this.nextSyncAt = null;
			void this.deps.orchestrator.runSync();
			return;
		}

		// Slow poll path: time since last sync exceeds the configured interval
		const slowPollMs = this.deps.getSlowPollIntervalSec() * 1000;
		if (slowPollMs > 0 && now >= this.lastSyncCompletedAt + slowPollMs) {
			void this.deps.orchestrator.runSync();
		}
	}

	private wireFocusEvent(): void {
		const onFocus = () => {
			if (!this.deps.remoteFs()) return;
			if (this.deps.orchestrator.isSyncing()) return;
			void this.deps.orchestrator.runSync();
		};
		window.addEventListener("focus", onFocus);
		this.deps.register(() => window.removeEventListener("focus", onFocus));
	}

	private wireVaultEvents(): void {
		const { vault, localTracker, isExcluded } = this.deps;

		const onVaultChange = (file: TAbstractFile) => {
			if (!isExcluded(file.path)) {
				localTracker.markDirty(file.path);
				this.nextSyncAt = Date.now() + DEBOUNCE_MS;
			}
		};

		const onRename = (file: TAbstractFile, oldPath: string) => {
			if (!isExcluded(file.path)) {
				localTracker.markDirty(file.path);
			}
			if (!isExcluded(oldPath)) {
				localTracker.markDirty(oldPath);
			}
			if (!isExcluded(file.path) || !isExcluded(oldPath)) {
				this.nextSyncAt = Date.now() + DEBOUNCE_MS;
			}
		};

		this.deps.registerEvent(vault.on("create", onVaultChange));
		this.deps.registerEvent(vault.on("modify", onVaultChange));
		this.deps.registerEvent(vault.on("delete", onVaultChange));
		this.deps.registerEvent(vault.on("rename", onRename));
	}

	private wireOnlineEvent(): void {
		const onOnline = () => {
			if (!this.deps.remoteFs()) return;
			if (this.deps.orchestrator.isSyncing()) return;
			void this.deps.orchestrator.runSync();
		};
		window.addEventListener("online", onOnline);
		this.deps.register(() => window.removeEventListener("online", onOnline));
	}

	private wireVisibilityEvent(): void {
		const onVisibilityChange = () => {
			if (!this.deps.remoteFs()) return;
			if (document.visibilityState !== "visible") return;
			if (this.deps.orchestrator.isSyncing()) return;
			void this.deps.orchestrator.runSync();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		this.deps.register(() => document.removeEventListener("visibilitychange", onVisibilityChange));
	}

	private wireFileOpenEvent(): void {
		const { workspace, stateStore, localFs, remoteFs, orchestrator } = this.deps;

		this.deps.registerEvent(
			workspace.on("file-open", async (file: TFile | null) => {
				if (!file) return;
				const record = await stateStore.get(file.path);
				if (!record) return;
				const lFs = localFs();
				const rFs = remoteFs();
				if (!lFs || !rFs) return;
				const [localStat, remote] = await Promise.all([
					lFs.stat(file.path),
					rFs.stat(file.path),
				]);
				if (!remote || remote.isDirectory) return;
				if (!hasRemoteChanged(remote, record)) return;
				if (localStat && hasChanged(localStat, record)) return;
				await orchestrator.pullSingle(file.path);
			}),
		);
	}
}
