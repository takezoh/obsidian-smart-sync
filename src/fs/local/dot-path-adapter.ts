import type { Vault } from "obsidian";
import type { FileEntity } from "../types";
import { sha256 } from "../../utils/hash";

/**
 * Handles filesystem operations for dot-prefixed paths (e.g. `.airsync/`)
 * that are excluded from Obsidian's Vault index. Uses the raw adapter API.
 */
export class DotPathAdapter {
	constructor(
		private vault: Vault,
		private mkdirFn: (path: string) => Promise<void>,
		private getDotRoots: () => string[],
	) {}

	isDotPath(path: string): boolean {
		return this.getDotRoots().some(
			(root) => path === root || path.startsWith(root + "/"),
		);
	}

	async listAll(entities: FileEntity[]): Promise<void> {
		for (const root of this.getDotRoots()) {
			await this.list(root, entities);
		}
	}

	async list(dir: string, entities: FileEntity[]): Promise<void> {
		if (!(await this.vault.adapter.exists(dir))) return;
		const listed = await this.vault.adapter.list(dir);
		for (const folder of listed.folders) {
			entities.push({ path: folder, isDirectory: true, size: 0, mtime: 0, hash: "" });
			await this.list(folder, entities);
		}
		for (const file of listed.files) {
			const s = await this.vault.adapter.stat(file);
			entities.push({
				path: file,
				isDirectory: false,
				size: s?.size ?? 0,
				mtime: s?.mtime ?? 0,
				hash: "",
			});
		}
	}

	async stat(path: string): Promise<FileEntity | null> {
		const s = await this.vault.adapter.stat(path);
		if (!s) return null;
		if (s.type === "folder") {
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		}
		const content = await this.vault.adapter.readBinary(path);
		const hash = await sha256(content);
		return { path, isDirectory: false, size: s.size, mtime: s.mtime, hash };
	}

	async read(path: string): Promise<ArrayBuffer> {
		if (!(await this.vault.adapter.exists(path))) {
			throw new Error(`File not found: ${path}`);
		}
		return this.vault.adapter.readBinary(path);
	}

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		const parentPath = path.substring(0, path.lastIndexOf("/"));
		if (parentPath && !(await this.vault.adapter.exists(parentPath))) {
			await this.mkdirFn(parentPath);
		}
		await this.vault.adapter.writeBinary(path, content, { mtime });
		const hash = await sha256(content);
		return { path, isDirectory: false, size: content.byteLength, mtime, hash };
	}

	async delete(path: string): Promise<void> {
		if (await this.vault.adapter.exists(path)) {
			const s = await this.vault.adapter.stat(path);
			if (s?.type === "folder") {
				await this.vault.adapter.rmdir(path, true);
			} else {
				await this.vault.adapter.remove(path);
			}
		}
	}

	async listDir(dir: string): Promise<FileEntity[]> {
		const entities: FileEntity[] = [];
		if (!(await this.vault.adapter.exists(dir))) return entities;
		const listed = await this.vault.adapter.list(dir);
		for (const folder of listed.folders) {
			entities.push({ path: folder, isDirectory: true, size: 0, mtime: 0, hash: "" });
		}
		for (const file of listed.files) {
			const s = await this.vault.adapter.stat(file);
			entities.push({
				path: file,
				isDirectory: false,
				size: s?.size ?? 0,
				mtime: s?.mtime ?? 0,
				hash: "",
			});
		}
		return entities;
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		if (!(await this.vault.adapter.exists(oldPath))) {
			throw new Error(`File not found: ${oldPath}`);
		}
		if (await this.vault.adapter.exists(newPath)) {
			throw new Error(`Destination already exists: ${newPath}`);
		}
		const parentPath = newPath.substring(0, newPath.lastIndexOf("/"));
		if (parentPath && !(await this.vault.adapter.exists(parentPath))) {
			await this.mkdirFn(parentPath);
		}
		const s = await this.vault.adapter.stat(oldPath);
		if (s?.type === "folder") {
			// Rename folder: move all children then remove old folder
			const listed = await this.vault.adapter.list(oldPath);
			await this.mkdirFn(newPath);
			for (const child of [...listed.folders, ...listed.files]) {
				const childNewPath = newPath + child.substring(oldPath.length);
				await this.rename(child, childNewPath);
			}
			await this.vault.adapter.rmdir(oldPath, false);
		} else {
			const content = await this.vault.adapter.readBinary(oldPath);
			await this.vault.adapter.writeBinary(newPath, content, { mtime: s?.mtime });
			await this.vault.adapter.remove(oldPath);
		}
	}
}
