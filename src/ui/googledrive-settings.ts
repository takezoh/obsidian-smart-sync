import type { App } from "obsidian";
import { Notice, SecretComponent, Setting } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "./backend-settings";
import type { GoogleDriveBackendData } from "../fs/googledrive/provider";
import type { GoogleDriveCustomBackendData } from "../fs/googledrive/provider-custom";
import { DEFAULT_CUSTOM_SCOPE, DEFAULT_CUSTOM_REDIRECT_URI } from "../fs/googledrive/auth";
import { getBackendProvider } from "../fs/registry";

/**
 * Renders Google Drive-specific settings UI:
 * connection status and auth code flow.
 */
export class GoogleDriveSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "googledrive";

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		_onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		_app: App,
	): void {
		const data = (settings.backendData["googledrive"] ?? {}) as Partial<GoogleDriveBackendData>;

		const provider = getBackendProvider("googledrive");
		const isConnected = provider?.isConnected(settings) ?? false;

		let statusDesc: string;
		let statusClass: string;
		if (isConnected) {
			statusDesc = "\u25cf Connected";
			statusClass = "air-sync-status-connected";
		} else {
			statusDesc = "\u25cf Not connected";
			statusClass = "air-sync-status-disconnected";
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
		settings: AirSyncSettings,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		app: App,
	): void {
		const data = (settings.backendData["googledrive-custom"] ?? {}) as Partial<GoogleDriveCustomBackendData>;
		const provider = getBackendProvider("googledrive-custom");
		const isConnected = provider?.isConnected(settings) ?? false;

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("Select a secret containing your client ID")
			.addComponent(el => new SecretComponent(app, el)
				.setValue(data.customClientId ?? "")
				.onChange(async (value) => {
					await onSave({ customClientId: value });
				}));

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("Select a secret containing your client secret")
			.addComponent(el => new SecretComponent(app, el)
				.setValue(data.customClientSecret ?? "")
				.onChange(async (value) => {
					await onSave({ customClientSecret: value });
				}));

		new Setting(containerEl)
			.setName("Scope")
			.setDesc("Scope for drive access")
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
			.setDesc("Set this as the authorized redirect uri")
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
			.setName("Remote vault folder ID")
			.setDesc("Folder ID to sync with")
			.addText((text) =>
				text
					.setPlaceholder("...")
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
			statusClass = "air-sync-status-connected";
		} else {
			statusDesc = "\u25cf Not connected";
			statusClass = "air-sync-status-disconnected";
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
								new Notice("Enter a remote vault folder ID first");
								return;
							}
							await actions.startAuth();
						}
						actions.refreshDisplay();
					})
			);
	}
}
