import type { App } from "obsidian";
import type { IFileSystem } from "./interface";
import type { IAuthProvider } from "./auth";
import type { AirSyncSettings } from "../settings";
import type { Logger } from "../logging/logger";
import type { RemoteVaultResolution } from "../sync/remote-vault";

/**
 * Abstraction for a remote storage backend.
 * Each backend (Google Drive, Dropbox, etc.) implements this interface.
 * main.ts and sync/ never import backend-specific modules directly.
 */
export interface IBackendProvider {
	/** Unique identifier (e.g. "googledrive", "dropbox") */
	readonly type: string;
	/** Human-readable name (e.g. "Google Drive") */
	readonly displayName: string;
	/** Authentication provider for this backend */
	readonly auth: IAuthProvider;

	/**
	 * Create an IFileSystem from current settings.
	 * Returns null if the backend is not fully configured.
	 */
	createFs(app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null;

	/** Whether credentials are present and the backend is ready to sync */
	isConnected(settings: AirSyncSettings): boolean;

	/** Return a string uniquely identifying the current remote target (e.g. folder ID) */
	getIdentity(settings: AirSyncSettings): string | null;

	/**
	 * Called when the backend identity changes (e.g. user switches to a different folder).
	 * The provider should reset any stale cursors/tokens in backendData that are
	 * scoped to the previous remote target.
	 */
	resetTargetState?(settings: AirSyncSettings): void;

	/**
	 * Read updated internal state from the FS to persist in settings.backendData.
	 * Called after each sync cycle so backends can save tokens, cursors, etc.
	 * Returns an opaque record — the sync layer does not inspect its contents.
	 * Tokens are stored in SecretStorage rather than returned in the record.
	 */
	readBackendState?(fs: IFileSystem): Record<string, unknown>;

	/**
	 * Discover or create the remote vault for the given vault name.
	 * Called by BackendManager after auth, before createFs().
	 * Returns backend-specific data to persist in settings.backendData.
	 */
	resolveRemoteVault?(
		app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution>;

	/**
	 * Disconnect the backend: revoke auth and reset all backend state.
	 * Returns the reset backendData to persist.
	 */
	disconnect(settings: AirSyncSettings): Promise<Record<string, unknown>>;
}

/** Type-safe helper to retrieve backend-specific data from settings */
export function getBackendData<T>(
	settings: AirSyncSettings,
	type: string
): T | undefined {
	return settings.backendData[type] as T | undefined;
}
