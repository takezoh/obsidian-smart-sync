import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import { sha256 } from "../../utils/hash";
import { normalizeSyncPath, validateRename } from "../../utils/path";

interface MockFile {
	content: ArrayBuffer;
	mtime: number;
	isDirectory: boolean;
}

/** In-memory IFileSystem for testing sync logic without real storage */
export class MockFs implements IFileSystem {
	readonly name: string;
	private files = new Map<string, MockFile>();

	constructor(name = "mock") {
		this.name = name;
	}

	async list(): Promise<FileEntity[]> {
		const entities: FileEntity[] = [];
		for (const [path, file] of this.files) {
			entities.push({
				path,
				isDirectory: file.isDirectory,
				size: file.content.byteLength,
				mtime: file.mtime,
				hash: "",
			});
		}
		return entities;
	}

	async stat(path: string): Promise<FileEntity | null> {
		path = normalizeSyncPath(path);
		const file = this.files.get(path);
		if (!file) return null;
		const hash = file.isDirectory ? "" : await sha256(file.content);
		return {
			path,
			isDirectory: file.isDirectory,
			size: file.content.byteLength,
			mtime: file.mtime,
			hash,
		};
	}

	async read(path: string): Promise<ArrayBuffer> {
		path = normalizeSyncPath(path);
		const file = this.files.get(path);
		if (!file) {
			throw new Error(`File not found: ${path}`);
		}
		if (file.isDirectory) {
			throw new Error(`Not a file (is a directory): ${path}`);
		}
		return file.content.slice(0);
	}

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		const existing = this.files.get(path);
		if (existing?.isDirectory) {
			throw new Error(`Cannot write file: "${path}" is an existing directory`);
		}
		// Ensure parent directories exist
		const parentPath = path.substring(0, path.lastIndexOf("/"));
		if (parentPath) {
			await this.mkdir(parentPath);
		}
		this.files.set(path, {
			content: content.slice(0),
			mtime,
			isDirectory: false,
		});
		const hash = await sha256(content);
		return {
			path,
			isDirectory: false,
			size: content.byteLength,
			mtime,
			hash,
		};
	}

	async mkdir(path: string): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.files.get(current);
			if (existing && !existing.isDirectory) {
				throw new Error(`Cannot create directory "${path}": "${current}" is a file`);
			}
			if (!existing) {
				this.files.set(current, {
					content: new ArrayBuffer(0),
					mtime: 0,
					isDirectory: true,
				});
			}
		}
		return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
	}

	async listDir(path: string): Promise<FileEntity[]> {
		path = normalizeSyncPath(path);
		const prefix = path + "/";
		const entities: FileEntity[] = [];
		for (const [p, file] of this.files) {
			if (p.startsWith(prefix) && !p.substring(prefix.length).includes("/")) {
				entities.push({
					path: p,
					isDirectory: file.isDirectory,
					size: file.content.byteLength,
					mtime: file.mtime,
					hash: "",
				});
			}
		}
		return entities;
	}

	async delete(path: string): Promise<void> {
		path = normalizeSyncPath(path);
		// Delete the path and all children
		const prefix = path + "/";
		const keysToDelete: string[] = [];
		for (const key of this.files.keys()) {
			if (key === path || key.startsWith(prefix)) {
				keysToDelete.push(key);
			}
		}
		for (const key of keysToDelete) {
			this.files.delete(key);
		}
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeSyncPath(oldPath);
		newPath = normalizeSyncPath(newPath);
		validateRename(oldPath, newPath);
		const file = this.files.get(oldPath);
		if (!file) {
			throw new Error(`File not found: ${oldPath}`);
		}
		if (this.files.has(newPath)) {
			throw new Error(`Destination already exists: ${newPath}`);
		}
		// Ensure parent directories exist for the new path
		const parentPath = newPath.substring(0, newPath.lastIndexOf("/"));
		if (parentPath) {
			await this.mkdir(parentPath);
		}
		// Snapshot all entries to move (oldPath itself + children)
		const prefix = oldPath + "/";
		const toMove: [string, MockFile][] = [];
		for (const [key, val] of this.files) {
			if (key === oldPath || key.startsWith(prefix)) {
				toMove.push([key, val]);
			}
		}
		// Delete old entries
		for (const [key] of toMove) {
			this.files.delete(key);
		}
		// Insert under new paths
		for (const [key, val] of toMove) {
			const newKey = key === oldPath ? newPath : newPath + key.substring(oldPath.length);
			this.files.set(newKey, val);
		}
	}

	/** Test helper: seed a file directly */
	seed(path: string, content: string, mtime = Date.now()): void {
		const encoder = new TextEncoder();
		const parentPath = path.substring(0, path.lastIndexOf("/"));
		if (parentPath) {
			const parts = parentPath.split("/");
			let current = "";
			for (const part of parts) {
				current = current ? `${current}/${part}` : part;
				if (!this.files.has(current)) {
					this.files.set(current, {
						content: new ArrayBuffer(0),
						mtime: 0,
						isDirectory: true,
					});
				}
			}
		}
		this.files.set(path, {
			content: encoder.encode(content).buffer.slice(0),
			mtime,
			isDirectory: false,
		});
	}

	/** Test helper: read file as string */
	readString(path: string): string | null {
		const file = this.files.get(path);
		if (!file || file.isDirectory) return null;
		return new TextDecoder().decode(file.content);
	}

	/** Test helper: check if path exists */
	has(path: string): boolean {
		return this.files.has(path);
	}

	/** Test helper: clear all files */
	clear(): void {
		this.files.clear();
	}
}
