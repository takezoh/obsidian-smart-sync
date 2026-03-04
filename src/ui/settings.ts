import { App, PluginSettingTab, Setting } from "obsidian";
import type SmartSyncPlugin from "../main";
import type { ConflictStrategy } from "../fs/types";
import { getAllBackendProviders, getBackendProvider } from "../fs/registry";

export class SmartSyncSettingTab extends PluginSettingTab {
	plugin: SmartSyncPlugin;

	constructor(app: App, plugin: SmartSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Sync").setHeading();

		// Backend selector
		const backends = getAllBackendProviders();
		if (backends.length > 1) {
			new Setting(containerEl)
				.setName("Remote backend")
				.setDesc("The remote storage service to sync with.")
				.addDropdown((dropdown) => {
					for (const b of backends) {
						dropdown.addOption(b.type, b.displayName);
					}
					dropdown
						.setValue(this.plugin.settings.backendType)
						.onChange(async (value) => {
							this.plugin.settings.backendType = value;
							await this.plugin.saveSettings();
							this.plugin.initBackend();
							this.display();
						});
				});
		}

		new Setting(containerEl)
			.setName("Auto-sync interval")
			.setDesc("Sync automatically every n minutes. Set to 0 to disable.")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(
						String(this.plugin.settings.autoSyncIntervalMinutes)
					)
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.autoSyncIntervalMinutes = num;
							await this.plugin.saveSettings();
							this.plugin.setupAutoSync();
						}
					})
			);

		new Setting(containerEl)
			.setName("Conflict strategy")
			.setDesc(
				"How to resolve conflicts when both local and remote files have changed."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("keep_newer", "Keep newer")
					.addOption("keep_local", "Keep local")
					.addOption("keep_remote", "Keep remote")
					.addOption("duplicate", "Create duplicate")
					.addOption("ask", "Ask each time")
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value) => {
						this.plugin.settings.conflictStrategy =
							value as ConflictStrategy;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable 3-way merge")
			.setDesc(
				"Attempt to merge text file changes automatically using the last synced version as base. Falls back to conflict strategy on failure."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableThreeWayMerge)
					.onChange(async (value) => {
						this.plugin.settings.enableThreeWayMerge = value;
						await this.plugin.saveSettings();
					})
			);

		const configDir = this.app.vault.configDir;
		new Setting(containerEl)
			.setName("Exclude patterns")
			.setDesc(
				`Glob patterns to exclude from sync, one per line. Default: ${configDir}/**, .trash/**`
			)
			.addTextArea((text) =>
				text
					.setPlaceholder(`${configDir}/**\n.trash/**`)
					.setValue(
						this.plugin.settings.excludePatterns.join("\n")
					)
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					})
			);

		// --- Mobile sync settings ---
		new Setting(containerEl).setName("Mobile sync").setHeading();

		new Setting(containerEl)
			.setName("Mobile include patterns")
			.setDesc(
				"Glob patterns for files to sync on mobile, one per line. Only matching files will be synced. By default, images and other attachments are excluded to save bandwidth."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("**/*.md\n**/*.canvas")
					.setValue(
						this.plugin.settings.mobileIncludePatterns.join("\n")
					)
					.onChange(async (value) => {
						this.plugin.settings.mobileIncludePatterns = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("Mobile max file size (MB)")
			.setDesc(
				"Files larger than this will be skipped on mobile."
			)
			.addText((text) =>
				text
					.setPlaceholder("10")
					.setValue(
						String(this.plugin.settings.mobileMaxFileSizeMB)
					)
					.onChange(async (value) => {
						const num = parseFloat(value);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.mobileMaxFileSizeMB = num;
							await this.plugin.saveSettings();
						}
					})
			);

		// --- Backend-specific settings (config + connection flow) ---
		const provider = getBackendProvider(
			this.plugin.settings.backendType
		);
		if (!provider) return;

		new Setting(containerEl)
			.setName(`${provider.displayName} connection`)
			.setHeading();

		// Delegate all backend UI to the provider (config fields + connection flow)
		provider.renderSettings(
			containerEl,
			this.plugin.settings,
			async (updates) => {
				Object.assign(this.plugin.settings, updates);
				await this.plugin.saveSettings();
			},
			{
				startConnect: () => this.plugin.startBackendConnect(),
				completeConnect: (code: string) =>
					this.plugin.completeBackendConnect(code),
				disconnect: () => this.plugin.disconnectBackend(),
				refreshDisplay: () => this.display(),
			}
		);
	}
}
