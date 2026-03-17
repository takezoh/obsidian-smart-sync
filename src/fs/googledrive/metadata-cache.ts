import type { FileEntity } from "../types";
import type { DriveFile } from "./types";
import { FOLDER_MIME } from "./types";
import type { Logger } from "../../logging/logger";

/**
 * In-memory metadata cache for Google Drive files.
 * Maintains path↔ID mappings, folder tracking, and parent→children index.
 */
export class DriveMetadataCache {
	/** Maps relative path → Drive file metadata */
	private pathToFile = new Map<string, DriveFile>();
	/** Maps Drive file ID → relative path */
	private idToPath = new Map<string, string>();
	/** Tracks which paths are folders */
	private folders = new Set<string>();
	/** Parent path → set of direct child paths (for O(k) child lookups) */
	private children = new Map<string, Set<string>>();

	private rootFolderId: string;
	private logger?: Logger;

	constructor(rootFolderId: string, logger?: Logger) {
		this.rootFolderId = rootFolderId;
		this.logger = logger;
	}

	// ── Query methods ──

	getFile(path: string): DriveFile | undefined { return this.pathToFile.get(path); }
	hasFile(path: string): boolean { return this.pathToFile.has(path); }
	isFolder(path: string): boolean { return this.folders.has(path); }
	getPathById(id: string): string | undefined { return this.idToPath.get(id); }
	hasId(id: string): boolean { return this.idToPath.has(id); }
	getChildren(path: string): ReadonlySet<string> | undefined { return this.children.get(path); }
	get size(): number { return this.pathToFile.size; }
	entries(): IterableIterator<[string, DriveFile]> { return this.pathToFile.entries(); }

	// ── Mutation methods ──

	/** Add or update a file in the cache with full index maintenance */
	setFile(path: string, file: DriveFile): void {
		const isNew = !this.pathToFile.has(path);
		this.pathToFile.set(path, file);
		this.idToPath.set(file.id, path);
		if (file.mimeType === FOLDER_MIME) {
			this.folders.add(path);
		}
		if (isNew) this.addToIndex(path);
	}

	/** Remove a single entry from pathToFile/idToPath/folders and the children index */
	removeEntry(path: string): void {
		const driveFile = this.pathToFile.get(path);
		if (driveFile) this.idToPath.delete(driveFile.id);
		this.removeFromIndex(path);
		this.pathToFile.delete(path);
		this.folders.delete(path);
	}

	/** Bulk-load files from a fullScan (clears existing data first) */
	bulkLoad(items: Iterable<[string, DriveFile]>): void {
		for (const [path, file] of items) {
			this.pathToFile.set(path, file);
			this.idToPath.set(file.id, path);
			if (file.mimeType === FOLDER_MIME) {
				this.folders.add(path);
			}
		}
		for (const path of this.pathToFile.keys()) {
			this.addToIndex(path);
		}
	}

	/** Return a snapshot of all records for persistence */
	exportRecords(): { path: string; file: DriveFile; isFolder: boolean }[] {
		return [...this.pathToFile.entries()].map(([path, file]) => ({
			path,
			file,
			isFolder: this.folders.has(path),
		}));
	}

	/** Extract the parent path from a full path ("" for root-level items) */
	static parentPath(path: string): string {
		const i = path.lastIndexOf("/");
		return i === -1 ? "" : path.substring(0, i);
	}

	/** Clear all cached data */
	clear(): void {
		this.pathToFile.clear();
		this.idToPath.clear();
		this.folders.clear();
		this.children.clear();
	}

	/** Add a path to the children index */
	private addToIndex(path: string): void {
		const parent = DriveMetadataCache.parentPath(path);
		let set = this.children.get(parent);
		if (!set) { set = new Set(); this.children.set(parent, set); }
		set.add(path);
	}

	/** Remove a path from the children index */
	private removeFromIndex(path: string): void {
		const parent = DriveMetadataCache.parentPath(path);
		const set = this.children.get(parent);
		if (set) { set.delete(path); if (set.size === 0) this.children.delete(parent); }
	}

	/** Collect all descendant paths via the children index */
	collectDescendants(path: string): string[] {
		const result: string[] = [];
		const stack = [path];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			const kids = this.children.get(cur);
			if (kids) for (const c of kids) { result.push(c); stack.push(c); }
		}
		return result;
	}

	/**
	 * Find the parent ID that belongs to the sync root tree.
	 * Prefers rootFolderId, then falls back to any parent known in knownIds.
	 */
	findRelevantParentId(
		parents: string[],
		knownIds: { has(id: string): boolean }
	): string | undefined {
		if (parents.includes(this.rootFolderId)) return this.rootFolderId;
		for (const pid of parents) {
			if (knownIds.has(pid)) return pid;
		}
		return undefined;
	}

	/**
	 * Build the cache from a flat list of DriveFiles (as returned by listAllFiles).
	 * Resolves paths with memoization and bulk-loads into the cache.
	 */
	buildFromFiles(files: DriveFile[]): void {
		const byId = new Map<string, DriveFile>();
		for (const file of files) {
			byId.set(file.id, file);
		}

		const resolvedPaths = new Map<string, string>();
		const resolved: [string, DriveFile][] = [];
		for (const file of files) {
			const path = this.resolveFilePathCached(file, byId, resolvedPaths, new Set());
			resolved.push([path, file]);
		}

		this.bulkLoad(resolved);
	}

	/** Resolve a DriveFile's relative path using the existing cache */
	resolvePathFromCache(file: DriveFile): string | null {
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

	/**
	 * Resolve a file's path with memoization.
	 * Already-resolved ancestor paths are reused, cutting complexity from O(n×d) to O(n).
	 */
	resolveFilePathCached(
		file: DriveFile,
		byId: Map<string, DriveFile>,
		resolvedPaths: Map<string, string>,
		visiting: Set<string>
	): string {
		const cached = resolvedPaths.get(file.id);
		if (cached !== undefined) return cached;

		if (visiting.has(file.id)) {
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

	/** Rewrite all cached child paths when a folder is renamed/moved */
	rewriteChildPaths(oldPath: string, newPath: string): void {
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

	/** Remove an entry and all its descendants from the cache */
	removeTree(path: string): void {
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
	 * Build a FileEntity from cached DriveFile metadata (no download).
	 * hash is always "" because computing it would require downloading the
	 * file content. The sync engine uses backendMeta.contentChecksum instead.
	 */
	driveFileToEntity(path: string, driveFile: DriveFile): FileEntity {
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
				contentChecksum: driveFile.md5Checksum,
			},
		};
	}

	/** Apply a single file change to the metadata cache */
	applyFileChange(file: DriveFile): void {
		const path = this.resolvePathFromCache(file);
		const oldPath = this.idToPath.get(file.id);

		if (!path) {
			// Can't resolve path (moved outside root or parent unknown).
			// Remove stale cache entry if one exists.
			if (oldPath) {
				this.removeTree(oldPath);
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
}
