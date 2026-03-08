import { Notice, Setting } from "obsidian";
import type { SmartSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "./backend-settings";
import type { GoogleDriveBackendData } from "../fs/googledrive/provider";
import type { GoogleDriveCustomBackendData } from "../fs/googledrive/provider-custom";
import { DEFAULT_CUSTOM_SCOPE, DEFAULT_CUSTOM_REDIRECT_URI } from "../fs/googledrive/auth";

/**
 * Renders Google Drive-specific settings UI:
 * connection status and auth code flow.
 */
export class GoogleDriveSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "googledrive";

	render(
		containerEl: HTMLElement,
		settings: SmartSyncSettings,
		_onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions
	): void {
		const data = (settings.backendData["googledrive"] ?? {}) as Partial<GoogleDriveBackendData>;

		const isConnected = !!data.refreshToken;

		let statusDesc: string;
		let statusClass: string;
		if (isConnected) {
			statusDesc = "\u25cf Connected";
			statusClass = "smart-sync-status-connected";
		} else {
			statusDesc = "\u25cf Not connected";
			statusClass = "smart-sync-status-disconnected";
		}
		const statusSetting = new Setting(containerEl)
			.setName("Connection status")
			.setDesc(statusDesc);
		statusSetting.settingEl.addClass(statusClass);
		statusSetting
			.addButton((button) =>
				button
					.setButtonText(
						isConnected ? "Disconnect" : "Connect to Google Drive"
					)
					.onClick(async () => {
						if (isConnected) {
							await actions.disconnect();
						} else {
							await actions.startAuth();
						}
						actions.refreshDisplay();
					})
			);

		// Show remote vault folder ID when connected (read-only)
		if (isConnected && data.remoteVaultFolderId) {
			new Setting(containerEl)
				.setName("Remote vault folder")
				.setDesc("Automatically managed folder in Google Drive")
				.addText((text) =>
					text
						.setValue(data.remoteVaultFolderId ?? "")
						.setDisabled(true)
				);
		}

	}
}

/**
 * Renders Google Drive (custom OAuth) settings UI:
 * client credentials, connection status, and auth flow.
 */
export class GoogleDriveCustomSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "googledrive-custom";

	render(
		containerEl: HTMLElement,
		settings: SmartSyncSettings,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions
	): void {
		const data = (settings.backendData["googledrive-custom"] ?? {}) as Partial<GoogleDriveCustomBackendData>;
		const isConnected = !!data.refreshToken;

		new Setting(containerEl)
			.setName("Client id") // eslint-disable-line obsidianmd/ui/sentence-case -- OAuth field name
			.setDesc("Your Google Cloud OAuth 2.0 client id") // eslint-disable-line obsidianmd/ui/sentence-case -- OAuth field name
			.addText((text) =>
				text
					.setPlaceholder("xxxxx.apps.googleusercontent.com") // eslint-disable-line obsidianmd/ui/sentence-case -- example value
					.setValue(data.customClientId ?? "")
					.setDisabled(isConnected)
					.onChange(async (value) => {
						await onSave({ customClientId: value });
					})
			);

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("Stored locally in your vault's plugin data")
			.addText((text) =>
				text
					.setPlaceholder("GOCSPX-...") // eslint-disable-line obsidianmd/ui/sentence-case -- example value
					.setValue(data.customClientSecret ?? "")
					.setDisabled(isConnected)
					.onChange(async (value) => {
						await onSave({ customClientSecret: value });
					})
			);

		new Setting(containerEl)
			.setName("Scope")
			.setDesc("OAuth scope for Google Drive access") // eslint-disable-line obsidianmd/ui/sentence-case -- OAuth is a proper noun
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_CUSTOM_SCOPE)
					.setValue(data.customScope ?? "")
					.setDisabled(isConnected)
					.onChange(async (value) => {
						await onSave({ customScope: value });
					})
			);

		new Setting(containerEl)
			.setName("Redirect uri")
			.setDesc("Set this as the authorized redirect uri in Google Cloud Console") // eslint-disable-line obsidianmd/ui/sentence-case -- proper nouns
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_CUSTOM_REDIRECT_URI)
					.setValue(data.customRedirectUri ?? "")
					.setDisabled(isConnected)
					.onChange(async (value) => {
						await onSave({ customRedirectUri: value });
					})
			);

		new Setting(containerEl)
			.setName("Remote vault folder id") // eslint-disable-line obsidianmd/ui/sentence-case -- Google Drive folder ID
			.setDesc("Google Drive folder id to sync with") // eslint-disable-line obsidianmd/ui/sentence-case -- Google Drive folder ID
			.addText((text) =>
				text
					.setPlaceholder("1AbC...") // eslint-disable-line obsidianmd/ui/sentence-case -- example value
					.setValue(data.remoteVaultFolderId ?? "")
					.setDisabled(isConnected)
					.onChange(async (value) => {
						await onSave({ remoteVaultFolderId: value.trim() });
					})
			);

		let statusDesc: string;
		let statusClass: string;
		if (isConnected) {
			statusDesc = "\u25cf Connected";
			statusClass = "smart-sync-status-connected";
		} else {
			statusDesc = "\u25cf Not connected";
			statusClass = "smart-sync-status-disconnected";
		}
		const statusSetting = new Setting(containerEl)
			.setName("Connection status")
			.setDesc(statusDesc);
		statusSetting.settingEl.addClass(statusClass);
		statusSetting
			.addButton((button) =>
				button
					.setButtonText(
						isConnected ? "Disconnect" : "Connect to Google Drive"
					)
					.onClick(async () => {
						if (isConnected) {
							await actions.disconnect();
						} else {
							const current = (settings.backendData["googledrive-custom"] ?? {}) as Partial<GoogleDriveCustomBackendData>;
							if (!current.remoteVaultFolderId) {
								new Notice("Enter a remote vault folder id first"); // eslint-disable-line obsidianmd/ui/sentence-case -- field name
								return;
							}
							await actions.startAuth();
						}
						actions.refreshDisplay();
					})
			);
	}
}
