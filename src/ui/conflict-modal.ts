import { App, Modal, Setting } from "obsidian";
import type { ConflictStrategy, SyncDecision } from "../fs/types";

type ConflictChoice = "keep_local" | "keep_remote" | "duplicate" | "three_way_merge";

/**
 * Modal that presents conflict resolution options to the user.
 * Returns a Promise that resolves with the user's chosen strategy.
 */
export class ConflictModal extends Modal {
	private decision: SyncDecision;
	private resolvePromise: ((strategy: ConflictStrategy) => void) | null = null;

	constructor(app: App, decision: SyncDecision) {
		super(app);
		this.decision = decision;
	}

	/** Open the modal and wait for the user to choose */
	waitForResolution(): Promise<ConflictStrategy> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Resolve sync conflict" });

		contentEl.createEl("p", {
			text: `Both local and remote versions of "${this.decision.path}" have changed.`,
			cls: "smart-sync-conflict-desc",
		});

		// Show file info
		if (this.decision.local) {
			const localInfo = contentEl.createEl("div", {
				cls: "smart-sync-conflict-info",
			});
			localInfo.createEl("strong", { text: "Local: " });
			localInfo.createEl("span", {
				text: `${formatSize(this.decision.local.size)}, modified ${formatDate(this.decision.local.mtime)}`,
			});
		}

		if (this.decision.remote) {
			const remoteInfo = contentEl.createEl("div", {
				cls: "smart-sync-conflict-info",
			});
			remoteInfo.createEl("strong", { text: "Remote: " });
			remoteInfo.createEl("span", {
				text: `${formatSize(this.decision.remote.size)}, modified ${formatDate(this.decision.remote.mtime)}`,
			});
		}

		contentEl.createEl("hr");

		const choices: { value: ConflictChoice; label: string; desc: string }[] = [
			{
				value: "keep_local",
				label: "Keep local",
				desc: "Overwrite the remote file with the local version.",
			},
			{
				value: "keep_remote",
				label: "Keep remote",
				desc: "Overwrite the local file with the remote version.",
			},
			{
				value: "duplicate",
				label: "Create duplicate",
				desc: "Keep both versions. The remote version is saved with a .conflict suffix.",
			},
			{
				value: "three_way_merge",
				label: "Attempt merge",
				desc: "Try to merge changes automatically (text files only).",
			},
		];

		for (const choice of choices) {
			new Setting(contentEl)
				.setName(choice.label)
				.setDesc(choice.desc)
				.addButton((button) =>
					button
						.setButtonText("Choose")
						.onClick(() => {
							this.resolvePromise?.(choice.value);
							this.close();
						})
				);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		// If closed without choosing, default to keep_newer
		this.resolvePromise?.("keep_newer");
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(mtime: number): string {
	if (mtime === 0) return "unknown";
	return new Date(mtime).toLocaleString();
}
