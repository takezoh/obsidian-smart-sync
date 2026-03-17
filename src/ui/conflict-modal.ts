import { App, Modal, Setting } from "obsidian";
import type { SyncAction } from "../sync/types";
import type { SimplifiedConflictStrategy } from "../sync/conflict-resolver";

type ConflictChoice = "keep_local" | "keep_remote" | "duplicate";

/**
 * Modal that presents conflict resolution options to the user.
 * Returns a Promise that resolves with the user's chosen strategy.
 */
export class ConflictModal extends Modal {
	private action: SyncAction;
	private resolvePromise: ((strategy: SimplifiedConflictStrategy) => void) | null = null;

	constructor(app: App, action: SyncAction) {
		super(app);
		this.action = action;
	}

	/** Open the modal and wait for the user to choose */
	waitForResolution(): Promise<SimplifiedConflictStrategy> {
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
			text: `Both local and remote versions of "${this.action.path}" have changed.`,
			cls: "smart-sync-conflict-desc",
		});

		if (this.action.local) {
			const localInfo = contentEl.createEl("div", {
				cls: "smart-sync-conflict-info",
			});
			localInfo.createEl("strong", { text: "Local: " });
			localInfo.createEl("span", {
				text: `${formatSize(this.action.local.size)}, modified ${formatDate(this.action.local.mtime)}`,
			});
		}

		if (this.action.remote) {
			const remoteInfo = contentEl.createEl("div", {
				cls: "smart-sync-conflict-info",
			});
			remoteInfo.createEl("strong", { text: "Remote: " });
			remoteInfo.createEl("span", {
				text: `${formatSize(this.action.remote.size)}, modified ${formatDate(this.action.remote.mtime)}`,
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
				label: "Keep both",
				desc: "Save both versions — remote is kept with a .conflict suffix.",
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
							this.resolvePromise?.("ask");
							this.close();
						})
				);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		// If closed without choosing, default to duplicate (safest)
		this.resolvePromise?.("duplicate");
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
