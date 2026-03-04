import type { SyncRecord } from "../fs/types";

const DB_NAME_PREFIX = "smart-sync";
const STORE_NAME = "sync-records";
const CONTENT_STORE_NAME = "sync-content";
const DB_VERSION = 2;

/** Persistent store for sync records using IndexedDB */
export class SyncStateStore {
	private db: IDBDatabase | null = null;
	private openPromise: Promise<void> | null = null;
	private dbName: string;

	constructor(vaultId: string) {
		this.dbName = `${DB_NAME_PREFIX}-${sanitizeDbName(vaultId)}`;
	}

	async open(): Promise<void> {
		if (this.db) return;
		if (this.openPromise) return this.openPromise;
		this.openPromise = this.doOpen();
		try {
			await this.openPromise;
		} catch (err) {
			this.openPromise = null;
			throw err;
		}
	}

	private async doOpen(): Promise<void> {
		this.db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(this.dbName, DB_VERSION);
			request.onblocked = () => {
				reject(new Error(`IndexedDB "${this.dbName}" is blocked by another connection`));
			};
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME, { keyPath: "path" });
				}
				if (!db.objectStoreNames.contains(CONTENT_STORE_NAME)) {
					db.createObjectStore(CONTENT_STORE_NAME, { keyPath: "path" });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(new Error(`Failed to open IndexedDB: ${request.error?.message ?? "unknown"}`));
		});
		this.db.onversionchange = () => {
			this.db?.close();
			this.db = null;
			this.openPromise = null;
		};
	}

	/** Get a valid DB handle, re-opening if closed by onversionchange */
	private async getDb(): Promise<IDBDatabase> {
		await this.open();
		if (!this.db) {
			// onversionchange fired during open — retry once
			this.openPromise = null;
			await this.open();
		}
		if (!this.db) {
			throw new Error("IndexedDB unavailable after re-open attempt");
		}
		return this.db;
	}

	async close(): Promise<void> {
		if (this.openPromise) {
			try {
				await this.openPromise;
			} catch {
				// open failed — nothing to close
			}
		}
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		this.openPromise = null;
	}

	/** Get a sync record by path */
	async get(path: string): Promise<SyncRecord | undefined> {
		const db = await this.getDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readonly");
			const store = tx.objectStore(STORE_NAME);
			const request = store.get(path);
			request.onsuccess = () => resolve(request.result as SyncRecord | undefined);
			request.onerror = () =>
				reject(new Error(`Failed to get record: ${request.error?.message ?? "unknown"}`));
		});
	}

	/** Get all sync records (without prevSyncContent for lightweight listing) */
	async getAll(): Promise<SyncRecord[]> {
		const db = await this.getDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readonly");
			const store = tx.objectStore(STORE_NAME);
			const request = store.getAll();
			request.onsuccess = () => resolve(request.result as SyncRecord[]);
			request.onerror = () =>
				reject(new Error(`Failed to get all records: ${request.error?.message ?? "unknown"}`));
		});
	}

	/** Save or update a sync record */
	async put(record: SyncRecord): Promise<void> {
		const db = await this.getDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readwrite");
			const store = tx.objectStore(STORE_NAME);
			store.put(record);
			tx.oncomplete = () => resolve();
			tx.onerror = () =>
				reject(new Error(`Failed to put record: ${tx.error?.message ?? "unknown"}`));
			tx.onabort = () =>
				reject(new Error(`Transaction aborted: ${tx.error?.message ?? "unknown"}`));
		});
	}

	/** Delete a sync record by path */
	async delete(path: string): Promise<void> {
		const db = await this.getDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite");
			const store = tx.objectStore(STORE_NAME);
			const contentStore = tx.objectStore(CONTENT_STORE_NAME);
			store.delete(path);
			contentStore.delete(path);
			tx.oncomplete = () => resolve();
			tx.onerror = () =>
				reject(new Error(`Failed to delete record: ${tx.error?.message ?? "unknown"}`));
			tx.onabort = () =>
				reject(new Error(`Transaction aborted: ${tx.error?.message ?? "unknown"}`));
		});
	}

	/** Clear all sync records and content */
	async clear(): Promise<void> {
		const db = await this.getDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction([STORE_NAME, CONTENT_STORE_NAME], "readwrite");
			const store = tx.objectStore(STORE_NAME);
			const contentStore = tx.objectStore(CONTENT_STORE_NAME);
			store.clear();
			contentStore.clear();
			tx.oncomplete = () => resolve();
			tx.onerror = () =>
				reject(new Error(`Failed to clear records: ${tx.error?.message ?? "unknown"}`));
			tx.onabort = () =>
				reject(new Error(`Transaction aborted: ${tx.error?.message ?? "unknown"}`));
		});
	}

	/** Store prevSyncContent separately for a path */
	async putContent(path: string, content: ArrayBuffer): Promise<void> {
		const db = await this.getDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(CONTENT_STORE_NAME, "readwrite");
			const store = tx.objectStore(CONTENT_STORE_NAME);
			store.put({ path, content });
			tx.oncomplete = () => resolve();
			tx.onerror = () =>
				reject(new Error(`Failed to put content: ${tx.error?.message ?? "unknown"}`));
			tx.onabort = () =>
				reject(new Error(`Transaction aborted: ${tx.error?.message ?? "unknown"}`));
		});
	}

	/** Get prevSyncContent for a path */
	async getContent(path: string): Promise<ArrayBuffer | undefined> {
		const db = await this.getDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(CONTENT_STORE_NAME, "readonly");
			const store = tx.objectStore(CONTENT_STORE_NAME);
			const request = store.get(path);
			request.onsuccess = () => {
				const result = request.result as { path: string; content: ArrayBuffer } | undefined;
				resolve(result?.content);
			};
			request.onerror = () =>
				reject(new Error(`Failed to get content: ${request.error?.message ?? "unknown"}`));
		});
	}
}

/** Sanitize a vault identifier for use as an IndexedDB name */
function sanitizeDbName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
