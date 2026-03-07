/** Root folder name created in the backend storage */
export const REMOTE_VAULT_ROOT = "obsidian-smart-sync";

/** Metadata stored in .smartsync/metadata.json inside each remote vault */
export interface RemoteVaultMetadata {
	vaultName: string;
}

/** Result of resolving a remote vault */
export interface RemoteVaultResolution {
	/** Backend-specific data to persist in settings.backendData (e.g., remoteVaultFolderId, lastKnownVaultName) */
	backendUpdates: Record<string, unknown>;
}
