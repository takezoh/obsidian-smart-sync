import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import type { DriveFile } from "./types";
import type { DriveClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { sha256 } from "../../utils/hash";
import { AsyncMutex } from "../../queue/async-queue";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * IFileSystem implementation backed by Google Drive.
 * Caches Drive file metadata (path↔ID, modifiedTime, size) to avoid
 * downloading file content during list()/stat(). Uses changes.list
 * for incremental sync after the initial full scan.
 */
export class GoogleDriveFs implements IFileSystem {
	readonly name = "googledrive";
	private client: DriveClient;
	private rootFolderId: string;

	/** Maps relative path → Drive file metadata */
	private pathToFile = new Map<string, DriveFile>();
	/** Maps Drive file ID → relative path */
	private idToPath = new Map<string, string>();
	/** Tracks which paths are folders */
	private folders = new Set<string>();
	/** Parent path → set of direct child paths (for O(k) child lookups) */
	private children = new Map<string, Set<string>>();

	private initialized = false;
	private cacheMutex = new AsyncMutex();
	private metadataStore?: MetadataStore<DriveFile>;
	private logger?: Logger;

	/** Latest changes start page token (for incremental sync) */
	private _changesPageToken: string | null = null;

	constructor(client: DriveClient, rootFolderId: string, logger?: Logger, metadataStore?: MetadataStore<DriveFile>) {
		this.client = client;
		this.rootFolderId = rootFolderId;
		this.logger = logger;
		this.metadataStore = metadataStore;
	}

	/** Extract the parent path from a full path ("" for root-level items) */
	private static parentPath(path: string): string {
		const i = path.lastIndexOf("/");
		return i === -1 ? "" : path.substring(0, i);
	}

	/** Add a path to the children index */
	private addToIndex(path: string): void {
		const parent = GoogleDriveFs.parentPath(path);
		let set = this.children.get(parent);
		if (!set) { set = new Set(); this.children.set(parent, set); }
		set.add(path);
	}

	/** Remove a path from the children index */
	private removeFromIndex(path: string): void {
		const parent = GoogleDriveFs.parentPath(path);
		const set = this.children.get(parent);
		if (set) { set.delete(path); if (set.size === 0) this.children.delete(parent); }
	}

	/** Collect all descendant paths via the children index */
	private collectDescendants(path: string): string[] {
		const result: string[] = [];
		const stack = [path];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			const kids = this.children.get(cur);
			if (kids) for (const c of kids) { result.push(c); stack.push(c); }
		}
		return result;
	}

	/** Get the current changes page token to persist between sessions */
	get changesPageToken(): string | null {
		return this._changesPageToken;
	}

	/** Set a previously saved changes page token for incremental sync */
	set changesPageToken(token: string | null) {
		this._changesPageToken = token;
	}

	/** Full scan to build the metadata cache */
	private async fullScan(): Promise<void> {
		this.pathToFile.clear();
		this.idToPath.clear();
		this.folders.clear();
		this.children.clear();

		// Get starting page token BEFORE listing to not miss concurrent changes
		this._changesPageToken = await this.client.getChangesStartToken();

		const allFiles = await this.client.listAllFiles(this.rootFolderId);

		// Build id→DriveFile lookup
		const byId = new Map<string, DriveFile>();
		for (const file of allFiles) {
			byId.set(file.id, file);
		}

		// Resolve paths with memoization — O(n) instead of O(n×d)
		const resolvedPaths = new Map<string, string>();
		for (const file of allFiles) {
			const path = this.resolveFilePathCached(file, byId, resolvedPaths, new Set());
			this.pathToFile.set(path, file);
			this.idToPath.set(file.id, path);
			if (file.mimeType === FOLDER_MIME) {
				this.folders.add(path);
			}
		}

		// Build children index
		for (const path of this.pathToFile.keys()) {
			this.addToIndex(path);
		}

		this.initialized = true;
		this.logger?.info("Full scan completed", { fileCount: this.pathToFile.size });
		void this.persistCache();
	}

	/** Ensure the metadata cache is initialized (load from IDB or full scan) */
	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			const loaded = await this.loadFromCache();
			if (!loaded) {
				await this.fullScan();
			}
		}
	}

	/** Try to restore cache from IndexedDB. Returns true if successful. */
	private async loadFromCache(): Promise<boolean> {
		if (!this.metadataStore) return false;
		try {
			await this.metadataStore.open();
			const { files, meta } = await this.metadataStore.loadAll();
			const storedRootId = meta.get("rootFolderId");
			const storedToken = meta.get("changesStartPageToken");
			if (storedRootId !== this.rootFolderId || !storedToken) {
				return false;
			}

			this.pathToFile.clear();
			this.idToPath.clear();
			this.folders.clear();
			this.children.clear();

			for (const record of files) {
				this.pathToFile.set(record.path, record.file);
				this.idToPath.set(record.file.id, record.path);
				if (record.isFolder) this.folders.add(record.path);
				this.addToIndex(record.path);
			}

			this._changesPageToken = storedToken;
			this.initialized = true;
			this.logger?.info("Cache loaded from IndexedDB", { fileCount: files.length });
			return true;
		} catch (err) {
			this.logger?.warn("Failed to load cache from IndexedDB, will full scan", {
				message: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	/** Persist the current cache to IndexedDB */
	private async persistCache(): Promise<void> {
		if (!this.metadataStore) return;
		try {
			await this.metadataStore.open();
			const records = [...this.pathToFile.entries()].map(([path, file]) => ({
				path,
				file,
				isFolder: this.folders.has(path),
			}));
			const meta = new Map<string, string>();
			meta.set("rootFolderId", this.rootFolderId);
			if (this._changesPageToken) {
				meta.set("changesStartPageToken", this._changesPageToken);
			}
			await this.metadataStore.saveAll(records, meta);
		} catch (err) {
			this.logger?.warn("Failed to persist cache to IndexedDB", {
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Apply incremental changes from the Drive changes.list API.
	 * Updates the internal metadata cache and returns the new page token.
	 * Falls back to a full re-scan if the cache has been invalidated.
	 */
	async applyIncrementalChanges(): Promise<void> {
		return this.cacheMutex.run(() => this._applyIncrementalChanges());
	}

	/** Internal implementation of applyIncrementalChanges (caller must hold mutex) */
	private async _applyIncrementalChanges(): Promise<void> {
		if (!this.initialized || !this._changesPageToken) {
			await this.fullScan();
			return;
		}

		try {
			let pageToken: string | undefined;

		let totalChanges = 0;
			const updatedRecords: { path: string; file: DriveFile; isFolder: boolean }[] = [];
			const deletedPaths: string[] = [];

			do {
				const result = await this.client.listChanges(
					this._changesPageToken,
					pageToken
				);

				// Process folder changes first (shallow before deep) so paths resolve correctly
				const sorted = [...result.changes].sort((a, b) => {
					const aIsFolder =
						a.file?.mimeType === FOLDER_MIME ? 0 : 1;
					const bIsFolder =
						b.file?.mimeType === FOLDER_MIME ? 0 : 1;
					if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
					// Among folders, sort by cached path depth (shallow first)
					if (aIsFolder === 0) {
						const aPath = this.idToPath.get(a.fileId) ?? "";
						const bPath = this.idToPath.get(b.fileId) ?? "";
						return aPath.split("/").length - bPath.split("/").length;
					}
					return 0;
				});

				totalChanges += sorted.length;
				for (const change of sorted) {
					if (change.removed || change.file?.trashed) {
						const path = this.idToPath.get(change.fileId);
						if (path) {
							// Collect descendants before removing
							deletedPaths.push(path, ...this.collectDescendants(path));
							this.removePath(path);
						}
					} else if (change.file) {
						this.applyFileChange(change.file);
						const updatedPath = this.idToPath.get(change.file.id);
						if (updatedPath) {
							updatedRecords.push({
								path: updatedPath,
								file: change.file,
								isFolder: change.file.mimeType === FOLDER_MIME,
							});
						}
					}
				}

				pageToken = result.nextPageToken;
				if (result.newStartPageToken) {
					this._changesPageToken = result.newStartPageToken;
				}
			} while (pageToken);
			if (totalChanges > 0) {
				this.logger?.info("Incremental changes applied", { changeCount: totalChanges });
				void this.persistIncrementalChanges(updatedRecords, deletedPaths);
			}
		} catch (err) {
			if (isHttpError(err, 410)) {
				// Token expired, fall back to full scan
				this.logger?.info("Changes token expired (410), falling back to full scan");
				this.initialized = false;
				await this.fullScan();
				return;
			}
			throw err;
		}
	}

	/** Persist incremental changes to IndexedDB */
	private async persistIncrementalChanges(
		updated: { path: string; file: DriveFile; isFolder: boolean }[],
		deleted: string[],
	): Promise<void> {
		if (!this.metadataStore) return;
		try {
			if (updated.length > 0) await this.metadataStore.putFiles(updated);
			if (deleted.length > 0) await this.metadataStore.deleteFiles(deleted);
			if (this._changesPageToken) {
				await this.metadataStore.putMeta("changesStartPageToken", this._changesPageToken);
			}
		} catch (err) {
			this.logger?.warn("Failed to persist incremental changes to IndexedDB", {
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/** Apply a single file change to the metadata cache */
	private applyFileChange(file: DriveFile): void {
		const path = this.resolvePathFromCache(file);
		const oldPath = this.idToPath.get(file.id);

		if (!path) {
			// Can't resolve path (moved outside root or parent unknown).
			// Remove stale cache entry if one exists.
			if (oldPath) {
				this.removePath(oldPath);
			}
			return;
		}

		// Remove old mapping if ID was at a different path (rename/move)
		if (oldPath && oldPath !== path) {
			const wasFolder = this.folders.has(oldPath);
			this.removeFromIndex(oldPath);
			this.pathToFile.delete(oldPath);
			this.idToPath.delete(file.id);
			this.folders.delete(oldPath);
			if (wasFolder) {
				this.rewriteChildPaths(oldPath, path);
			}
		}

		this.pathToFile.set(path, file);
		this.idToPath.set(file.id, path);
		this.addToIndex(path);
		if (file.mimeType === FOLDER_MIME) {
			this.folders.add(path);
		} else {
			this.folders.delete(path);
		}
	}

	/**
	 * Find the parent ID that belongs to the sync root tree.
	 * Prefers rootFolderId, then falls back to any parent known in knownIds.
	 */
	private findRelevantParentId(
		parents: string[],
		knownIds: { has(id: string): boolean }
	): string | undefined {
		if (parents.includes(this.rootFolderId)) return this.rootFolderId;
		for (const pid of parents) {
			if (knownIds.has(pid)) return pid;
		}
		return undefined;
	}

	/** Resolve a DriveFile's relative path using the existing cache */
	private resolvePathFromCache(file: DriveFile): string | null {
		if (!file.parents || file.parents.length === 0) return null;

		const parentId = this.findRelevantParentId(file.parents, this.idToPath);
		if (!parentId) return null;
		if (parentId === this.rootFolderId) {
			return file.name;
		}

		const parentPath = this.idToPath.get(parentId);
		if (!parentPath) return null;

		return `${parentPath}/${file.name}`;
	}

	/** Rewrite all cached child paths when a folder is renamed/moved */
	private rewriteChildPaths(oldPath: string, newPath: string): void {
		const oldPrefix = oldPath + "/";
		const descendants = this.collectDescendants(oldPath);
		for (const childPath of descendants) {
			const childFile = this.pathToFile.get(childPath);
			if (!childFile) continue;
			const newChildPath = newPath + "/" + childPath.substring(oldPrefix.length);
			this.removeFromIndex(childPath);
			this.pathToFile.delete(childPath);
			this.pathToFile.set(newChildPath, childFile);
			this.idToPath.set(childFile.id, newChildPath);
			this.addToIndex(newChildPath);
			if (this.folders.delete(childPath)) {
				this.folders.add(newChildPath);
			}
		}
	}

	/** Remove a path and all its children from the cache */
	private removePath(path: string): void {
		const driveFile = this.pathToFile.get(path);
		if (driveFile) {
			this.idToPath.delete(driveFile.id);
		}
		this.removeFromIndex(path);
		this.pathToFile.delete(path);
		this.folders.delete(path);

		// Remove children via index
		const descendants = this.collectDescendants(path);
		for (const p of descendants) {
			const df = this.pathToFile.get(p);
			if (df) this.idToPath.delete(df.id);
			this.removeFromIndex(p);
			this.pathToFile.delete(p);
			this.folders.delete(p);
		}
		// Clean up the parent entry in the children index
		this.children.delete(path);
	}

	/**
	 * Resolve a file's path with memoization.
	 * Already-resolved ancestor paths are reused, cutting complexity from O(n×d) to O(n).
	 */
	private resolveFilePathCached(
		file: DriveFile,
		byId: Map<string, DriveFile>,
		resolvedPaths: Map<string, string>,
		visiting: Set<string>
	): string {
		const cached = resolvedPaths.get(file.id);
		if (cached !== undefined) return cached;

		if (visiting.has(file.id)) {
			console.warn(`Smart Sync: circular parent reference detected for "${file.name}" (id=${file.id}), truncating path`);
			this.logger?.warn("Circular parent reference detected, truncating path", { fileName: file.name, fileId: file.id });
			resolvedPaths.set(file.id, file.name);
			return file.name;
		}

		if (!file.parents || file.parents.length === 0) {
			resolvedPaths.set(file.id, file.name);
			return file.name;
		}

		const parentId = this.findRelevantParentId(file.parents, byId);
		if (!parentId || parentId === this.rootFolderId || parentId === file.id) {
			if (parentId === file.id) {
				console.warn(`Smart Sync: circular parent reference detected for "${file.name}" (id=${file.id}), truncating path`);
				this.logger?.warn("Circular parent reference detected, truncating path", { fileName: file.name, fileId: file.id });
			}
			resolvedPaths.set(file.id, file.name);
			return file.name;
		}

		const parent = byId.get(parentId);
		if (!parent) {
			resolvedPaths.set(file.id, file.name);
			return file.name;
		}

		visiting.add(file.id);
		const parentPath = this.resolveFilePathCached(parent, byId, resolvedPaths, visiting);
		visiting.delete(file.id);

		const fullPath = `${parentPath}/${file.name}`;
		resolvedPaths.set(file.id, fullPath);
		return fullPath;
	}

	/**
	 * Build a FileEntity from cached DriveFile metadata (no download).
	 * hash is always "" because computing it would require downloading the
	 * file content. The sync engine uses backendMeta.md5Checksum instead.
	 */
	private driveFileToEntity(path: string, driveFile: DriveFile): FileEntity {
		if (this.folders.has(path)) {
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		}
		const parsedMtime = driveFile.modifiedTime
			? new Date(driveFile.modifiedTime).getTime()
			: 0;
		return {
			path,
			isDirectory: false,
			size: parseInt(driveFile.size || "0", 10),
			mtime: Number.isNaN(parsedMtime) ? 0 : parsedMtime,
			hash: "",
			backendMeta: {
				driveId: driveFile.id,
				md5Checksum: driveFile.md5Checksum,
			},
		};
	}

	async list(): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			if (!this.initialized) {
				const loaded = await this.loadFromCache();
				if (!loaded) await this.fullScan();
			} else if (this._changesPageToken) {
				await this._applyIncrementalChanges();
			}

			const entities: FileEntity[] = [];
			for (const [path, driveFile] of this.pathToFile) {
				entities.push(this.driveFileToEntity(path, driveFile));
			}
			return entities;
		});
	}

	/**
	 * Return cached metadata for a path.
	 * hash is always "" — the sync engine should use backendMeta.md5Checksum
	 * for content-change detection rather than relying on hash.
	 *
	 * Does not call applyIncrementalChanges here because list() already
	 * applies incremental changes before returning the full file list.
	 * stat() is only called after list() has refreshed the cache.
	 */
	async stat(path: string): Promise<FileEntity | null> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();

			const driveFile = this.pathToFile.get(path);
			if (!driveFile) return null;

			return this.driveFileToEntity(path, driveFile);
		});
	}

	/**
	 * Download file content from Drive.
	 * Like stat(), does not call applyIncrementalChanges — the cache is
	 * kept fresh by list() which is always called first in the sync cycle.
	 */
	async read(path: string): Promise<ArrayBuffer> {
		// Phase 1: resolve fileId under mutex
		const fileId = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const driveFile = this.pathToFile.get(path);
			if (!driveFile) {
				throw new Error(`File not found on Drive: ${path}`);
			}
			return driveFile.id;
		});

		// Phase 2: download outside mutex (network I/O)
		return this.client.downloadFile(fileId);
	}

	async write(
		path: string,
		content: ArrayBuffer,
		mtime: number
	): Promise<FileEntity> {
		// Phase 1: resolve upload arguments under mutex
		// (ensureFolder must stay inside mutex for atomicity)
		const { fileName, parentId, existingId } = await this.cacheMutex.run(
			async () => {
				await this.ensureInitialized();
				const existingFile = this.pathToFile.get(path);
				const eid = existingFile?.id;
				const fname = path.split("/").pop()!;
				const parentPath = path.substring(0, path.lastIndexOf("/"));
				const pid = parentPath
					? await this.ensureFolder(parentPath)
					: this.rootFolderId;
				return { fileName: fname, parentId: pid, existingId: eid };
			}
		);

		// Phase 2: upload outside mutex (network I/O)
		const driveFile = await this.client.uploadFile(
			fileName,
			parentId,
			content,
			"application/octet-stream",
			existingId,
			mtime
		);

		// Phase 3: update cache under mutex with ID guard
		// (applyIncrementalChanges may have updated the cache during phase 2)
		await this.cacheMutex.run(async () => {
			if (existingId && this.pathToFile.get(path)?.id !== existingId) {
				console.warn(`Smart Sync: skipping stale cache update for write("${path}") — ID changed during upload`);
				this.logger?.warn("Skipping stale cache update for write", { path });
				return;
			}
			const isNew = !this.pathToFile.has(path);
			this.pathToFile.set(path, driveFile);
			this.idToPath.set(driveFile.id, path);
			if (isNew) this.addToIndex(path);
		});

		const hash = await sha256(content);
		return {
			path,
			isDirectory: false,
			size: content.byteLength,
			mtime: driveFile.modifiedTime
				? new Date(driveFile.modifiedTime).getTime()
				: 0,
			hash,
			backendMeta: { driveId: driveFile.id, md5Checksum: driveFile.md5Checksum },
		};
	}

	async mkdir(path: string): Promise<FileEntity> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const folderId = await this.ensureFolder(path);
			return {
				path,
				isDirectory: true,
				size: 0,
				mtime: 0,
				hash: "",
				backendMeta: { driveId: folderId },
			};
		});
	}

	async listDir(path: string): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const kids = this.children.get(path);
			if (!kids) return [];
			const entities: FileEntity[] = [];
			for (const childPath of kids) {
				const driveFile = this.pathToFile.get(childPath);
				if (driveFile) {
					entities.push(this.driveFileToEntity(childPath, driveFile));
				}
			}
			return entities;
		});
	}

	async delete(path: string): Promise<void> {
		// Phase 1: resolve fileId under mutex
		const fileId = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const driveFile = this.pathToFile.get(path);
			if (!driveFile) return null;
			return driveFile.id;
		});

		if (!fileId) return;

		// Phase 2: API delete outside mutex (network I/O)
		await this.client.deleteFile(fileId);

		// Phase 3: update cache under mutex with ID guard
		// (applyIncrementalChanges may have updated the cache during phase 2)
		await this.cacheMutex.run(async () => {
			if (this.pathToFile.get(path)?.id === fileId) {
				this.removePath(path);
			} else {
				console.warn(`Smart Sync: skipping stale cache update for delete("${path}") — ID changed during deletion`);
				this.logger?.warn("Skipping stale cache update for delete", { path });
			}
		});
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		// Phase 1: prepare API arguments under mutex
		// (ensureFolder must stay inside mutex for atomicity)
		const { fileId, metadata, addParents, removeParents, wasFolder } =
			await this.cacheMutex.run(async () => {
				await this.ensureInitialized();

				const driveFile = this.pathToFile.get(oldPath);
				if (!driveFile)
					throw new Error(`File not found: ${oldPath}`);
				if (this.pathToFile.has(newPath))
					throw new Error(`Destination already exists: ${newPath}`);

				const oldName = oldPath.split("/").pop()!;
				const newName = newPath.split("/").pop()!;
				const oldParentPath = oldPath.substring(
					0,
					oldPath.lastIndexOf("/")
				);
				const newParentPath = newPath.substring(
					0,
					newPath.lastIndexOf("/")
				);

				const meta: { name?: string } = {};
				if (oldName !== newName) meta.name = newName;

				let addP: string | undefined;
				let removeP: string | undefined;
				if (oldParentPath !== newParentPath) {
					addP = newParentPath
						? await this.ensureFolder(newParentPath)
						: this.rootFolderId;
					removeP = (driveFile.parents && driveFile.parents.length > 0
						? this.findRelevantParentId(driveFile.parents, this.idToPath)
						: undefined)
						?? (oldParentPath
							? this.pathToFile.get(oldParentPath)?.id ?? this.rootFolderId
							: this.rootFolderId);
				}

				return {
					fileId: driveFile.id,
					metadata: meta,
					addParents: addP,
					removeParents: removeP,
					wasFolder: this.folders.has(oldPath),
				};
			});

		// Phase 2: API call outside mutex (network I/O)
		const updated = await this.client.updateFileMetadata(
			fileId,
			metadata,
			addParents,
			removeParents
		);

		// Phase 3: update cache under mutex with ID guard
		// (applyIncrementalChanges may have updated the cache during phase 2)
		await this.cacheMutex.run(async () => {
			if (this.pathToFile.get(oldPath)?.id !== fileId) {
				console.warn(`Smart Sync: skipping stale cache update for rename("${oldPath}" → "${newPath}") — ID changed during rename`);
				this.logger?.warn("Skipping stale cache update for rename", { oldPath, newPath });
				return;
			}

			this.removeFromIndex(oldPath);
			this.pathToFile.delete(oldPath);
			this.idToPath.delete(fileId);
			this.folders.delete(oldPath);
			this.pathToFile.set(newPath, updated);
			this.idToPath.set(updated.id, newPath);
			this.addToIndex(newPath);
			if (wasFolder) {
				this.folders.add(newPath);
				this.rewriteChildPaths(oldPath, newPath);
			}
		});
	}

	/** Ensure a folder exists by path, creating parents as needed */
	private async ensureFolder(path: string): Promise<string> {
		const existing = this.pathToFile.get(path);
		if (existing && this.folders.has(path)) {
			return existing.id;
		}

		const parts = path.split("/");
		let currentPath = "";
		let parentId = this.rootFolderId;

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const cached = this.pathToFile.get(currentPath);

			if (cached && this.folders.has(currentPath)) {
				parentId = cached.id;
			} else if (cached) {
				throw new Error(`Cannot create directory "${path}": "${currentPath}" is a file`);
			} else {
				const newFolder = await this.client.createFolder(
					part,
					parentId
				);
				this.pathToFile.set(currentPath, newFolder);
				this.idToPath.set(newFolder.id, currentPath);
				this.folders.add(currentPath);
				this.addToIndex(currentPath);
				parentId = newFolder.id;
			}
		}

		return parentId;
	}

	/** Force re-initialization on next operation */
	invalidateCache(): void {
		this.initialized = false;
		void this.metadataStore?.clear();
	}

	/** Close the metadata store (call on plugin unload) */
	async close(): Promise<void> {
		await this.metadataStore?.close();
	}
}

/** Check if an error is an HTTP error with the given status code */
function isHttpError(err: unknown, status: number): boolean {
	if (err && typeof err === "object" && "status" in err) {
		return (err as { status: number }).status === status;
	}
	return false;
}
