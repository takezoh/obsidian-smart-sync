import { debounce, Notice, Platform, Plugin, TAbstractFile } from "obsidian";
import { DEFAULT_SETTINGS, SmartSyncSettings } from "./settings";
import { SmartSyncSettingTab } from "./ui/settings";
import type { IFileSystem } from "./fs/interface";
import type { IBackendProvider } from "./fs/backend";
import { LocalFs } from "./fs/local/index";
import { getBackendProvider } from "./fs/registry";
import { SyncService, SyncStatus } from "./sync/service";
import { ConflictModal } from "./ui/conflict-modal";
import { ConflictSummaryModal, summaryChoiceToStrategy } from "./ui/conflict-summary-modal";

const DEBOUNCE_MS = 5000;

export default class SmartSyncPlugin extends Plugin {
	settings!: SmartSyncSettings;
	private localFs: IFileSystem | null = null;
	private remoteFs: IFileSystem | null = null;
	private backendProvider: IBackendProvider | null = null;
	private statusBarEl: HTMLElement | null = null;
	private syncStatus: SyncStatus = "not_connected";
	private autoSyncIntervalId: number | null = null;
	private syncService!: SyncService;

	async onload() {
		await this.loadSettings();

		this.localFs = new LocalFs(this.app);

		this.syncService = new SyncService({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			localFs: () => this.localFs,
			remoteFs: () => this.remoteFs,
			backendProvider: () => this.backendProvider,
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
		});

		this.addSettingTab(new SmartSyncSettingTab(this.app, this));

		// Initialize backend if configured
		this.initBackend();

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

		// Auto-sync timer
		this.setupAutoSync();
	}

	onunload() {
		void this.syncService.close();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<SmartSyncSettings>
		);

		let needsSave = false;

		// Generate a stable vault ID on first load
		if (!this.settings.vaultId) {
			this.settings.vaultId = crypto.randomUUID();
			needsSave = true;
		}

		// Ensure the vault config directory is always excluded
		const configDir = this.app.vault.configDir;
		const configPattern = `${configDir}/**`;
		if (!this.settings.excludePatterns.includes(configPattern)) {
			this.settings.excludePatterns.unshift(configPattern);
			needsSave = true;
		}

		if (needsSave) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings() {
		const configDir = this.app.vault.configDir;
		const configPattern = `${configDir}/**`;
		if (!this.settings.excludePatterns.includes(configPattern)) {
			this.settings.excludePatterns.unshift(configPattern);
		}
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

	/** Resolve the backend provider and create the remote IFileSystem */
	initBackend(): void {
		const provider = getBackendProvider(this.settings.backendType);
		if (!provider) return;

		this.backendProvider = provider;

		try {
			if (provider.isConnected(this.settings)) {
				this.remoteFs = provider.createFs(this.app, this.settings);
				if (this.remoteFs) {
					this.syncStatus = "idle";
					this.updateStatusBar();
				}
			}
		} catch (e) {
			console.error("Smart Sync: failed to initialize backend", e);
		}
	}

	/** Start the backend's auth/connection flow */
	async startBackendConnect(): Promise<void> {
		if (!this.backendProvider) {
			this.backendProvider =
				getBackendProvider(this.settings.backendType) ?? null;
		}
		if (!this.backendProvider) {
			new Notice("No backend configured");
			return;
		}
		try {
			const updates = await this.backendProvider.startConnect(this.app, this.settings);
			Object.assign(this.settings, updates);
			await this.saveSettings();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Connection failed: ${msg}`);
		}
	}

	/** Complete the auth flow with a code/token from the user */
	async completeBackendConnect(code: string): Promise<void> {
		if (!this.backendProvider) {
			new Notice("Start the connection flow first");
			return;
		}

		try {
			const updates = await this.backendProvider.completeConnect(
				code,
				this.settings
			);
			Object.assign(this.settings, updates);
			await this.saveSettings();

			this.remoteFs = this.backendProvider.createFs(
				this.app,
				this.settings
			);
			if (this.remoteFs) {
				this.syncStatus = "idle";
				this.updateStatusBar();
			}

			new Notice(
				`Connected to ${this.backendProvider.displayName}`
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Authorization failed: ${msg}`);
		}
	}

	/** Disconnect the current backend */
	async disconnectBackend(): Promise<void> {
		if (!this.backendProvider) return;

		const updates = await this.backendProvider.disconnect(this.settings);
		Object.assign(this.settings, updates);
		await this.saveSettings();

		this.remoteFs = null;
		this.syncStatus = "not_connected";
		this.updateStatusBar();
	}

	async runSync(): Promise<void> {
		if (!this.remoteFs) {
			this.initBackend();
			if (!this.remoteFs) {
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
