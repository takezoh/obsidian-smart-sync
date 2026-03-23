import { App, PluginSettingTab, Setting } from "obsidian";
import type AirSyncPlugin from "../main";
import type { ConflictStrategy } from "../sync/types";
import { getAllBackendProviders, getBackendProvider } from "../fs/registry";
import { getBackendSettingsRenderer } from "./backend-settings";

export class AirSyncSettingTab extends PluginSettingTab {
	plugin: AirSyncPlugin;

	constructor(app: App, plugin: AirSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Slow poll interval (seconds)")
			.setDesc(
				"How often to check for remote changes while local is idle. Set to 0 to disable background polling."
			)
			.addText((text) =>
				text
					.setPlaceholder("300")
					.setValue(String(this.plugin.settings.slowPollIntervalSec))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.slowPollIntervalSec = num;
							await this.plugin.saveSettings();
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
					.addOption("auto_merge", "Auto merge (recommended)")
					.addOption("duplicate", "Always create duplicate")
					.addOption("ask", "Ask each time")
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value) => {
						this.plugin.settings.conflictStrategy =
							value as ConflictStrategy;
						await this.plugin.saveSettings();
					})
			);

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
				},
				this.app,
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
							.filter((line) => line.replace(/\/+$/, "") !== ".airsync");
						this.plugin.settings.syncDotPaths = [...new Set(paths)];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ignore patterns")
			.setDesc("Patterns to exclude from sync (gitignore syntax), one per line.")
			.addTextArea((text) =>
				text
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
			.setName("Mobile max file size (mb)")
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
				"Write sync logs to .airsync/ in your vault for debugging."
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
