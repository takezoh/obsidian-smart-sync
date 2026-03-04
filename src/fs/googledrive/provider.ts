import { App, Notice, Setting, TextComponent, debounce } from "obsidian";
import type { BackendConnectionActions, IBackendProvider } from "../backend";
import type { IFileSystem } from "../interface";
import type { SmartSyncSettings } from "../../settings";
import { GoogleAuth } from "./auth";
import { DriveClient } from "./client";
import { GoogleDriveFs } from "./index";

/**
 * Google Drive backend provider.
 * Encapsulates all Google Drive-specific logic: OAuth, client creation,
 * settings UI. main.ts interacts only via IBackendProvider.
 */
export class GoogleDriveProvider implements IBackendProvider {
	readonly type = "googledrive";
	readonly displayName = "Google Drive";

	private auth: GoogleAuth | null = null;

	createFs(_app: App, settings: SmartSyncSettings): IFileSystem | null {
		if (!settings.refreshToken || !settings.driveFolderId) return null;

		const auth = this.getOrCreateAuth(settings);
		auth.setTokens(
			settings.refreshToken,
			settings.accessToken,
			settings.accessTokenExpiry
		);
		const client = new DriveClient(auth);
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

	async startConnect(_app: App, settings: SmartSyncSettings): Promise<Partial<SmartSyncSettings>> {
		if (!settings.oauthClientId || !settings.tokenExchangeUrl) {
			new Notice(
				"Please set OAuth client ID and token exchange URL first" // eslint-disable-line obsidianmd/ui/sentence-case
			);
			return {};
		}

		try {
			this.auth = new GoogleAuth({
				clientId: settings.oauthClientId,
				tokenExchangeUrl: settings.tokenExchangeUrl,
			});

			const url = await this.auth.getAuthorizationUrl();

			// Persist PKCE state so it survives plugin reload
			const pendingCodeVerifier = this.auth.getCodeVerifier() ?? "";
			const pendingAuthState = this.auth.getAuthState() ?? "";

			window.open(url);
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

	async completeConnect(
		input: string,
		settings: SmartSyncSettings
	): Promise<Partial<SmartSyncSettings>> {
		if (!settings.oauthClientId || !settings.tokenExchangeUrl) {
			throw new Error("OAuth client ID and token exchange URL must be configured");
		}

		if (!this.auth) {
			this.auth = new GoogleAuth({
				clientId: settings.oauthClientId,
				tokenExchangeUrl: settings.tokenExchangeUrl,
			});
		}
		// Always restore PKCE state if auth lacks it (survives plugin reload)
		if (!this.auth.getAuthState() && settings.pendingCodeVerifier && settings.pendingAuthState) {
			this.auth.setPkceState(settings.pendingCodeVerifier, settings.pendingAuthState);
		}

		// Parse input: may be a bare code or a full callback URL containing code + state
		const { code, state } = parseAuthInput(input);
		await this.auth.exchangeCode(code, state);
		const tokens = this.auth.getTokenState();
		return {
			refreshToken: tokens.refreshToken,
			accessToken: tokens.accessToken,
			accessTokenExpiry: tokens.accessTokenExpiry,
			pendingCodeVerifier: "",
			pendingAuthState: "",
		};
	}

	readFsState(fs: IFileSystem): Partial<SmartSyncSettings> {
		if (!(fs instanceof GoogleDriveFs)) return {};
		const token = fs.changesPageToken;
		return token ? { changesStartPageToken: token } : {};
	}

	async disconnect(_settings: SmartSyncSettings): Promise<Partial<SmartSyncSettings>> {
		if (this.auth) {
			await this.auth.revokeToken();
		}
		this.auth = null;
		return {
			refreshToken: "",
			accessToken: "",
			accessTokenExpiry: 0,
			changesStartPageToken: "",
			pendingCodeVerifier: "",
			pendingAuthState: "",
		};
	}

	renderSettings(
		containerEl: HTMLElement,
		settings: SmartSyncSettings,
		onSave: (updates: Partial<SmartSyncSettings>) => Promise<void>,
		actions: BackendConnectionActions
	): void {
		const debouncedSave = debounce(
			(updates: Partial<SmartSyncSettings>) => {
				onSave(updates).catch((err) => {
					console.error("Smart Sync: failed to save settings", err);
					new Notice("Failed to save settings. Please try again.");
				});
			},
			1000,
			true
		);

		new Setting(containerEl)
			.setName("Google Drive folder ID")
			.setDesc(
				"The ID of the Google Drive folder to sync with. Found in the folder's URL."
			)
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					.setPlaceholder("e.g. 1AbCdEfGhIjKlMnOpQrStUvWxYz")
					.setValue(settings.driveFolderId)
					.onChange((value) => {
						debouncedSave({ driveFolderId: value });
					})
			);

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("OAuth client ID")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Google OAuth client ID for your GCP project.")
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					.setPlaceholder("xxxx.apps.googleusercontent.com")
					.setValue(settings.oauthClientId)
					.onChange((value) => {
						debouncedSave({ oauthClientId: value });
					})
			);

		new Setting(containerEl)
			.setName("Token exchange URL")
			.setDesc(
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				"URL of your token exchange server (Cloud Functions / Cloud Run endpoint)."
			)
			.addText((text) =>
				text
					.setPlaceholder(
						"https://your-function.cloudfunctions.net/exchange"
					)
					.setValue(settings.tokenExchangeUrl)
					.onChange((value) => {
						debouncedSave({ tokenExchangeUrl: value });
					})
			);

		// Connection status + connect/disconnect
		const connected = this.isConnected(settings);
		const authorized = !!settings.refreshToken;
		const statusDesc = connected
			? "Connected"
			: authorized
				? "Authorized (folder ID required)"
				: "Not connected";
		new Setting(containerEl)
			.setName("Connection status")
			.setDesc(statusDesc)
			.addButton((button) =>
				button
					.setButtonText(
						connected ? "Disconnect" : "Connect to Google Drive"
					)
					.onClick(async () => {
						if (connected) {
							await actions.disconnect();
						} else {
							await actions.startConnect();
						}
						actions.refreshDisplay();
					})
			);

		// Auth code input (only when not connected)
		if (!connected) {
			let authCodeInput: TextComponent;
			new Setting(containerEl)
				.setName("Authorization code")
				.setDesc(
					"After authorizing in your browser, paste the callback URL or authorization code here. " +
					"On mobile, copy the URL from the browser after granting access and paste it here."
				)
				.addText((text) => {
					authCodeInput = text.setPlaceholder("Paste callback URL or code here");
				})
				.addButton((button) =>
					button.setButtonText("Submit").onClick(async () => {
						const value = authCodeInput.getValue().trim();
						if (value) {
							try {
								await actions.completeConnect(value);
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								new Notice(`Authorization failed: ${msg}`);
							}
							actions.refreshDisplay();
						}
					})
				);
		}
	}

	private getOrCreateAuth(settings: SmartSyncSettings): GoogleAuth {
		if (
			!this.auth ||
			this.auth.getTokenState().refreshToken !== settings.refreshToken ||
			this.auth.getConfig().clientId !== settings.oauthClientId ||
			this.auth.getConfig().tokenExchangeUrl !== settings.tokenExchangeUrl
		) {
			this.auth = new GoogleAuth({
				clientId: settings.oauthClientId,
				tokenExchangeUrl: settings.tokenExchangeUrl,
			});
		}
		return this.auth;
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
