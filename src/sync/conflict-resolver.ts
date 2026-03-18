import { App, Modal, Setting } from "obsidian";
import type { ButtonComponent } from "obsidian";
import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { ConflictStrategy, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import { resolveWithStrategy, type ConflictResolutionResult } from "./conflict";

export interface ConflictResolverContext {
	path: string;
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	local?: FileEntity;
	remote?: FileEntity;
	baseline?: SyncRecord;
	stateStore?: SyncStateStore;
	logger?: Logger;
	app?: App;
}

export type { ConflictResolutionResult };

/**
 * Resolve a conflict using the configured strategy.
 *
 * auto_merge fallback chain:
 *   text file + base content → 3-way merge → success: write merged to both sides
 *                                           → fail: keep newer
 *   else → keep newer
 *   keep newer: mtime comparable → newer wins, older saved as .conflict backup
 *               else → duplicate
 *   duplicate: save remote as .conflict file, keep local at original path
 *
 * ask: show UI modal for user to choose keep local / keep remote / duplicate
 */
export async function resolveConflict(
	ctx: ConflictResolverContext,
	strategy: ConflictStrategy,
): Promise<ConflictResolutionResult> {
	switch (strategy) {
		case "auto_merge":
			return resolveAutoMerge(ctx);
		case "duplicate":
			return resolveWithStrategy(
				{
					path: ctx.path,
					localFs: ctx.localFs,
					remoteFs: ctx.remoteFs,
					local: ctx.local,
					remote: ctx.remote,
					prevSync: ctx.baseline,
					stateStore: ctx.stateStore,
					logger: ctx.logger,
				},
				"duplicate",
			);
		case "ask":
			return resolveAsk(ctx);
	}
}

async function resolveAutoMerge(
	ctx: ConflictResolverContext,
): Promise<ConflictResolutionResult> {
	const { path, localFs, remoteFs, local, remote, baseline, stateStore, logger } = ctx;

	const conflictCtx = {
		path,
		localFs,
		remoteFs,
		local,
		remote,
		prevSync: baseline,
		stateStore,
		logger,
	};

	// Try 3-way merge if we have everything needed; newer-wins is the fallback
	if (local && remote && baseline && stateStore) {
		return resolveWithStrategy(conflictCtx, "auto_merge", "keep_newer");
	}

	return resolveWithStrategy(conflictCtx, "keep_newer");
}

async function resolveAsk(
	ctx: ConflictResolverContext,
): Promise<ConflictResolutionResult> {
	const { path, localFs, remoteFs, local, remote, baseline, stateStore, logger, app } = ctx;

	const conflictCtx = {
		path,
		localFs,
		remoteFs,
		local,
		remote,
		prevSync: baseline,
		stateStore,
		logger,
	};

	if (!app) {
		logger?.warn("Ask strategy: no app provided, falling back to duplicate", { path });
		return resolveWithStrategy(conflictCtx, "duplicate");
	}

	const choice = await showAskModal(app, ctx);

	switch (choice) {
		case "keep_local":
			return resolveWithStrategy(conflictCtx, "keep_local");
		case "keep_remote":
			return resolveWithStrategy(conflictCtx, "keep_remote");
		case "duplicate":
			return resolveWithStrategy(conflictCtx, "duplicate");
	}
}

type AskChoice = "keep_local" | "keep_remote" | "duplicate";

function showAskModal(app: App, ctx: ConflictResolverContext): Promise<AskChoice> {
	return new Promise<AskChoice>((resolve) => {
		const modal = new AskConflictModal(app, ctx, resolve);
		modal.open();
	});
}

class AskConflictModal extends Modal {
	private ctx: ConflictResolverContext;
	private resolveChoice: (choice: AskChoice) => void;
	private resolved = false;

	constructor(app: App, ctx: ConflictResolverContext, resolveChoice: (choice: AskChoice) => void) {
		super(app);
		this.ctx = ctx;
		this.resolveChoice = resolveChoice;
	}

	private choose(choice: AskChoice) {
		if (this.resolved) return;
		this.resolved = true;
		this.resolveChoice(choice);
		this.close();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Resolve sync conflict" });
		contentEl.createEl("p", {
			text: `Both local and remote versions of "${this.ctx.path}" have changed.`,
			cls: "air-sync-conflict-desc",
		});

		if (this.ctx.local) {
			const info = contentEl.createEl("div", { cls: "air-sync-conflict-info" });
			info.createEl("strong", { text: "Local: " });
			info.createEl("span", { text: formatFileInfo(this.ctx.local) });
		}
		if (this.ctx.remote) {
			const info = contentEl.createEl("div", { cls: "air-sync-conflict-info" });
			info.createEl("strong", { text: "Remote: " });
			info.createEl("span", { text: formatFileInfo(this.ctx.remote) });
		}

		contentEl.createEl("hr");

		const choices: { value: AskChoice; label: string; desc: string }[] = [
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

		for (const c of choices) {
			new Setting(contentEl)
				.setName(c.label)
				.setDesc(c.desc)
				.addButton((btn: ButtonComponent) =>
					btn.setButtonText("Choose").onClick(() => {
						this.choose(c.value);
					})
				);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		// Default to duplicate if closed without choosing
		if (!this.resolved) {
			this.resolved = true;
			this.resolveChoice("duplicate");
		}
	}
}

function formatFileInfo(entity: FileEntity): string {
	const size = formatSize(entity.size);
	const date = entity.mtime === 0 ? "unknown" : new Date(entity.mtime).toLocaleString();
	return `${size}, modified ${date}`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
