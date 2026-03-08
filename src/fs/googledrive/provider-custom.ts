import type { App } from "obsidian";
import { Notice } from "obsidian";
import { getBackendData } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { SmartSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../../sync/remote-vault";
import { GoogleAuthDirect } from "./auth";
import type { IGoogleAuth } from "./auth";
import { GoogleDriveAuthProviderBase, GoogleDriveProviderBase } from "./provider-base";
import type { GoogleDriveBackendData } from "./provider";
import { clearTokens } from "../token-store";

/** Backend data for custom OAuth — extends the standard Google Drive data with secret references */
export interface GoogleDriveCustomBackendData extends GoogleDriveBackendData {
	/** SecretStorage secret name for the OAuth client ID */
	customClientId: string;
	/** SecretStorage secret name for the OAuth client secret */
	customClientSecret: string;
	customScope: string;
	customRedirectUri: string;
}

const DEFAULT_GDRIVE_CUSTOM_DATA: GoogleDriveCustomBackendData = {
	remoteVaultFolderId: "",
	lastKnownVaultName: "",
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
	readonly backendType = "googledrive-custom";

	constructor(secretStore: ISecretStore) {
		super(secretStore);
	}

	protected createAuth(backendData: Record<string, unknown>): IGoogleAuth | null {
		const data = backendData as Partial<GoogleDriveCustomBackendData>;
		const clientId = this.resolveSecret(data.customClientId ?? "");
		const clientSecret = this.resolveSecret(data.customClientSecret ?? "");
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
			const clientId = this.resolveSecret(data.customClientId);
			const clientSecret = this.resolveSecret(data.customClientSecret);
			if (clientId && clientSecret) {
				this.googleAuth = new GoogleAuthDirect(
					clientId, clientSecret, undefined,
					data.customScope || undefined, data.customRedirectUri || undefined,
				);
			}
		}
		if (!this.googleAuth) {
			return null;
		}
		return this.googleAuth;
	}

	getOrCreateGoogleAuth(data: GoogleDriveBackendData, logger?: Logger): IGoogleAuth {
		const customData = data as unknown as GoogleDriveCustomBackendData;
		if (!this.googleAuth) {
			const clientId = this.resolveSecret(customData.customClientId);
			const clientSecret = this.resolveSecret(customData.customClientSecret);
			this.googleAuth = new GoogleAuthDirect(
				clientId,
				clientSecret,
				logger,
				customData.customScope || undefined,
				customData.customRedirectUri || undefined,
			);
		}
		return this.googleAuth;
	}

	/** Resolve a secret name to its actual value via ISecretStore */
	private resolveSecret(secretName: string): string {
		if (!secretName) return "";
		return this.secretStore.getSecret(secretName) ?? "";
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

	constructor(secretStore: ISecretStore) {
		super(secretStore);
		this.auth = new GoogleDriveCustomAuthProvider(secretStore);
	}

	async resolveRemoteVault(
		app: App,
		settings: SmartSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) {
			throw new Error("Remote vault folder id is required for custom OAuth. Set it in the plugin settings.");
		}
		return super.resolveRemoteVault(app, settings, vaultName, logger);
	}

	async disconnect(settings: SmartSyncSettings): Promise<Record<string, unknown>> {
		await this.auth.revokeAuth();
		clearTokens(this.secretStore, this.type);
		const data = getGDriveCustomData(settings);
		return {
			...DEFAULT_GDRIVE_CUSTOM_DATA,
			customClientId: data.customClientId,
			customClientSecret: data.customClientSecret,
			customScope: data.customScope,
			customRedirectUri: data.customRedirectUri,
			remoteVaultFolderId: data.remoteVaultFolderId,
		};
	}

	protected getData(settings: SmartSyncSettings): GoogleDriveBackendData {
		return getGDriveCustomData(settings);
	}

	protected getDefaultData(): GoogleDriveBackendData {
		return DEFAULT_GDRIVE_CUSTOM_DATA;
	}
}
