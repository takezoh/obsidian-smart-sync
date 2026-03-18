import { App, TFile, TFolder, Vault } from "obsidian";
import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import { sha256 } from "../../utils/hash";
import { normalizeSyncPath, validateRename } from "../../utils/path";
import { DotPathAdapter } from "./dot-path-adapter";

/** IFileSystem implementation backed by an Obsidian Vault */
export class LocalFs implements IFileSystem {
	readonly name = "local";
	private vault: Vault;
	private app: App;
	private dotPath: DotPathAdapter;

	constructor(app: App, getDotPaths: () => string[] = () => []) {
		this.app = app;
		this.vault = app.vault;
		this.dotPath = new DotPathAdapter(
			this.vault,
			(p) => this.mkdirRecursive(p),
			() => [".airsync", ...getDotPaths()],
		);
	}

	async list(): Promise<FileEntity[]> {
		const entities: FileEntity[] = [];
		const allFiles = this.vault.getAllLoadedFiles();

		for (const file of allFiles) {
			// Skip root
			if (file.path === "/" || file.path === "") continue;

			if (file instanceof TFile) {
				entities.push({
					path: file.path,
					isDirectory: false,
					size: file.stat.size,
					mtime: file.stat.mtime,
					hash: "",
				});
			} else if (file instanceof TFolder) {
				entities.push({
					path: file.path,
					isDirectory: true,
					size: 0,
					mtime: 0,
					hash: "",
				});
			}
		}

		// Dot-prefixed paths are excluded from Vault index; scan via adapter
		await this.dotPath.listAll(entities);

		return entities;
	}

	async stat(path: string): Promise<FileEntity | null> {
		path = normalizeSyncPath(path);
		const file = this.vault.getAbstractFileByPath(path);
		if (!file && this.dotPath.isDotPath(path)) {
			return this.dotPath.stat(path);
		}
		if (!file) return null;

		if (file instanceof TFile) {
			const content = await this.vault.readBinary(file);
			const hash = await sha256(content);
			return {
				path: file.path,
				isDirectory: false,
				size: file.stat.size,
				mtime: file.stat.mtime,
				hash,
			};
		} else if (file instanceof TFolder) {
			return {
				path: file.path,
				isDirectory: true,
				size: 0,
				mtime: 0,
				hash: "",
			};
		}

		return null;
	}

	async read(path: string): Promise<ArrayBuffer> {
		path = normalizeSyncPath(path);
		const file = this.vault.getAbstractFileByPath(path);
		if (!file && this.dotPath.isDotPath(path)) {
			return this.dotPath.read(path);
		}
		if (!file) throw new Error(`File not found: ${path}`);
		if (!(file instanceof TFile)) throw new Error(`Not a file (is a directory): ${path}`);
		return this.vault.readBinary(file);
	}

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		if (this.dotPath.isDotPath(path)) {
			return this.dotPath.write(path, content, mtime);
		}
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) {
			throw new Error(`Cannot write file: "${path}" is an existing directory`);
		}
		let written: TFile;
		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, content, { mtime });
			written = existing;
		} else {
			// Ensure parent directories exist
			const parentPath = path.substring(0, path.lastIndexOf("/"));
			if (parentPath) {
				await this.mkdirRecursive(parentPath);
			}
			written = await this.vault.createBinary(path, content, { mtime });
		}
		const hash = await sha256(content);
		return {
			path,
			isDirectory: false,
			size: written.stat.size,
			mtime: written.stat.mtime,
			hash,
		};
	}

	async mkdir(path: string): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		await this.mkdirRecursive(path);
		return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
	}

	async listDir(path: string): Promise<FileEntity[]> {
		path = normalizeSyncPath(path);
		if (this.dotPath.isDotPath(path)) {
			return this.dotPath.listDir(path);
		}
		const folder = this.vault.getAbstractFileByPath(path);
		if (!(folder instanceof TFolder)) return [];
		return folder.children.map((child) => {
			if (child instanceof TFile) {
				return {
					path: child.path,
					isDirectory: false,
					size: child.stat.size,
					mtime: child.stat.mtime,
					hash: "",
				};
			}
			return { path: child.path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		});
	}

	async delete(path: string): Promise<void> {
		path = normalizeSyncPath(path);
		if (this.dotPath.isDotPath(path)) {
			return this.dotPath.delete(path);
		}
		const file = this.vault.getAbstractFileByPath(path);
		if (file) {
			await this.app.fileManager.trashFile(file);
		}
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeSyncPath(oldPath);
		newPath = normalizeSyncPath(newPath);
		validateRename(oldPath, newPath);
		if (this.dotPath.isDotPath(oldPath) || this.dotPath.isDotPath(newPath)) {
			return this.dotPath.rename(oldPath, newPath);
		}
		const file = this.vault.getAbstractFileByPath(oldPath);
		if (!file) {
			throw new Error(`File not found: ${oldPath}`);
		}
		if (this.vault.getAbstractFileByPath(newPath)) {
			throw new Error(`Destination already exists: ${newPath}`);
		}
		// Ensure parent directories exist for the new path
		const parentPath = newPath.substring(0, newPath.lastIndexOf("/"));
		if (parentPath) {
			await this.mkdirRecursive(parentPath);
		}
		await this.vault.rename(file, newPath);
	}

	private async mkdirRecursive(path: string): Promise<void> {
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;

		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const entry = this.vault.getAbstractFileByPath(current);
			if (entry instanceof TFile) {
				throw new Error(`Cannot create directory "${path}": "${current}" is a file`);
			}
			if (!entry) {
				// Folder may exist on disk but not in vault index (e.g. dot-prefixed dirs
				// created by other plugins). Check disk before creating.
				if (!(await this.vault.adapter.exists(current))) {
					await this.vault.createFolder(current);
				}
			}
		}
	}
}
