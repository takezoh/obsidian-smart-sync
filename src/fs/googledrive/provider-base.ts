import type { App } from "obsidian";
import { Notice, Platform } from "obsidian";
import type { IBackendProvider } from "../backend";
import type { IAuthProvider } from "../auth";
import type { ISecretStore } from "../secret-store";
import type { IFileSystem } from "../interface";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../../sync/remote-vault";
import type { IGoogleAuth } from "./auth";
import { DriveClient } from "./client";
import { GoogleDriveFs } from "./index";
import { MetadataStore } from "../../store/metadata-store";
import { resolveGDriveRemoteVault } from "./remote-vault";
import type { DriveFile } from "./types";
import type { GoogleDriveBackendData } from "./provider";
import { storeTokens, readTokens, hasRefreshToken, clearTokens } from "../token-store";

/**
 * Parse auth callback input (URL from auth server containing tokens or code).
 * Built-in flow: obsidian://air-sync-auth?access_token=...&refresh_token=...&expires_in=...&state=...
 * Custom flow: obsidian://air-sync-auth?code=...&state=...
 */
export function parseAuthCallbackParams(input: string): Record<string, string | undefined> {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Auth callback is empty");
	}

	try {
		const url = new URL(trimmed);
		const accessToken = url.searchParams.get("access_token");
		const code = url.searchParams.get("code");
		if (!accessToken && !code) {
			throw new Error("Missing access_token or code in auth callback");
		}
		const result: Record<string, string | undefined> = {
			state: url.searchParams.get("state") ?? undefined,
		};
		if (accessToken) {
			result.access_token = accessToken;
			result.refresh_token = url.searchParams.get("refresh_token") ?? undefined;
			result.expires_in = url.searchParams.get("expires_in") ?? "3600";
		}
		if (code) {
			result.code = code;
		}
		return result;
	} catch (e) {
		if (e instanceof Error && (e.message.includes("access_token") || e.message.includes("code"))) {
			throw e;
		}
		throw new Error("Invalid auth callback URL");
	}
}

/**
 * Base auth provider for Google Drive variants.
 * Subclasses implement `createAuth` and `createAuthIfNeeded` for their specific GoogleAuth type.
 */
export abstract class GoogleDriveAuthProviderBase implements IAuthProvider {
	protected googleAuth: IGoogleAuth | null = null;
	protected readonly secretStore: ISecretStore;

	/** The backend type used for SecretStorage key generation. Set by subclass provider. */
	abstract readonly backendType: string;

	constructor(secretStore: ISecretStore) {
		this.secretStore = secretStore;
	}

	isAuthenticated(_backendData: Record<string, unknown>): boolean {
		return hasRefreshToken(this.secretStore, this.backendType);
	}

