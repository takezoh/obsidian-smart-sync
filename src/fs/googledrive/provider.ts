import type { App } from "obsidian";
import { Notice, Platform } from "obsidian";
import type { IBackendProvider } from "../backend";
import type { IAuthProvider } from "../auth";
import type { IFileSystem } from "../interface";
import type { SmartSyncSettings } from "../../settings";
import { GoogleAuth } from "./auth";
import { DriveClient } from "./client";
import { GoogleDriveFs } from "./index";

/**
 * Google Drive authentication provider.
 * Owns the GoogleAuth instance and manages the OAuth lifecycle.
 */
export class GoogleDriveAuthProvider implements IAuthProvider {
	private googleAuth: GoogleAuth | null = null;

	isAuthenticated(settings: SmartSyncSettings): boolean {
		return !!settings.refreshToken;
	}

	async startAuth(_app: App, _settings: SmartSyncSettings): Promise<Partial<SmartSyncSettings>> {
		try {
			this.googleAuth = new GoogleAuth();

			const url = await this.googleAuth.getAuthorizationUrl();

			// Persist PKCE state so it survives plugin reload
			const pendingCodeVerifier = this.googleAuth.getCodeVerifier() ?? "";
			const pendingAuthState = this.googleAuth.getAuthState() ?? "";

			if (Platform.isMobile) {
				// window.open() is blocked in iOS WKWebView;
				// assigning location.href lets Obsidian open the system browser.
				window.location.href = url;
			} else {
				window.open(url);
			}
			new Notice(
				"Complete authorization in your browser, then paste the code in settings"
			);

			return { pendingCodeVerifier, pendingAuthState };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to start authorization: ${msg}`);
			return {};
		}
	}

	async completeAuth(
		input: string,
		settings: SmartSyncSettings
	): Promise<Partial<SmartSyncSettings>> {
		if (!this.googleAuth) {
			this.googleAuth = new GoogleAuth();
		}
		// Always restore PKCE state if auth lacks it (survives plugin reload)
		if (!this.googleAuth.getAuthState() && settings.pendingCodeVerifier && settings.pendingAuthState) {
			this.googleAuth.setPkceState(settings.pendingCodeVerifier, settings.pendingAuthState);
		}

		// Parse input: may be a bare code or a full callback URL containing code + state
		const { code, state } = parseAuthInput(input);
		await this.googleAuth.exchangeCode(code, state);
		const tokens = this.googleAuth.getTokenState();
		return {
			refreshToken: tokens.refreshToken,
			accessToken: tokens.accessToken,
			accessTokenExpiry: tokens.accessTokenExpiry,
			pendingCodeVerifier: "",
			pendingAuthState: "",
		};
	}

	async disconnect(_settings: SmartSyncSettings): Promise<Partial<SmartSyncSettings>> {
		if (this.googleAuth) {
			await this.googleAuth.revokeToken();
		}
		this.googleAuth = null;
		return {
			refreshToken: "",
			accessToken: "",
			accessTokenExpiry: 0,
			changesStartPageToken: "",
			pendingCodeVerifier: "",
			pendingAuthState: "",
		};
	}

	/**
	 * Get or create a GoogleAuth instance for FS creation.
	 * Re-creates if the stored refreshToken has changed.
	 */
	getOrCreateGoogleAuth(settings: SmartSyncSettings): GoogleAuth {
		if (
			!this.googleAuth ||
			this.googleAuth.getTokenState().refreshToken !== settings.refreshToken
		) {
			this.googleAuth = new GoogleAuth();
		}
		return this.googleAuth;
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

	createFs(_app: App, settings: SmartSyncSettings): IFileSystem | null {
		if (!settings.refreshToken || !settings.driveFolderId) return null;

		const googleAuth = this.auth.getOrCreateGoogleAuth(settings);
		googleAuth.setTokens(
			settings.refreshToken,
			settings.accessToken,
			settings.accessTokenExpiry
		);
		const client = new DriveClient(googleAuth);
		const fs = new GoogleDriveFs(client, settings.driveFolderId);

		// Restore the changes page token for incremental sync
		if (settings.changesStartPageToken) {
			fs.changesPageToken = settings.changesStartPageToken;
		}

		return fs;
	}

	isConnected(settings: SmartSyncSettings): boolean {
		return !!settings.refreshToken && !!settings.driveFolderId;
	}

	readFsState(fs: IFileSystem): Partial<SmartSyncSettings> {
		if (!(fs instanceof GoogleDriveFs)) return {};
		const token = fs.changesPageToken;
		return token ? { changesStartPageToken: token } : {};
	}
}

/**
 * Parse auth input which may be a bare authorization code or a full callback URL.
 * Returns the extracted code and optional state parameter.
 */
function parseAuthInput(input: string): { code: string; state?: string } {
	const trimmed = input.trim();

	// Check if input looks like a URL
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		try {
			const url = new URL(trimmed);
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state") ?? undefined;
			if (code) {
				return { code, state };
			}
		} catch {
			// Not a valid URL, treat as bare code
		}
	}

	if (!trimmed) {
		throw new Error("Authorization code is empty");
	}
	return { code: trimmed };
}
