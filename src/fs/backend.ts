import type { App } from "obsidian";
import type { IFileSystem } from "./interface";
import type { IAuthProvider } from "./auth";
import type { SmartSyncSettings } from "../settings";
import type { Logger } from "../logging/logger";

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
	createFs(app: App, settings: SmartSyncSettings, logger?: Logger): IFileSystem | null;

	/** Whether credentials are present and the backend is ready to sync */
	isConnected(settings: SmartSyncSettings): boolean;

	/**
	 * Read updated internal state from the FS to persist in settings.backendData.
	 * Called after each sync cycle so backends can save tokens, cursors, etc.
	 * Returns an opaque record — the sync layer does not inspect its contents.
	 */
	readBackendState?(fs: IFileSystem): Record<string, unknown>;

	/**
	 * Disconnect the backend: revoke auth and reset all backend state.
	 * Returns the reset backendData to persist.
	 */
	disconnect(settings: SmartSyncSettings): Promise<Record<string, unknown>>;
}

/** Type-safe helper to retrieve backend-specific data from settings */
export function getBackendData<T>(
	settings: SmartSyncSettings,
	type: string
): T | undefined {
	return settings.backendData[type] as T | undefined;
}