	async startAuth(_backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		try {
			const auth = this.createAuth(_backendData);
			if (!auth) return {};

			const url = await auth.getAuthorizationUrl();
			const pendingAuthState = auth.getAuthState() ?? "";
			const pendingCodeVerifier = auth.getCodeVerifier() ?? "";

			if (Platform.isMobile) {
				window.location.href = url;
			} else {
				window.open(url);
			}
			new Notice("Complete authorization in your browser");

			return { pendingAuthState, pendingCodeVerifier };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to start authorization: ${msg}`);
		}
	}

	async completeAuth(
		input: string,
		backendData: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const data = backendData as Partial<GoogleDriveBackendData & { pendingCodeVerifier?: string }>;
		const auth = this.createAuthIfNeeded(backendData);
		if (!auth) {
			throw new Error("OAuth credentials are missing");
		}
		// Restore CSRF state and PKCE verifier if auth lacks them (survives plugin reload)
		if (!auth.getAuthState() && data.pendingAuthState) {
			auth.setAuthState(data.pendingAuthState);
		}
		if (!auth.getCodeVerifier() && data.pendingCodeVerifier) {
			auth.setCodeVerifier(data.pendingCodeVerifier);
		}

		const params = parseAuthCallbackParams(input);
		await auth.handleAuthCallback(params);
		const tokens = auth.getTokenState();

		// Store tokens in SecretStorage instead of returning them for backendData
		storeTokens(this.secretStore, this.backendType, {
			refreshToken: tokens.refreshToken,
			accessToken: tokens.accessToken,
		});

		return {
			accessTokenExpiry: tokens.accessTokenExpiry,
			pendingAuthState: "",
			pendingCodeVerifier: "",
		};
	}

	/** Return the current in-memory token state (for persistence after refresh). */
	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } | null {
		return this.googleAuth?.getTokenState() ?? null;
	}

	/** Revoke the current token (called by provider.disconnect) */
	async revokeAuth(): Promise<void> {
		if (this.googleAuth) {
			await this.googleAuth.revokeToken();
		}
		this.googleAuth = null;
	}

	/**
	 * Create a new auth instance for starting the auth flow.
	 * Returns null if preconditions are not met (e.g. missing credentials for custom).
	 */
	protected abstract createAuth(backendData: Record<string, unknown>): IGoogleAuth | null;

	/**
	 * Create an auth instance if one doesn't exist (for completeAuth).
	 * Returns null if credentials are missing.
	 */
	protected abstract createAuthIfNeeded(backendData: Record<string, unknown>): IGoogleAuth | null;

	/** Get or create a GoogleAuth instance for FS creation. */
	abstract getOrCreateGoogleAuth(data: GoogleDriveBackendData, logger: Logger | undefined): IGoogleAuth;
}

/**
 * Base provider for Google Drive variants.
 * Subclasses define `getData`, `getDefaultData`, and provide the concrete auth provider.
 */
export abstract class GoogleDriveProviderBase implements IBackendProvider {
	abstract readonly type: string;
	abstract readonly displayName: string;
	abstract readonly auth: GoogleDriveAuthProviderBase;
	protected readonly secretStore: ISecretStore;

	constructor(secretStore: ISecretStore) {
		this.secretStore = secretStore;
	}

	createFs(app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null {
		const data = this.getData(settings);
		const tokens = readTokens(this.secretStore, this.type);
		if (!tokens.refreshToken || !data.remoteVaultFolderId) return null;

		const googleAuth = this.auth.getOrCreateGoogleAuth(data, logger);
		googleAuth.setTokens(tokens.refreshToken, tokens.accessToken, data.accessTokenExpiry);
		const client = new DriveClient((force) => googleAuth.getAccessToken(force), logger);
		const metadataStore = new MetadataStore<DriveFile>(`${settings.vaultId}-${data.remoteVaultFolderId}`, {
			dbNamePrefix: "air-sync-drive",
			version: 1,
		});
		const fs = new GoogleDriveFs(client, data.remoteVaultFolderId, logger, metadataStore);

		if (data.changesStartPageToken) {
			fs.changesPageToken = data.changesStartPageToken;
		}

		return fs;
	}

	isConnected(settings: AirSyncSettings): boolean {
		return hasRefreshToken(this.secretStore, this.type) && !!this.getData(settings).remoteVaultFolderId;
	}

	getIdentity(settings: AirSyncSettings): string | null {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) return null;
		return `${this.type}:${data.remoteVaultFolderId}`;
	}

	resetTargetState(settings: AirSyncSettings): void {
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

		// Store refreshed tokens in SecretStorage (not in backendData)
		const tokens = this.auth.getTokenState();
		if (tokens && tokens.refreshToken) {
			storeTokens(this.secretStore, this.type, {
				refreshToken: tokens.refreshToken,
				accessToken: tokens.accessToken,
			});
			result.accessTokenExpiry = tokens.accessTokenExpiry;
		}

		return result;
	}

	async resolveRemoteVault(
		app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = this.getData(settings);
		const tokens = readTokens(this.secretStore, this.type);
		const googleAuth = this.auth.getOrCreateGoogleAuth(data, logger);
		googleAuth.setTokens(tokens.refreshToken, tokens.accessToken, data.accessTokenExpiry);
		const client = new DriveClient((force) => googleAuth.getAccessToken(force), logger);
		const cachedFolderId = data.remoteVaultFolderId || undefined;
		return resolveGDriveRemoteVault(client, vaultName, cachedFolderId, logger);
	}

	async disconnect(_settings: AirSyncSettings): Promise<Record<string, unknown>> {
		await this.auth.revokeAuth();
		clearTokens(this.secretStore, this.type);
		return { ...this.getDefaultData() };
	}

	protected abstract getData(settings: AirSyncSettings): GoogleDriveBackendData;
	protected abstract getDefaultData(): GoogleDriveBackendData;
}
