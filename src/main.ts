import { Notice, Platform, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, SmartSyncSettings } from "./settings";
import { SmartSyncSettingTab } from "./ui/settings";
import { LocalFs } from "./fs/local/index";
import { BackendManager } from "./fs/backend-manager";
import { initRegistry } from "./fs/registry";
import type { ISecretStore } from "./fs/secret-store";
import type { SyncStatus } from "./sync/orchestrator";
import { SyncOrchestrator } from "./sync/orchestrator";
import { SyncScheduler } from "./sync/scheduler";
import { LocalChangeTracker } from "./sync/local-tracker";
import { Logger, getDeviceName } from "./logging/logger";
import type { LoggerAdapter } from "./logging/logger";
import { migrateConflictStrategy } from "./migrate";

export default class SmartSyncPlugin extends Plugin {
	settings!: SmartSyncSettings;
	private localFs: LocalFs | null = null;
	backendManager!: BackendManager;
	private statusBarEl: HTMLElement | null = null;
	private syncStatus: SyncStatus = "not_connected";
	private orchestrator!: SyncOrchestrator;
	private scheduler!: SyncScheduler;
	private localTracker!: LocalChangeTracker;
	private settingTab: SmartSyncSettingTab | null = null;
	private logger!: Logger;

	async onload() {
		await this.loadSettings();

		const secretStore: ISecretStore = {
			getSecret: (key) => this.app.secretStorage.getSecret(key),
			setSecret: (key, value) => { this.app.secretStorage.setSecret(key, value); },
		};
		initRegistry(secretStore);

		this.localFs = new LocalFs(this.app, () => this.settings.syncDotPaths);

		const deviceName = getDeviceName(Platform.isMobile, this.settings.vaultId);
		this.logger = new Logger(
			this.app.vault.adapter as unknown as LoggerAdapter,
			() => this.settings,
			deviceName,
		);
		this.logger.info("Plugin loaded", { deviceName, vaultId: this.settings.vaultId });

		this.backendManager = new BackendManager({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			getApp: () => this.app,
			getLogger: () => this.logger,
			getVaultName: () => this.app.vault.getName(),
			onConnected: () => {
				this.syncStatus = "idle";
				this.updateStatusBar();
			},
			onDisconnected: () => {
				this.syncStatus = "not_connected";
				this.updateStatusBar();
			},
			onIdentityChanged: async () => {
				await this.orchestrator?.clearSyncState();
			},
			notify: (message) => {
				new Notice(message);
			},
			refreshSettingsDisplay: () => {
				this.settingTab?.display();
			},
		});

		this.localTracker = new LocalChangeTracker();

		this.orchestrator = new SyncOrchestrator({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			localFs: () => this.localFs,
			remoteFs: () => this.backendManager.getRemoteFs(),
			backendProvider: () => this.backendManager.getBackendProvider(),
			isMobile: () => Platform.isMobile,
			onStatusChange: (status) => {
				this.syncStatus = status;
				this.updateStatusBar();
			},
			onProgress: (text) => {
				this.statusBarEl?.setText(text);
			},
			notify: (message, durationMs) => {
				new Notice(message, durationMs);
			},
			localTracker: this.localTracker,
			logger: this.logger,
		});

		this.scheduler = new SyncScheduler({
			workspace: this.app.workspace,
			vault: this.app.vault,
			localFs: () => this.localFs,
			remoteFs: () => this.backendManager.getRemoteFs(),
			stateStore: this.orchestrator.state,
			localTracker: this.localTracker,
			orchestrator: this.orchestrator,
			autoSyncIntervalMinutes: () => this.settings.autoSyncIntervalMinutes,
			isExcluded: (path) => this.orchestrator.isExcluded(path),
			registerEvent: (ref) => this.registerEvent(ref),
			registerInterval: (id) => this.registerInterval(id),
			register: (cb) => this.register(cb),
		});

		this.settingTab = new SmartSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Handle OAuth callback via obsidian://smart-sync-auth?access_token=...&state=... or ?code=...&state=...
		this.registerObsidianProtocolHandler("smart-sync-auth", (params) => {
			if (!params.access_token && !params.code) {
				new Notice("Authorization failed: no token or code received");
				return;
			}
			// Synthetic URL to pass tokens/code to completeAuth(), which parses callback URL params
			const url = new URL("https://callback");
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
			void this.backendManager.completeBackendConnect(url.toString());
		});

		// Initialize backend if configured
		await this.backendManager.initBackend();

		// Commands
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				void this.runSync();
			},
		});

		// Ribbon icon
		this.addRibbonIcon("cloud", "Sync now", () => {
			void this.runSync();
		});

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar();

		this.scheduler.start();
	}

	onunload() {
		void this.logger.flush();
		this.logger.dispose();
		this.backendManager.close();
		this.scheduler.destroy();
		this.orchestrator.close().catch((e) => {
			this.logger.error("Failed to close orchestrator", { message: e instanceof Error ? e.message : String(e) });
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<SmartSyncSettings>,
		);

		let needsSave = false;

		// Generate a stable vault ID on first load
		if (!this.settings.vaultId) {
			this.settings.vaultId = crypto.randomUUID();
			needsSave = true;
		}

		// Migrate legacy conflict strategies to v2 values
		const migrated = migrateConflictStrategy(this.settings.conflictStrategy);
		if (migrated !== this.settings.conflictStrategy) {
			this.settings.conflictStrategy = migrated;
			needsSave = true;
		}

		if (needsSave) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Restart the auto-sync interval (called from settings UI) */
	setupAutoSync(): void {
		this.scheduler.restartAutoSync();
	}

	async runSync(): Promise<void> {
		try {
			if (!this.localFs || !this.backendManager.getRemoteFs()) {
				await this.backendManager.initBackend();
				if (!this.localFs || !this.backendManager.getRemoteFs()) {
					this.syncStatus = "not_connected";
					this.updateStatusBar();
					new Notice("Not connected to a remote backend");
					return;
				}
			}
			await this.orchestrator.runSync();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.syncStatus = "error";
			this.updateStatusBar();
			new Notice(`Sync error: ${msg}`);
			this.logger.error("Unhandled sync error", { error: msg });
		}
	}

	private updateStatusBar(): void {
		if (!this.statusBarEl) return;
		switch (this.syncStatus) {
			case "idle":
				this.statusBarEl.setText("Synced");
				break;
			case "syncing":
				this.statusBarEl.setText("Syncing...");
				break;
			case "error":
				this.statusBarEl.setText("Sync error");
				break;
			case "partial_error":
				this.statusBarEl.setText("Synced (with errors)");
				break;
			case "not_connected":
				this.statusBarEl.setText("Not connected");
				break;
		}
	}
}
