import { debounce, Notice, Platform, Plugin, TAbstractFile } from "obsidian";
import { DEFAULT_DESKTOP_IGNORE_PATTERNS, DEFAULT_MOBILE_IGNORE_PATTERNS, DEFAULT_SETTINGS, SmartSyncSettings } from "./settings";
import { SmartSyncSettingTab } from "./ui/settings";
import { LocalFs } from "./fs/local/index";
import { BackendManager } from "./fs/backend-manager";
import { SyncService, SyncStatus } from "./sync/service";
import { ConflictModal } from "./ui/conflict-modal";
import { ConflictSummaryModal, summaryChoiceToStrategy } from "./ui/conflict-summary-modal";
import { Logger, getDeviceName } from "./logging/logger";
import type { LoggerAdapter } from "./logging/logger";

const DEBOUNCE_MS = 5000;

export default class SmartSyncPlugin extends Plugin {
	settings!: SmartSyncSettings;
	private localFs: LocalFs | null = null;
	backendManager!: BackendManager;
	private statusBarEl: HTMLElement | null = null;
	private syncStatus: SyncStatus = "not_connected";
	private autoSyncIntervalId: number | null = null;
	private syncService!: SyncService;
	private settingTab: SmartSyncSettingTab | null = null;
	private logger!: Logger;

	async onload() {
		await this.loadSettings();

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
				await this.syncService?.clearSyncState();
			},
			notify: (message) => {
				new Notice(message);
			},
			refreshSettingsDisplay: () => {
				this.settingTab?.display();
			},
		});

		this.syncService = new SyncService({
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
			resolveConflict: async (decision) => {
				const modal = new ConflictModal(this.app, decision);
				return modal.waitForResolution();
			},
			resolveConflictBatch: async (conflicts) => {
				const modal = new ConflictSummaryModal(this.app, conflicts);
				const choice = await modal.waitForChoice();
				return summaryChoiceToStrategy(choice);
			},
			logger: this.logger,
			loggerAdapter: this.app.vault.adapter as unknown as LoggerAdapter,
		});

		this.settingTab = new SmartSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Handle OAuth callback via obsidian://smart-sync-auth?code=xxx&state=yyy
		this.registerObsidianProtocolHandler("smart-sync-auth", (params) => {
			if (!params.code) {
				new Notice("Authorization failed: no code received");
				return;
			}
			// Synthetic URL to pass code/state to completeAuth(), which expects a callback URL string
			const url = `https://callback?code=${encodeURIComponent(params.code)}${params.state ? `&state=${encodeURIComponent(params.state)}` : ""}`;
			void this.backendManager.completeBackendConnect(url);
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

		// Event-driven sync with debounce
		const debouncedSync = debounce(
			() => {
				void this.runSync();
			},
			DEBOUNCE_MS,
			false
		);

		const onVaultChange = (file: TAbstractFile) => {
			if (this.syncService.shouldSync() && !this.syncService.isExcluded(file.path)) {
				debouncedSync();
			}
		};
		this.registerEvent(this.app.vault.on("create", onVaultChange));
		this.registerEvent(this.app.vault.on("modify", onVaultChange));
		this.registerEvent(this.app.vault.on("delete", onVaultChange));
		this.registerEvent(this.app.vault.on("rename", onVaultChange));

		// Sync on network reconnect
		const onOnline = () => {
			if (this.syncService.shouldSync()) {
				void this.runSync();
			}
		};
		window.addEventListener("online", onOnline);
		this.register(() => window.removeEventListener("online", onOnline));

		// Sync when app returns to foreground (especially important on mobile)
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible" && this.syncService.shouldSync()) {
				debouncedSync();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		this.register(() => document.removeEventListener("visibilitychange", onVisibilityChange));

		// Auto-sync timer
		this.setupAutoSync();
	}

	onunload() {
		void this.logger.flush();
		this.logger.dispose();
		this.backendManager.close();
		this.syncService.close().catch((e) => {
			console.error("Smart Sync: failed to close sync service", e);
			this.logger.error("Failed to close sync service", { message: e instanceof Error ? e.message : String(e) });
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

		// Apply platform-specific defaults for fresh installs
		if (this.settings.ignorePatterns.length === 0) {
			this.settings.ignorePatterns = Platform.isMobile
				? [...DEFAULT_MOBILE_IGNORE_PATTERNS]
				: [...DEFAULT_DESKTOP_IGNORE_PATTERNS];
			if (this.settings.ignorePatterns.length > 0) {
				needsSave = true;
			}
		}

		if (needsSave) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Set up or restart the auto-sync interval */
	setupAutoSync(): void {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}

		const minutes = this.settings.autoSyncIntervalMinutes;
		if (minutes > 0) {
			this.autoSyncIntervalId = this.registerInterval(
				window.setInterval(() => {
					if (this.syncService.shouldSync()) {
						void this.runSync();
					}
				}, minutes * 60 * 1000)
			);
		}
	}

	async runSync(): Promise<void> {
		if (!this.localFs || !this.backendManager.getRemoteFs()) {
			await this.backendManager.initBackend();
			if (!this.localFs || !this.backendManager.getRemoteFs()) {
				this.syncStatus = "not_connected";
				this.updateStatusBar();
				new Notice("Not connected to a remote backend");
				return;
			}
		}
		await this.syncService.runSync();
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
