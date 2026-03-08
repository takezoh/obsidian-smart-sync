import { App, PluginSettingTab, Setting } from "obsidian";
import type SmartSyncPlugin from "../main";
import type { ConflictStrategy } from "../sync/types";
import { getAllBackendProviders, getBackendProvider } from "../fs/registry";
import { getBackendSettingsRenderer } from "./backend-settings";

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
							const previousType = this.plugin.settings.backendType;
							if (previousType !== value) {
								const prevProvider = getBackendProvider(previousType);
								if (prevProvider && prevProvider.isConnected(this.plugin.settings)) {
									await this.plugin.backendManager.disconnectBackend();
								}
							}
							this.plugin.settings.backendType = value;
							await this.plugin.saveSettings();
							await this.plugin.backendManager.initBackend();
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

		// --- Backend-specific settings (config + connection flow) ---
		const provider = getBackendProvider(
			this.plugin.settings.backendType
		);
		const renderer = getBackendSettingsRenderer(
			this.plugin.settings.backendType
		);
		if (renderer) {
			new Setting(containerEl)
				.setName(`${provider?.displayName ?? "Backend"} connection`)
				.setHeading();

			const backendType = this.plugin.settings.backendType;
			renderer.render(
				containerEl,
				this.plugin.settings,
				async (updates) => {
					const current = this.plugin.settings.backendData[backendType] ?? {};
					this.plugin.settings.backendData[backendType] = { ...current, ...updates };
					await this.plugin.saveSettings();
					await this.plugin.backendManager.initBackend();
				},
				{
					startAuth: () => this.plugin.backendManager.startBackendConnect(),
					completeAuth: (code: string) =>
						this.plugin.backendManager.completeBackendConnect(code),
					disconnect: () => this.plugin.backendManager.disconnectBackend(),
					refreshDisplay: () => this.display(),
				}
			);
		}

		// --- Advanced settings ---
		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Dot-prefixed paths to sync")
			.setDesc(
				"Dot-prefixed folders to include in sync, one per line (e.g. .templates)."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder(".templates\n.stversions")
					.setValue(
						this.plugin.settings.syncDotPaths.join("\n")
					)
					.onChange(async (value) => {
						const paths = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line.length > 0)
							.filter((line) => line.startsWith("."))
							.filter((line) => line.replace(/\/+$/, "") !== ".smartsync");
						this.plugin.settings.syncDotPaths = [...new Set(paths)];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ignore patterns")
			.setDesc( // eslint-disable-next-line obsidianmd/ui/sentence-case
				"Gitignore-style patterns, one per line. Use ! to negate, # for comments. Last matching rule wins."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("# Ignore secrets\nsecret/**\n!secret/public/\n!secret/public/**") // eslint-disable-line obsidianmd/ui/sentence-case
					.setValue(
						this.plugin.settings.ignorePatterns.join("\n")
					)
					.onChange(async (value) => {
						this.plugin.settings.ignorePatterns =
							value.split("\n");
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

		new Setting(containerEl)
			.setName("Enable logging")
			.setDesc(
				"Write sync logs to .smartsync/ in your vault for debugging."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableLogging)
					.onChange(async (value) => {
						this.plugin.settings.enableLogging = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Log level")
			.setDesc(
				"Minimum level of messages to log."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("debug", "Debug")
					.addOption("info", "Info")
					.addOption("warn", "Warn")
					.addOption("error", "Error")
					.setValue(this.plugin.settings.logLevel)
					.onChange(async (value) => {
						this.plugin.settings.logLevel =
							value as "debug" | "info" | "warn" | "error";
						await this.plugin.saveSettings();
					})
			);
	}
}
