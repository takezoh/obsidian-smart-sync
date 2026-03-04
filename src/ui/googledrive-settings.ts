import { Notice, Setting, TextComponent, debounce } from "obsidian";
import type { SmartSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "./backend-settings";

/**
 * Renders Google Drive-specific settings UI:
 * folder ID input, connection status, and auth code flow.
 */
export class GoogleDriveSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "googledrive";

	render(
		containerEl: HTMLElement,
		settings: SmartSyncSettings,
		onSave: (updates: Partial<SmartSyncSettings>) => Promise<void>,
		actions: BackendConnectionActions
	): void {
		const debouncedSave = debounce(
			(updates: Partial<SmartSyncSettings>) => {
				onSave(updates)
					.then(() => actions.refreshDisplay())
					.catch((err) => {
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

		// Connection status — derived from settings fields directly
		const isAuthenticated = !!settings.refreshToken;
		const isConnected = !!settings.refreshToken && !!settings.driveFolderId;

		let statusDesc: string;
		let statusClass: string;
		if (isConnected) {
			statusDesc = "\u25cf Connected";
			statusClass = "smart-sync-status-connected";
		} else if (isAuthenticated) {
			statusDesc = "\u25cf Authorized (folder ID required)";
			statusClass = "smart-sync-status-partial";
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
						isAuthenticated ? "Disconnect" : "Connect to Google Drive"
					)
					.onClick(async () => {
						if (isAuthenticated) {
							await actions.disconnect();
						} else {
							await actions.startAuth();
						}
						actions.refreshDisplay();
					})
			);

		// Auth code input (only when not yet authorized)
		if (!isAuthenticated) {
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
								await actions.completeAuth(value);
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
}
