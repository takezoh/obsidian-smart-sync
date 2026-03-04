import type { App } from "obsidian";
import type { IFileSystem } from "./interface";
import type { IAuthProvider } from "./auth";
import type { SmartSyncSettings } from "../settings";

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
	createFs(app: App, settings: SmartSyncSettings): IFileSystem | null;

	/** Whether credentials are present and the backend is ready to sync */
	isConnected(settings: SmartSyncSettings): boolean;

	/**
	 * Read updated internal state from the FS to persist in settings.
	 * Called after each sync cycle so backends can save tokens, cursors, etc.
	 */
	readFsState?(fs: IFileSystem): Partial<SmartSyncSettings>;
}
