import { IDBHelper, sanitizeDbName } from "../store/idb-helper";

/** Root folder name created in the backend storage */
export const REMOTE_VAULT_ROOT = "obsidian-smart-sync";

/** Metadata stored in .smartsync/metadata.json inside each remote vault */
export interface RemoteVaultMetadata {
	vaultName: string;
}

/** Result of resolving a remote vault */
export interface RemoteVaultResolution {
	remoteVaultId: string;
	/** Backend-specific data to persist in settings.backendData (e.g., remoteVaultFolderId) */
	backendUpdates: Record<string, unknown>;
}

const STORE_NAME = "meta";

/** IndexedDB store for remote vault ID and last known vault name */
export class RemoteVaultStore {
	private helper: IDBHelper;

	constructor(vaultId: string) {
		this.helper = new IDBHelper({
			dbName: `smart-sync-rv-${sanitizeDbName(vaultId)}`,
			version: 1,
			onUpgrade: (db) => {
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME, { keyPath: "key" });
				}
			},
		});
	}

	async getRemoteVaultId(): Promise<string | undefined> {
		return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
			const req = tx.objectStore(STORE_NAME).get("remoteVaultId");
			return () => (req.result as { key: string; value: string } | undefined)?.value;
		});
	}

	async getLastKnownVaultName(): Promise<string | undefined> {
		return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
			const req = tx.objectStore(STORE_NAME).get("lastKnownVaultName");
			return () => (req.result as { key: string; value: string } | undefined)?.value;
		});
	}

	async save(remoteVaultId: string, lastKnownVaultName: string): Promise<void> {
		await this.helper.runTransaction(STORE_NAME, "readwrite", (tx) => {
			const store = tx.objectStore(STORE_NAME);
			store.put({ key: "remoteVaultId", value: remoteVaultId });
			store.put({ key: "lastKnownVaultName", value: lastKnownVaultName });
			return () => {};
		});
	}

	async close(): Promise<void> {
		await this.helper.close();
	}
}
