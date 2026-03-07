import type { App } from "obsidian";
import { Notice, Platform } from "obsidian";
import type { IBackendProvider } from "../backend";
import { getBackendData } from "../backend";
import type { IAuthProvider } from "../auth";
import type { IFileSystem } from "../interface";
import type { SmartSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../../sync/remote-vault";
import { GoogleAuth } from "./auth";
import { DriveClient } from "./client";
import { GoogleDriveFs } from "./index";
import { MetadataStore } from "../../store/metadata-store";
import { resolveGDriveRemoteVault } from "./remote-vault";
import type { DriveFile } from "./types";

/** All data stored in backendData["googledrive"] */
export interface GoogleDriveBackendData {
	remoteVaultFolderId: string;
	lastKnownVaultName: string;
	refreshToken: string;
	accessToken: string;
	accessTokenExpiry: number;
	changesStartPageToken: string;
	pendingAuthState: string;
}

const DEFAULT_GDRIVE_DATA: GoogleDriveBackendData = {
	remoteVaultFolderId: "",
	lastKnownVaultName: "",
	refreshToken: "",
	accessToken: "",
	accessTokenExpiry: 0,
	changesStartPageToken: "",
	pendingAuthState: "",
};

/** Type-safe accessor for Google Drive backend data */
function getGDriveData(settings: SmartSyncSettings): GoogleDriveBackendData {
	return {
		...DEFAULT_GDRIVE_DATA,
		...getBackendData<GoogleDriveBackendData>(settings, "googledrive"),
	};
}

/**
 * Google Drive authentication provider.
 * Owns the GoogleAuth instance and manages the OAuth lifecycle.
 */
export class GoogleDriveAuthProvider implements IAuthProvider {
	private googleAuth: GoogleAuth | null = null;

	isAuthenticated(backendData: Record<string, unknown>): boolean {
		return !!(backendData as Partial<GoogleDriveBackendData>).refreshToken;
	}

	async startAuth(): Promise<Record<string, unknown>> {
		try {
			this.googleAuth = new GoogleAuth();

			const url = this.googleAuth.getAuthorizationUrl();

			// Persist CSRF state so it survives plugin reload
			const pendingAuthState = this.googleAuth.getAuthState() ?? "";

			if (Platform.isMobile) {
				// window.open() is blocked in iOS WKWebView;
				// assigning location.href lets Obsidian open the system browser.
				window.location.href = url;
			} else {
				window.open(url);
			}
			new Notice(
				"Complete authorization in your browser"
			);

			return { pendingAuthState };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to start authorization: ${msg}`);
			return {};
		}
	}

	async completeAuth(
		input: string,
		backendData: Record<string, unknown>
	): Promise<Record<string, unknown>> {
		const data = backendData as Partial<GoogleDriveBackendData>;
		if (!this.googleAuth) {
			this.googleAuth = new GoogleAuth();
		}
		// Always restore CSRF state if auth lacks it (survives plugin reload)
		if (!this.googleAuth.getAuthState() && data.pendingAuthState) {
			this.googleAuth.setAuthState(data.pendingAuthState);
		}

		// Parse tokens from the auth server callback URL
		const params = parseAuthCallbackParams(input);
		this.googleAuth.handleAuthCallback(params);
		const tokens = this.googleAuth.getTokenState();
		return {
			refreshToken: tokens.refreshToken,
			accessToken: tokens.accessToken,
			accessTokenExpiry: tokens.accessTokenExpiry,
			pendingAuthState: "",
		};
	}

	/** Return the current in-memory token state (for persistence after refresh). */
	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } | null {
		return this.googleAuth?.getTokenState() ?? null;
	}

	/**
	 * Get or create a GoogleAuth instance for FS creation.
	 * Re-creates if the stored refreshToken has changed.
	 */
	getOrCreateGoogleAuth(data: GoogleDriveBackendData, logger?: Logger): GoogleAuth {
		if (
			!this.googleAuth ||
			this.googleAuth.getTokenState().refreshToken !== data.refreshToken
		) {
			this.googleAuth = new GoogleAuth(logger);
		}
		return this.googleAuth;
	}

	/** Revoke the current token (called by provider.disconnect) */
	async revokeAuth(): Promise<void> {
		if (this.googleAuth) {
			await this.googleAuth.revokeToken();
		}
		this.googleAuth = null;
	}
}

/**
 * Google Drive backend provider.
 * Encapsulates Google Drive-specific logic: FS creation and state management.
 * Authentication is delegated to GoogleDriveAuthProvider.
 * Settings UI is handled by GoogleDriveSettingsRenderer in src/ui/.
 */
export class GoogleDriveProvider implements IBackendProvider {
	readonly type = "googledrive";
	readonly displayName = "Google Drive";
	readonly auth: GoogleDriveAuthProvider;

	constructor() {
		this.auth = new GoogleDriveAuthProvider();
	}

	createFs(_app: App, settings: SmartSyncSettings, logger?: Logger): IFileSystem | null {
		const data = getGDriveData(settings);
		if (!data.refreshToken || !data.remoteVaultFolderId) return null;

		const googleAuth = this.auth.getOrCreateGoogleAuth(data, logger);
		googleAuth.setTokens(
			data.refreshToken,
			data.accessToken,
			data.accessTokenExpiry
		);
		const client = new DriveClient(googleAuth, logger);
		const metadataStore = new MetadataStore<DriveFile>(data.remoteVaultFolderId, {
			dbNamePrefix: "smart-sync-drive",
			version: 1,
		});
		const fs = new GoogleDriveFs(client, data.remoteVaultFolderId, logger, metadataStore);

		// Restore the changes page token for incremental sync
		if (data.changesStartPageToken) {
			fs.changesPageToken = data.changesStartPageToken;
		}

		return fs;
	}

	isConnected(settings: SmartSyncSettings): boolean {
		const data = getGDriveData(settings);
		return !!data.refreshToken;
	}

	getIdentity(settings: SmartSyncSettings): string | null {
		const data = getGDriveData(settings);
		if (!data.remoteVaultFolderId) return null;
		return `googledrive:${data.remoteVaultFolderId}`;
	}

	resetTargetState(settings: SmartSyncSettings): void {
		const data = settings.backendData[this.type];
		if (data) {
			delete data.changesStartPageToken;
		}
	}

	readBackendState(fs: IFileSystem): Record<string, unknown> {
		if (!(fs instanceof GoogleDriveFs)) return {};
		const result: Record<string, unknown> = {};

		const pageToken = fs.changesPageToken;
		if (pageToken) result.changesStartPageToken = pageToken;

		// Persist refreshed tokens so they survive plugin/app restarts
		const tokens = this.auth.getTokenState();
		if (tokens && tokens.refreshToken) {
			result.refreshToken = tokens.refreshToken;
			result.accessToken = tokens.accessToken;
			result.accessTokenExpiry = tokens.accessTokenExpiry;
		}

		return result;
	}

	async resolveRemoteVault(
		_app: App,
		settings: SmartSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = getGDriveData(settings);
		const googleAuth = this.auth.getOrCreateGoogleAuth(data, logger);
		googleAuth.setTokens(data.refreshToken, data.accessToken, data.accessTokenExpiry);
		const client = new DriveClient(googleAuth, logger);
		const cachedFolderId = data.remoteVaultFolderId || undefined;
		return resolveGDriveRemoteVault(client, vaultName, cachedFolderId, logger);
	}

	async disconnect(_settings: SmartSyncSettings): Promise<Record<string, unknown>> {
		await this.auth.revokeAuth();
		return { ...DEFAULT_GDRIVE_DATA };
	}
}

/** Auth callback parameters returned by the auth server */
interface AuthCallbackParams {
	access_token: string;
	refresh_token?: string;
	expires_in: string;
	state?: string;
}

/**
 * Parse auth callback input (URL from auth server containing tokens).
 * The auth server redirects to obsidian://smart-sync-auth?access_token=...&refresh_token=...&expires_in=...&state=...
 */
function parseAuthCallbackParams(input: string): AuthCallbackParams {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Auth callback is empty");
	}

	try {
		const url = new URL(trimmed);
		const accessToken = url.searchParams.get("access_token");
		if (!accessToken) {
			throw new Error("Missing access_token in auth callback");
		}
		return {
			access_token: accessToken,
			refresh_token: url.searchParams.get("refresh_token") ?? undefined,
			expires_in: url.searchParams.get("expires_in") ?? "3600",
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch (e) {
		if (e instanceof Error && e.message.includes("access_token")) {
			throw e;
		}
		throw new Error("Invalid auth callback URL");
	}
}
