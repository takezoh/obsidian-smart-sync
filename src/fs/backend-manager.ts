import type { App } from "obsidian";
import type { SmartSyncSettings } from "../settings";
import type { IFileSystem } from "./interface";
import type { IBackendProvider } from "./backend";
import type { Logger } from "../logging/logger";
import { getBackendProvider } from "./registry";
import { RemoteVaultStore } from "../sync/remote-vault";

export interface BackendManagerDeps {
	getSettings: () => SmartSyncSettings;
	saveSettings: () => Promise<void>;
	getApp: () => App;
	getLogger: () => Logger;
	getVaultName: () => string;
	onConnected: (remoteFs: IFileSystem) => void;
	onDisconnected: () => void;
	notify: (message: string) => void;
	refreshSettingsDisplay: () => void;
}

export class BackendManager {
	private remoteFs: IFileSystem | null = null;
	private backendProvider: IBackendProvider | null = null;
	private remoteVaultStore: RemoteVaultStore | null = null;

	constructor(private deps: BackendManagerDeps) {}

	getRemoteFs(): IFileSystem | null {
		return this.remoteFs;
	}

	getBackendProvider(): IBackendProvider | null {
		return this.backendProvider;
	}

	/** Resolve the backend provider and create the remote IFileSystem */
	async initBackend(): Promise<void> {
		const settings = this.deps.getSettings();
		const provider = getBackendProvider(settings.backendType);
		if (!provider) return;

		this.backendProvider = provider;

		try {
			this.remoteFs?.close?.()?.catch((e: unknown) => {
				console.warn("Smart Sync: failed to close previous backend", e);
			});
			if (!provider.isConnected(settings)) {
				this.remoteFs = null;
				this.deps.onDisconnected();
				return;
			}

			// Remote vault resolution
			if (provider.resolveRemoteVault) {
				await this.resolveRemoteVault(provider, settings);
			}

			this.remoteFs = provider.createFs(this.deps.getApp(), settings, this.deps.getLogger());
			if (this.remoteFs) {
				this.deps.onConnected(this.remoteFs);
				this.deps.getLogger().info("Backend initialized", { backend: settings.backendType });
			}
		} catch (e) {
			console.error("Smart Sync: failed to initialize backend", e);
			this.deps.getLogger().error("Failed to initialize backend", { message: e instanceof Error ? e.message : String(e) });
		}
	}

	private async resolveRemoteVault(
		provider: IBackendProvider,
		settings: SmartSyncSettings,
	): Promise<void> {
		const vaultName = this.deps.getVaultName();
		this.remoteVaultStore ??= new RemoteVaultStore(settings.vaultId);
		const cachedId = await this.remoteVaultStore.getRemoteVaultId();
		const lastKnownName = await this.remoteVaultStore.getLastKnownVaultName();

		// Skip if already linked and name unchanged
		if (cachedId && lastKnownName === vaultName) return;

		const result = await provider.resolveRemoteVault!(
			this.deps.getApp(), settings, vaultName, cachedId, this.deps.getLogger()
		);
		const type = provider.type;
		settings.backendData[type] = { ...(settings.backendData[type] ?? {}), ...result.backendUpdates };
		await this.deps.saveSettings();
		await this.remoteVaultStore.save(result.remoteVaultId, vaultName);
	}

	/** Start the backend's auth/connection flow */
	async startBackendConnect(): Promise<void> {
		const settings = this.deps.getSettings();
		if (!this.backendProvider) {
			this.backendProvider =
				getBackendProvider(settings.backendType) ?? null;
		}
		if (!this.backendProvider) {
			this.deps.notify("No backend configured");
			return;
		}
		try {
			const type = this.backendProvider.type;
			const updates = await this.backendProvider.auth.startAuth();
			const current = settings.backendData[type] ?? {};
			settings.backendData[type] = { ...current, ...updates };
			await this.deps.saveSettings();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.notify(`Connection failed: ${msg}`);
		}
	}

	/** Complete the auth flow with a code/token from the user */
	async completeBackendConnect(code: string): Promise<void> {
		if (!this.backendProvider) {
			this.deps.notify("Start the connection flow first");
			return;
		}

		const settings = this.deps.getSettings();
		try {
			const type = this.backendProvider.type;
			const backendData = settings.backendData[type] ?? {};
			const updates = await this.backendProvider.auth.completeAuth(
				code,
				backendData
			);
			settings.backendData[type] = { ...backendData, ...updates };
			await this.deps.saveSettings();

			// Resolve remote vault before creating FS
			if (this.backendProvider.resolveRemoteVault) {
				await this.resolveRemoteVault(this.backendProvider, settings);
			}

			this.remoteFs = this.backendProvider.createFs(
				this.deps.getApp(),
				settings,
				this.deps.getLogger()
			);
			if (this.remoteFs) {
				this.deps.onConnected(this.remoteFs);
			}

			this.deps.notify(
				`Connected to ${this.backendProvider.displayName}`
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.notify(`Authorization failed: ${msg}`);
		}

		this.deps.refreshSettingsDisplay();
	}

	/** Disconnect the current backend */
	async disconnectBackend(): Promise<void> {
		if (!this.backendProvider) return;

		const settings = this.deps.getSettings();
		const type = this.backendProvider.type;
		const resetData = await this.backendProvider.disconnect(settings);
		settings.backendData[type] = resetData;
		await this.deps.saveSettings();

		this.remoteFs = null;
		this.deps.onDisconnected();

		this.deps.refreshSettingsDisplay();
	}

	/** Release resources */
	close(): void {
		this.remoteFs?.close?.()?.catch((e: unknown) => {
			console.warn("Smart Sync: failed to close backend on unload", e);
		});
		this.remoteVaultStore?.close().catch((e: unknown) => {
			console.warn("Smart Sync: failed to close remote vault store", e);
		});
	}
}
