import { getBackendData } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import { GoogleAuth } from "./auth";
import type { IGoogleAuth } from "./auth";
import { GoogleDriveAuthProviderBase, GoogleDriveProviderBase } from "./provider-base";

/** All data stored in backendData["googledrive"] (tokens live in SecretStorage) */
export interface GoogleDriveBackendData {
	remoteVaultFolderId: string;
	lastKnownVaultName: string;
	accessTokenExpiry: number;
	changesStartPageToken: string;
	pendingAuthState: string;
}

const DEFAULT_GDRIVE_DATA: GoogleDriveBackendData = {
	remoteVaultFolderId: "",
	lastKnownVaultName: "",
	accessTokenExpiry: 0,
	changesStartPageToken: "",
	pendingAuthState: "",
};

/** Type-safe accessor for Google Drive backend data */
function getGDriveData(settings: AirSyncSettings): GoogleDriveBackendData {
	return {
		...DEFAULT_GDRIVE_DATA,
		...getBackendData<GoogleDriveBackendData>(settings, "googledrive"),
	};
}

/**
 * Google Drive authentication provider (built-in OAuth via auth server).
 */
export class GoogleDriveAuthProvider extends GoogleDriveAuthProviderBase {
	readonly backendType = "googledrive";

	constructor(secretStore: ISecretStore) {
		super(secretStore);
	}

	protected createAuth(_backendData: Record<string, unknown>): IGoogleAuth {
		this.googleAuth = new GoogleAuth();
		return this.googleAuth;
	}

	protected createAuthIfNeeded(_backendData: Record<string, unknown>): IGoogleAuth {
		if (!this.googleAuth) {
			this.googleAuth = new GoogleAuth();
		}
		return this.googleAuth;
	}

	getOrCreateGoogleAuth(_data: GoogleDriveBackendData, logger?: Logger): IGoogleAuth {
		if (!this.googleAuth) {
			this.googleAuth = new GoogleAuth(logger);
		}
		return this.googleAuth;
	}
}

/**
 * Google Drive backend provider (built-in OAuth).
 */
export class GoogleDriveProvider extends GoogleDriveProviderBase {
	readonly type = "googledrive";
	readonly displayName = "Google Drive";
	readonly auth: GoogleDriveAuthProvider;

	constructor(secretStore: ISecretStore) {
		super(secretStore);
		this.auth = new GoogleDriveAuthProvider(secretStore);
	}

	protected getData(settings: AirSyncSettings): GoogleDriveBackendData {
		return getGDriveData(settings);
	}

	protected getDefaultData(): GoogleDriveBackendData {
		return DEFAULT_GDRIVE_DATA;
	}
}
