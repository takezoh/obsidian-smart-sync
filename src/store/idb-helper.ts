export interface IDBOpenConfig {
	dbName: string;
	version: number;
	onUpgrade: (db: IDBDatabase, oldVersion: number) => void;
}

/**
 * Shared IndexedDB lifecycle helper.
 * Handles open/close idempotency, onversionchange recovery,
 * and transaction boilerplate.
 */
export class IDBHelper {
	private db: IDBDatabase | null = null;
	private openPromise: Promise<void> | null = null;
	private readonly config: IDBOpenConfig;

	constructor(config: IDBOpenConfig) {
		this.config = config;
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
		const { dbName, version, onUpgrade } = this.config;
		this.db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(dbName, version);
			request.onblocked = () => {
				reject(new Error(`IndexedDB "${dbName}" is blocked by another connection`));
			};
			request.onupgradeneeded = (event) => {
				onUpgrade(request.result, event.oldVersion);
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

	async getDb(): Promise<IDBDatabase> {
		await this.open();
		if (!this.db) {
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

	/**
	 * Run an IndexedDB transaction with automatic promise wrapping.
	 * `fn` receives the transaction, performs IDB operations, and returns
	 * a thunk `() => T` that is called on `tx.oncomplete` to safely read results.
	 */
	async runTransaction<T>(
		storeNames: string | string[],
		mode: IDBTransactionMode,
		fn: (tx: IDBTransaction) => () => T,
	): Promise<T> {
		const db = await this.getDb();
		return new Promise<T>((resolve, reject) => {
			const tx = db.transaction(storeNames, mode);
			const getResult = fn(tx);
			tx.oncomplete = () => resolve(getResult());
			tx.onerror = () =>
				reject(new Error(`Transaction failed: ${tx.error?.message ?? "unknown"}`));
			tx.onabort = () =>
				reject(new Error(`Transaction aborted: ${tx.error?.message ?? "unknown"}`));
		});
	}
}

export function sanitizeDbName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
