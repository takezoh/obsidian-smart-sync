import type { IFileSystem } from "../fs/interface";
import type { FileEntity, SyncRecord } from "../fs/types";
import type { SyncStateStore } from "../sync/state";

/** In-memory mock IFileSystem for unit tests (no hash computation) */
export function createMockFs(name: string): IFileSystem & {
	files: Map<string, { content: ArrayBuffer; entity: FileEntity }>;
} {
	const files = new Map<string, { content: ArrayBuffer; entity: FileEntity }>();
	return {
		name,
		files,
		async list() {
			return Array.from(files.values()).map((f) => f.entity);
		},
		async stat(path: string) {
			const entry = files.get(path);
			return entry?.entity ?? null;
		},
		async read(path: string) {
			const entry = files.get(path);
			if (!entry) throw new Error(`File not found: ${path}`);
			return entry.content;
		},
		async write(path: string, content: ArrayBuffer, mtime: number) {
			const entity: FileEntity = {
				path,
				isDirectory: false,
				size: content.byteLength,
				mtime,
				hash: "",
			};
			files.set(path, { content, entity });
			return entity;
		},
		async mkdir(path: string) {
			return { path, isDirectory: true, size: 0, mtime: Date.now(), hash: "" };
		},
		async delete(path: string) {
			files.delete(path);
		},
		async rename(oldPath: string, newPath: string) {
			const entry = files.get(oldPath);
			if (!entry) throw new Error(`File not found: ${oldPath}`);
			if (files.has(newPath)) throw new Error(`Destination already exists: ${newPath}`);
			files.delete(oldPath);
			entry.entity.path = newPath;
			files.set(newPath, entry);
		},
	};
}

/** In-memory mock SyncStateStore for unit tests */
export function createMockStateStore(): {
	records: Map<string, SyncRecord>;
	contents: Map<string, ArrayBuffer>;
} & SyncStateStore {
	const records = new Map<string, SyncRecord>();
	const contents = new Map<string, ArrayBuffer>();
	return {
		records,
		contents,
		async open() {},
		async close() {},
		async get(path: string) { return records.get(path); },
		async getAll() { return Array.from(records.values()); },
		async put(record: SyncRecord) { records.set(record.path, record); },
		async delete(path: string) { records.delete(path); contents.delete(path); },
		async clear() { records.clear(); contents.clear(); },
		async putContent(path: string, content: ArrayBuffer) { contents.set(path, content); },
		async getContent(path: string) { return contents.get(path); },
	} as unknown as { records: Map<string, SyncRecord>; contents: Map<string, ArrayBuffer> } & SyncStateStore;
}

/** Create a FileEntity + ArrayBuffer pair from text content */
export function makeFile(path: string, content: string, mtime = 1000): { entity: FileEntity; content: ArrayBuffer } {
	const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
	return {
		entity: { path, isDirectory: false, size: buf.byteLength, mtime, hash: "" },
		content: buf,
	};
}

/** Add a file to a mock FS and return its entity */
export function addFile(
	fs: ReturnType<typeof createMockFs>,
	path: string,
	text: string,
	mtime = 1000
): FileEntity {
	const buf = new TextEncoder().encode(text).buffer as ArrayBuffer;
	const entity: FileEntity = { path, isDirectory: false, size: buf.byteLength, mtime, hash: "" };
	fs.files.set(path, { content: buf, entity });
	return entity;
}

/** Read a file from a mock FS as a string */
export function readText(fs: ReturnType<typeof createMockFs>, path: string): string {
	const entry = fs.files.get(path);
	if (!entry) throw new Error(`Not found: ${path}`);
	return new TextDecoder().decode(entry.content);
}
