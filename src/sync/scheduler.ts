import { debounce } from "obsidian";
import type { EventRef, Workspace, Vault, TAbstractFile, TFile } from "obsidian";
import type { IFileSystem } from "../fs/interface";
import type { SyncStateStore } from "./state";
import type { LocalChangeTracker } from "./local-tracker";
import { hasChanged, hasRemoteChanged } from "./change-compare";

const DEBOUNCE_MS = 5000;

export interface SyncOrchestrator {
	isSyncing(): boolean;
	runSync(): Promise<void>;
	pullSingle(path: string): Promise<void>;
}

export interface SyncSchedulerDeps {
	workspace: Workspace;
	vault: Vault;
	localFs: () => IFileSystem | null;
	remoteFs: () => IFileSystem | null;
	stateStore: SyncStateStore;
	localTracker: LocalChangeTracker;
	orchestrator: SyncOrchestrator;
	autoSyncIntervalMinutes: () => number;
	isExcluded: (path: string) => boolean;
	registerEvent: (ref: EventRef) => void;
	registerInterval: (id: number) => number;
	register: (cb: () => void) => void;
}

export class SyncScheduler {
	private deps: SyncSchedulerDeps;
	private autoSyncIntervalId: number | null = null;
	private debouncedSync: ReturnType<typeof debounce>;

	constructor(deps: SyncSchedulerDeps) {
		this.deps = deps;
		this.debouncedSync = debounce(
			() => { void deps.orchestrator.runSync(); },
			DEBOUNCE_MS,
			false,
		);
	}

	start(): void {
		this.wireVaultEvents();
		this.wireOnlineEvent();
		this.wireVisibilityEvent();
		this.wireFileOpenEvent();
		this.startAutoSync();
	}

	stop(): void {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	destroy(): void {
		this.stop();
		this.debouncedSync.cancel();
	}

	restartAutoSync(): void {
		this.stop();
		this.startAutoSync();
	}

	private startAutoSync(): void {
		const minutes = this.deps.autoSyncIntervalMinutes();
		if (minutes > 0) {
			this.autoSyncIntervalId = this.deps.registerInterval(
				window.setInterval(() => {
					if (!this.deps.orchestrator.isSyncing()) {
						void this.deps.orchestrator.runSync();
					}
				}, minutes * 60 * 1000),
			);
		}
	}

	private wireVaultEvents(): void {
		const { vault, localTracker, isExcluded } = this.deps;

		const onVaultChange = (file: TAbstractFile) => {
			if (!isExcluded(file.path)) {
				localTracker.markDirty(file.path);
				this.debouncedSync();
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
				this.debouncedSync();
			}
		};

		this.deps.registerEvent(vault.on("create", onVaultChange));
		this.deps.registerEvent(vault.on("modify", onVaultChange));
		this.deps.registerEvent(vault.on("delete", onVaultChange));
		this.deps.registerEvent(vault.on("rename", onRename));
	}

	private wireOnlineEvent(): void {
		const onOnline = () => {
			if (!this.deps.orchestrator.isSyncing()) {
				void this.deps.orchestrator.runSync();
			}
		};
		window.addEventListener("online", onOnline);
		this.deps.register(() => window.removeEventListener("online", onOnline));
	}

	private wireVisibilityEvent(): void {
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible" && !this.deps.orchestrator.isSyncing()) {
				this.debouncedSync();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		this.deps.register(() => document.removeEventListener("visibilitychange", onVisibilityChange));
	}

	private wireFileOpenEvent(): void {
		const { workspace, stateStore, localFs, remoteFs, orchestrator } = this.deps;

		this.deps.registerEvent(
			workspace.on("file-open", async (file: TFile | null) => {
				if (!file || orchestrator.isSyncing()) return;
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
