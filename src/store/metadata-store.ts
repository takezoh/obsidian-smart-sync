import { IDBHelper, sanitizeDbName } from "./idb-helper";

const FILES_STORE = "files";
const META_STORE = "meta";

export interface FileRecord<T> {
	path: string;
	file: T;
	isFolder: boolean;
}

export interface MetadataStoreConfig {
	dbNamePrefix: string;
	version: number;
}

/** Persistent IndexedDB store for backend file metadata cache */
export class MetadataStore<T> {
	private helper: IDBHelper;

	constructor(vaultId: string, config: MetadataStoreConfig) {
		this.helper = new IDBHelper({
			dbName: `${config.dbNamePrefix}-${sanitizeDbName(vaultId)}`,
			version: config.version,
			onUpgrade: (db) => {
				if (!db.objectStoreNames.contains(FILES_STORE)) {
					db.createObjectStore(FILES_STORE, { keyPath: "path" });
				}
				if (!db.objectStoreNames.contains(META_STORE)) {
					db.createObjectStore(META_STORE, { keyPath: "key" });
				}
			},
		});
	}

	async open(): Promise<void> {
		await this.helper.open();
	}

	async close(): Promise<void> {
		await this.helper.close();
	}

	/** Load all file records and meta entries */
	async loadAll(): Promise<{ files: FileRecord<T>[]; meta: Map<string, string> }> {
		return this.helper.runTransaction([FILES_STORE, META_STORE], "readonly", (tx) => {
			const filesReq = tx.objectStore(FILES_STORE).getAll();
			const metaReq = tx.objectStore(META_STORE).getAll();
			return () => {
				const files = filesReq.result as FileRecord<T>[];
				const metaEntries = metaReq.result as { key: string; value: string }[];
				const meta = new Map<string, string>();
				for (const entry of metaEntries) {
					meta.set(entry.key, entry.value);
				}
				return { files, meta };
			};
		});
	}

	/** Clear and bulk-write all records + meta (used after fullScan) */
	async saveAll(files: FileRecord<T>[], meta: Map<string, string>): Promise<void> {
		await this.helper.runTransaction([FILES_STORE, META_STORE], "readwrite", (tx) => {
			const filesStore = tx.objectStore(FILES_STORE);
			const metaStore = tx.objectStore(META_STORE);
			filesStore.clear();
			metaStore.clear();
			for (const record of files) {
				filesStore.put(record);
			}
			for (const [key, value] of meta) {
				metaStore.put({ key, value });
			}
			return () => {};
		});
	}

	/** Upsert file records (used after incremental changes) */
	async putFiles(records: FileRecord<T>[]): Promise<void> {
		await this.helper.runTransaction(FILES_STORE, "readwrite", (tx) => {
			const store = tx.objectStore(FILES_STORE);
			for (const record of records) {
				store.put(record);
			}
			return () => {};
		});
	}

	/** Delete file records by path (used after incremental changes) */
	async deleteFiles(paths: string[]): Promise<void> {
		await this.helper.runTransaction(FILES_STORE, "readwrite", (tx) => {
			const store = tx.objectStore(FILES_STORE);
			for (const path of paths) {
				store.delete(path);
			}
			return () => {};
		});
	}

	/** Update a single meta entry */
	async putMeta(key: string, value: string): Promise<void> {
		await this.helper.runTransaction(META_STORE, "readwrite", (tx) => {
			tx.objectStore(META_STORE).put({ key, value });
			return () => {};
		});
	}

	/** Clear all stores */
	async clear(): Promise<void> {
		await this.helper.runTransaction([FILES_STORE, META_STORE], "readwrite", (tx) => {
			tx.objectStore(FILES_STORE).clear();
			tx.objectStore(META_STORE).clear();
			return () => {};
		});
	}
}
