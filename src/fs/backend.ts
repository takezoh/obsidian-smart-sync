import type { App } from "obsidian";
import type { IFileSystem } from "./interface";
import type { SmartSyncSettings } from "../settings";

/** Actions that providers can invoke for connection flow UI */
export interface BackendConnectionActions {
	startConnect(): Promise<void>;
	completeConnect(code: string): Promise<void>;
	disconnect(): Promise<void>;
	refreshDisplay(): void;
}

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

	/**
	 * Create an IFileSystem from current settings.
	 * Returns null if the backend is not fully configured.
	 */
	createFs(app: App, settings: SmartSyncSettings): IFileSystem | null;

	/** Whether credentials are present and the backend is ready to sync */
	isConnected(settings: SmartSyncSettings): boolean;

	/**
	 * Kick off the auth/connection flow (e.g. open OAuth URL in browser).
	 * May return settings fields to merge back (e.g. pending PKCE state).
	 */
	startConnect(app: App, settings: SmartSyncSettings): Promise<Partial<SmartSyncSettings>>;

	/**
	 * Complete the auth flow (e.g. exchange an authorization code for tokens).
	 * Returns the settings fields to merge back.
	 */
	completeConnect(
		code: string,
		settings: SmartSyncSettings
	): Promise<Partial<SmartSyncSettings>>;

	/**
	 * Disconnect: clear credentials.
	 * Returns the settings fields to merge back.
	 */
	disconnect(settings: SmartSyncSettings): Promise<Partial<SmartSyncSettings>>;

	/**
	 * Render backend-specific settings UI into the given container.
	 * Includes configuration fields and the connection flow (auth, status).
	 */
	renderSettings(
		containerEl: HTMLElement,
		settings: SmartSyncSettings,
		onSave: (updates: Partial<SmartSyncSettings>) => Promise<void>,
		actions: BackendConnectionActions
	): void;

	/**
	 * Read updated internal state from the FS to persist in settings.
	 * Called after each sync cycle so backends can save tokens, cursors, etc.
	 */
	readFsState?(fs: IFileSystem): Partial<SmartSyncSettings>;
}
