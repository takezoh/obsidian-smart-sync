import type { App } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "./interface";
import type { IBackendProvider } from "./backend";
import type { Logger } from "../logging/logger";
import { getBackendProvider } from "./registry";
import { AuthError } from "./errors";

export interface BackendManagerDeps {
	getSettings: () => AirSyncSettings;
	saveSettings: () => Promise<void>;
	getApp: () => App;
	getLogger: () => Logger;
	getVaultName: () => string;
	onConnected: (remoteFs: IFileSystem) => void;
	onDisconnected: () => void;
	onIdentityChanged: () => Promise<void>;
	notify: (message: string) => void;
	refreshSettingsDisplay: () => void;
}

export class BackendManager {
	private remoteFs: IFileSystem | null = null;
	private backendProvider: IBackendProvider | null = null;
	private lastBackendIdentity: string | null = null;
	private connecting = false;

	constructor(private deps: BackendManagerDeps) {}

	isConnecting(): boolean {
		return this.connecting;
	}

	getRemoteFs(): IFileSystem | null {
		return this.remoteFs;
	}

	getBackendProvider(): IBackendProvider | null {
		return this.backendProvider;
	}

	/** Resolve the backend provider and create the remote IFileSystem */
	async initBackend(): Promise<void> {
		if (this.connecting) return;

		const settings = this.deps.getSettings();
		const provider = getBackendProvider(settings.backendType);
		if (!provider) return;

		this.connecting = true;
		this.backendProvider = provider;

		try {
			const newIdentity = provider.getIdentity(settings);
			if (this.lastBackendIdentity !== null && newIdentity !== this.lastBackendIdentity) {
				this.deps.getLogger().info("Backend identity changed", {
					from: this.lastBackendIdentity,
					to: newIdentity,
				});
				provider.resetTargetState?.(settings);
				await this.deps.onIdentityChanged();
			}
			this.lastBackendIdentity = newIdentity;

			this.remoteFs?.close?.()?.catch((e: unknown) => {
				this.deps.getLogger().warn("Failed to close previous backend", { error: e instanceof Error ? e.message : String(e) });
			});
			if (!provider.isConnected(settings)) {
				this.remoteFs = null;
				this.deps.onDisconnected();
				const data = settings.backendData[provider.type] as Record<string, unknown> | undefined;
				if (data?.remoteVaultFolderId) {
					this.deps.notify("Authentication expired. Please reconnect in settings.");
				}
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
			const msg = e instanceof Error ? e.message : String(e);
			this.deps.getLogger().error("Failed to initialize backend", { message: msg });
			if (e instanceof AuthError) {
				this.deps.notify("Authentication expired. Please reconnect in settings.");
			}
		} finally {
			this.connecting = false;
		}
	}

	private async resolveRemoteVault(
		provider: IBackendProvider,
		settings: AirSyncSettings,
	): Promise<void> {
		const vaultName = this.deps.getVaultName();
		const type = provider.type;
		const backendData = settings.backendData[type] as Record<string, unknown> | undefined;
		const cachedFolderId = backendData?.remoteVaultFolderId as string | undefined;
		const lastKnownName = backendData?.lastKnownVaultName as string | undefined;

		// Skip network call if already linked and name unchanged
		if (cachedFolderId && lastKnownName === vaultName) {
			return;
		}

		const result = await provider.resolveRemoteVault!(
			this.deps.getApp(), settings, vaultName, this.deps.getLogger()
		);
		settings.backendData[type] = { ...(settings.backendData[type] ?? {}), ...result.backendUpdates };
		await this.deps.saveSettings();
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
			const current = settings.backendData[type] ?? {};
			const updates = await this.backendProvider.auth.startAuth(current);
			settings.backendData[type] = { ...current, ...updates };
			await this.deps.saveSettings();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.getLogger().error("Failed to start backend connection", { message: msg });
			this.deps.notify(`Connection failed: ${msg}`);
		}
	}

	/** Complete the auth flow with a code/token from the user */
	async completeBackendConnect(code: string): Promise<void> {
		if (this.connecting) return;
		if (!this.backendProvider) {
			this.deps.notify("Start the connection flow first");
			return;
		}

		const settings = this.deps.getSettings();
		this.connecting = true;

		try {
			const type = this.backendProvider.type;
			const backendData = settings.backendData[type] ?? {};
			const updates = await this.backendProvider.auth.completeAuth(
				code,
				backendData,
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
			this.deps.getLogger().error("Authorization failed", { message: msg });
			this.deps.notify(`Authorization failed: ${msg}`);
		} finally {
			this.connecting = false;
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

		await this.deps.onIdentityChanged();
		this.lastBackendIdentity = null;

		this.remoteFs = null;
		this.deps.onDisconnected();

		this.deps.refreshSettingsDisplay();
	}

	/** Release resources */
	close(): void {
		this.remoteFs?.close?.()?.catch((e: unknown) => {
			this.deps.getLogger().warn("Failed to close backend on unload", { error: e instanceof Error ? e.message : String(e) });
		});
	}
}
