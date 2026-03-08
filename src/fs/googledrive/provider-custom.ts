import type { App } from "obsidian";
import { Notice } from "obsidian";
import { getBackendData } from "../backend";
import type { SmartSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../../sync/remote-vault";
import { GoogleAuthDirect } from "./auth";
import type { IGoogleAuth } from "./auth";
import { GoogleDriveAuthProviderBase, GoogleDriveProviderBase } from "./provider-base";
import type { GoogleDriveBackendData } from "./provider";

/** Backend data for custom OAuth — extends the standard Google Drive data with user credentials */
export interface GoogleDriveCustomBackendData extends GoogleDriveBackendData {
	customClientId: string;
	customClientSecret: string;
	customScope: string;
	customRedirectUri: string;
}

const DEFAULT_GDRIVE_CUSTOM_DATA: GoogleDriveCustomBackendData = {
	remoteVaultFolderId: "",
	lastKnownVaultName: "",
	refreshToken: "",
	accessToken: "",
	accessTokenExpiry: 0,
	changesStartPageToken: "",
	pendingAuthState: "",
	customClientId: "",
	customClientSecret: "",
	customScope: "",
	customRedirectUri: "",
};

function getGDriveCustomData(settings: SmartSyncSettings): GoogleDriveCustomBackendData {
	return {
		...DEFAULT_GDRIVE_CUSTOM_DATA,
		...getBackendData<GoogleDriveCustomBackendData>(settings, "googledrive-custom"),
	};
}

/**
 * Auth provider for custom OAuth — uses GoogleAuthDirect to exchange codes
 * and refresh tokens directly with Google using user-provided credentials.
 */
export class GoogleDriveCustomAuthProvider extends GoogleDriveAuthProviderBase {
	protected createAuth(backendData: Record<string, unknown>): IGoogleAuth | null {
		const data = backendData as Partial<GoogleDriveCustomBackendData>;
		const clientId = data.customClientId;
		const clientSecret = data.customClientSecret;
		if (!clientId || !clientSecret) {
			new Notice("Enter your client ID and client secret first");
			return null;
		}
		this.googleAuth = new GoogleAuthDirect(
			clientId, clientSecret, undefined,
			data.customScope || undefined, data.customRedirectUri || undefined,
		);
		return this.googleAuth;
	}

	protected createAuthIfNeeded(backendData: Record<string, unknown>): IGoogleAuth | null {
		const data = backendData as Partial<GoogleDriveCustomBackendData>;
		if (!this.googleAuth && data.customClientId && data.customClientSecret) {
			this.googleAuth = new GoogleAuthDirect(
				data.customClientId, data.customClientSecret, undefined,
				data.customScope || undefined, data.customRedirectUri || undefined,
			);
		}
		if (!this.googleAuth) {
			return null;
		}
		return this.googleAuth;
	}

	getOrCreateGoogleAuth(data: GoogleDriveBackendData, logger?: Logger): IGoogleAuth {
		const customData = data as unknown as GoogleDriveCustomBackendData;
		if (
			!this.googleAuth ||
			this.googleAuth.getTokenState().refreshToken !== data.refreshToken
		) {
			this.googleAuth = new GoogleAuthDirect(
				customData.customClientId,
				customData.customClientSecret,
				logger,
				customData.customScope || undefined,
				customData.customRedirectUri || undefined,
			);
		}
		return this.googleAuth;
	}
}

/**
 * Custom OAuth Google Drive provider.
 * Uses GoogleAuthDirect for direct token exchange with user-provided credentials.
 */
export class GoogleDriveCustomProvider extends GoogleDriveProviderBase {
	readonly type = "googledrive-custom";
	readonly displayName = "Google Drive (custom OAuth)";
	readonly auth: GoogleDriveCustomAuthProvider;

	constructor() {
		super();
		this.auth = new GoogleDriveCustomAuthProvider();
	}

	async resolveRemoteVault(
		_app: App,
		settings: SmartSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) {
			throw new Error("Remote vault folder id is required for custom OAuth. Set it in the plugin settings.");
		}
		return super.resolveRemoteVault(_app, settings, vaultName, logger);
	}

	async disconnect(settings: SmartSyncSettings): Promise<Record<string, unknown>> {
		await this.auth.revokeAuth();
		const data = getGDriveCustomData(settings);
		return {
			...DEFAULT_GDRIVE_CUSTOM_DATA,
			customClientId: data.customClientId,
			customClientSecret: data.customClientSecret,
			customScope: data.customScope,
			customRedirectUri: data.customRedirectUri,
		};
	}

	protected getData(settings: SmartSyncSettings): GoogleDriveBackendData {
		return getGDriveCustomData(settings);
	}

	protected getDefaultData(): GoogleDriveBackendData {
		return DEFAULT_GDRIVE_CUSTOM_DATA;
	}
}
