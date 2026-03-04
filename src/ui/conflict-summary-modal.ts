import { App, Modal, Setting } from "obsidian";
import type { ConflictStrategy, SyncDecision } from "../fs/types";

export type SummaryChoice = "keep_all_local" | "keep_all_remote" | "resolve_individually";

/**
 * Modal that shows a summary of multiple conflicts and lets the user
 * choose a bulk resolution strategy or opt for per-file resolution.
 */
export class ConflictSummaryModal extends Modal {
	private conflicts: SyncDecision[];
	private resolvePromise: ((choice: SummaryChoice) => void) | null = null;

	constructor(app: App, conflicts: SyncDecision[]) {
		super(app);
		this.conflicts = conflicts;
	}

	waitForChoice(): Promise<SummaryChoice> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Multiple sync conflicts" });

		contentEl.createEl("p", {
			text: `${this.conflicts.length} files have conflicts that need resolution.`,
			cls: "smart-sync-summary-desc",
		});

		// List conflicting files
		const listEl = contentEl.createEl("ul", { cls: "smart-sync-summary-list" });
		const maxDisplay = 10;
		const displayed = this.conflicts.slice(0, maxDisplay);
		for (const conflict of displayed) {
			listEl.createEl("li", { text: conflict.path });
		}
		if (this.conflicts.length > maxDisplay) {
			listEl.createEl("li", {
				text: `…and ${this.conflicts.length - maxDisplay} more`,
				cls: "smart-sync-summary-more",
			});
		}

		contentEl.createEl("hr");

		const choices: { value: SummaryChoice; label: string; desc: string }[] = [
			{
				value: "keep_all_local",
				label: "Keep all local",
				desc: "Overwrite all remote files with local versions.",
			},
			{
				value: "keep_all_remote",
				label: "Keep all remote",
				desc: "Overwrite all local files with remote versions.",
			},
			{
				value: "resolve_individually",
				label: "Resolve individually",
				desc: "Choose a resolution for each file separately.",
			},
		];

		for (const choice of choices) {
			new Setting(contentEl)
				.setName(choice.label)
				.setDesc(choice.desc)
				.addButton((button) =>
					button.setButtonText("Choose").onClick(() => {
						this.resolvePromise?.(choice.value);
						this.close();
					})
				);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		// Default to individual resolution if closed without choosing
		this.resolvePromise?.("resolve_individually");
	}
}

/** Map a summary choice to a ConflictStrategy override, or null for per-file */
export function summaryChoiceToStrategy(choice: SummaryChoice): ConflictStrategy | null {
	switch (choice) {
		case "keep_all_local":
			return "keep_local";
		case "keep_all_remote":
			return "keep_remote";
		case "resolve_individually":
			return null;
	}
}
