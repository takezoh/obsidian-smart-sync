import type { IFileSystem } from "../interface";
import type { FileEntity } from "../types";
import { FOLDER_MIME } from "./types";
import type { DriveFile } from "./types";
import type { DriveClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { DriveMetadataCache } from "./metadata-cache";
import { applyIncrementalChanges } from "./incremental-sync";
import { sha256 } from "../../utils/hash";
import { AsyncMutex } from "../../queue/async-queue";

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
	private cache: DriveMetadataCache;

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
		this.cache = new DriveMetadataCache(rootFolderId, logger);
	}

	/** Get the current changes page token to persist between sessions */
	get changesPageToken(): string | null {
		return this._changesPageToken;
	}

	/** Set a previously saved changes page token for incremental sync */
	set changesPageToken(token: string | null) {
		this._changesPageToken = token;
	}

	private async withCacheMutex<TResolved, TResult>(opts: {
		resolve: () => Promise<TResolved> | TResolved;
		execute: (resolved: TResolved) => Promise<TResult>;
		update: (resolved: TResolved, result: TResult) => void;
		staleGuard: (resolved: TResolved) => { path: string; expectedId: string | undefined };
		operationName: string;
	}): Promise<{ resolved: TResolved; result: TResult }> {
		const resolved = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			return opts.resolve();
		});
		const result = await opts.execute(resolved);
		await this.cacheMutex.run(() => {
			const { path, expectedId } = opts.staleGuard(resolved);
			if (expectedId && this.cache.getFile(path)?.id !== expectedId) {
				this.logger?.warn(`Skipping stale cache update for ${opts.operationName}`, { path });
				return;
			}
			opts.update(resolved, result);
		});
		return { resolved, result };
	}

	/** Full scan to build the metadata cache */
	private async fullScan(): Promise<void> {
		this.cache.clear();

		// Get starting page token BEFORE listing to not miss concurrent changes
		this._changesPageToken = await this.client.getChangesStartToken();

		const allFiles = await this.client.listAllFiles(this.rootFolderId);
		this.cache.buildFromFiles(allFiles);

		this.initialized = true;
		this.logger?.info("Full scan completed", { fileCount: this.cache.size });
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
			const storedToken = meta.get("changesStartPageToken");
			if (!storedToken) {
				return false;
			}

			this.cache.clear();
			this.cache.bulkLoad(files.map((r) => [r.path, r.file]));

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
			const records = this.cache.exportRecords();
			const meta = new Map<string, string>();
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

	// Kept for backward compatibility; delegates to getChangedPaths().
	async applyIncrementalChanges(): Promise<{ modified: string[]; deleted: string[] } | null> {
		return this.getChangedPaths();
	}

	/** Internal implementation of applyIncrementalChanges (caller must hold mutex) */
	private async _applyIncrementalChanges(): Promise<{ modified: string[]; deleted: string[] } | null> {
		if (!this.initialized || !this._changesPageToken) {
			await this.fullScan();
			return null;
		}

		const result = await applyIncrementalChanges(
			{
				cache: this.cache,
				client: this.client,
				metadataStore: this.metadataStore,
				logger: this.logger,
			},
			this._changesPageToken,
		);

		if (result.needsFullScan) {
			this.initialized = false;
			await this.fullScan();
			return null;
		}

		this._changesPageToken = result.newToken;

		const modified: string[] = [];
		const deleted: string[] = [];
		for (const path of result.changedPaths) {
			// Note: removeTree() was already called during applyIncrementalChanges(), so
			// deleted paths will correctly be absent from cache here. Edge case: if a path
			// was removed as a descendant of a deleted folder, but a new file with the same
			// path was added in the same batch, it would be misclassified as modified.
			// This is unlikely in practice and does not cause data loss.
			if (this.cache.hasFile(path)) {
				modified.push(path);
			} else {
				deleted.push(path);
			}
		}
		return { modified, deleted };
	}

	/**
	 * Return paths changed since the last sync by applying incremental changes.
	 * Should be called before list(). Returns null if a full scan was needed.
	 */
	async getChangedPaths(): Promise<{ modified: string[]; deleted: string[] } | null> {
		return this.cacheMutex.run(() => this._applyIncrementalChanges());
	}

	async list(): Promise<FileEntity[]> {
		return this.cacheMutex.run(async () => {
			if (!this.initialized) {
				const loaded = await this.loadFromCache();
				if (loaded) {
					await this._applyIncrementalChanges();
				} else {
					await this.fullScan();
				}
			} else if (this._changesPageToken) {
				await this._applyIncrementalChanges();
			}

			const entities: FileEntity[] = [];
			for (const [path, driveFile] of this.cache.entries()) {
				entities.push(this.cache.driveFileToEntity(path, driveFile));
			}
			return entities;
		});
	}

	/**
	 * Return cached metadata for a path.
	 * hash is always "" — the sync engine should use backendMeta.contentChecksum
	 * for content-change detection rather than relying on hash.
	 *
	 * Does not call applyIncrementalChanges here because list() already
	 * applies incremental changes before returning the full file list.
	 * stat() is only called after list() has refreshed the cache.
	 */
	async stat(path: string): Promise<FileEntity | null> {
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();

			const driveFile = this.cache.getFile(path);
			if (!driveFile) return null;

			return this.cache.driveFileToEntity(path, driveFile);
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
			const driveFile = this.cache.getFile(path);
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
		const { result: driveFile } = await this.withCacheMutex({
			operationName: "write",
			resolve: async () => {
				const existingFile = this.cache.getFile(path);
				const existingId = existingFile?.id;
				const fileName = path.split("/").pop()!;
				const parentPath = path.substring(0, path.lastIndexOf("/"));
				const parentId = parentPath
					? await this.ensureFolder(parentPath)
					: this.rootFolderId;
				return { fileName, parentId, existingId };
			},
			execute: (r) => this.client.uploadFile(
				r.fileName, r.parentId, content, "application/octet-stream", r.existingId, mtime
			),
			staleGuard: (r) => ({ path, expectedId: r.existingId }),
			update: (_r, result) => { this.cache.setFile(path, result); },
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
			backendMeta: { driveId: driveFile.id, contentChecksum: driveFile.md5Checksum },
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
			const kids = this.cache.getChildren(path);
			if (!kids) return [];
			const entities: FileEntity[] = [];
			for (const childPath of kids) {
				const driveFile = this.cache.getFile(childPath);
				if (driveFile) {
					entities.push(this.cache.driveFileToEntity(childPath, driveFile));
				}
			}
			return entities;
		});
	}

	async delete(path: string): Promise<void> {
		// Phase 1: resolve fileId under mutex
		const fileId = await this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const driveFile = this.cache.getFile(path);
			if (!driveFile) return null;
			return driveFile.id;
		});

		if (!fileId) return;

		// Phase 2: API delete outside mutex (network I/O)
		await this.client.deleteFile(fileId);

		// Phase 3: update cache under mutex with ID guard
		// (applyIncrementalChanges may have updated the cache during phase 2)
		await this.cacheMutex.run(() => {
			if (this.cache.getFile(path)?.id === fileId) {
				this.cache.removeTree(path);
			} else {
				this.logger?.warn("Skipping stale cache update for delete", { path });
			}
		});
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		await this.withCacheMutex({
			operationName: "rename",
			resolve: async () => {
				const driveFile = this.cache.getFile(oldPath);
				if (!driveFile)
					throw new Error(`File not found: ${oldPath}`);
				if (this.cache.hasFile(newPath))
					throw new Error(`Destination already exists: ${newPath}`);

				const oldName = oldPath.split("/").pop()!;
				const newName = newPath.split("/").pop()!;
				const oldParentPath = oldPath.substring(0, oldPath.lastIndexOf("/"));
				const newParentPath = newPath.substring(0, newPath.lastIndexOf("/"));

				const metadata: { name?: string } = {};
				if (oldName !== newName) metadata.name = newName;

				let addParents: string | undefined;
				let removeParents: string | undefined;
				if (oldParentPath !== newParentPath) {
					addParents = newParentPath
						? await this.ensureFolder(newParentPath)
						: this.rootFolderId;
					removeParents = (driveFile.parents && driveFile.parents.length > 0
						? this.cache.findRelevantParentId(driveFile.parents, { has: (id: string) => this.cache.hasId(id) })
						: undefined)
						?? (oldParentPath
							? this.cache.getFile(oldParentPath)?.id ?? this.rootFolderId
							: this.rootFolderId);
				}

				return {
					fileId: driveFile.id,
					metadata,
					addParents,
					removeParents,
					wasFolder: this.cache.isFolder(oldPath),
				};
			},
			execute: (r) => this.client.updateFileMetadata(
				r.fileId, r.metadata, r.addParents, r.removeParents
			),
			staleGuard: (r) => ({ path: oldPath, expectedId: r.fileId }),
			update: (r, result) => {
				this.cache.removeEntry(oldPath);
				this.cache.setFile(newPath, result);
				if (r.wasFolder) {
					this.cache.rewriteChildPaths(oldPath, newPath);
				}
			},
		});
	}

	/** Ensure a folder exists by path, creating parents as needed */
	private async ensureFolder(path: string): Promise<string> {
		const existing = this.cache.getFile(path);
		if (existing && this.cache.isFolder(path)) {
			return existing.id;
		}

		const parts = path.split("/");
		let currentPath = "";
		let parentId = this.rootFolderId;

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const cached = this.cache.getFile(currentPath);

			if (cached && this.cache.isFolder(currentPath)) {
				parentId = cached.id;
			} else if (cached) {
				throw new Error(`Cannot create directory "${path}": "${currentPath}" is a file`);
			} else {
				// Guard against Google Drive's same-name folder creation:
				// check Drive before creating a potentially duplicate folder
				const existing = await this.client.findChildByName(parentId, part, FOLDER_MIME);
				if (existing) {
					this.cache.setFile(currentPath, existing);
					parentId = existing.id;
				} else {
					const newFolder = await this.client.createFolder(
						part,
						parentId
					);
					this.cache.setFile(currentPath, newFolder);
					parentId = newFolder.id;
				}
			}
		}

		return parentId;
	}

	/** Close the metadata store (call on plugin unload) */
	async close(): Promise<void> {
		await this.metadataStore?.close();
	}
}
