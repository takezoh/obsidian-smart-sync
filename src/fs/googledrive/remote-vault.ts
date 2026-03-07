import type { DriveClient } from "./client";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution, RemoteVaultMetadata } from "../../sync/remote-vault";
import { REMOTE_VAULT_ROOT } from "../../sync/remote-vault";
import { FOLDER_MIME } from "./types";

const SMARTSYNC_DIR = ".smartsync";
const METADATA_FILE = "metadata.json";

/**
 * Resolve or create a remote vault folder in Google Drive.
 *
 * Layout: Drive root / obsidian-smart-sync / {remoteVaultId} / .smartsync/metadata.json
 */
export async function resolveGDriveRemoteVault(
	client: DriveClient,
	vaultName: string,
	cachedRemoteVaultId: string | undefined,
	logger?: Logger,
): Promise<RemoteVaultResolution> {
	// 1. Find or create the root "obsidian-smart-sync" folder
	const rootFolder = await findOrCreateFolder(client, "root", REMOTE_VAULT_ROOT);
	logger?.debug("Remote vault root folder", { id: rootFolder.id });

	// 2a. Cached path: linked device
	if (cachedRemoteVaultId) {
		return resolveLinked(client, rootFolder.id, cachedRemoteVaultId, vaultName, logger);
	}

	// 2b. Uncached path: new device — search for matching vault
	return resolveNew(client, rootFolder.id, vaultName, logger);
}

async function resolveLinked(
	client: DriveClient,
	rootFolderId: string,
	cachedRemoteVaultId: string,
	vaultName: string,
	logger?: Logger,
): Promise<RemoteVaultResolution> {
	// Find the vault folder by its UUID name
	const vaultFolder = await client.findChildByName(rootFolderId, cachedRemoteVaultId, FOLDER_MIME);
	if (!vaultFolder) {
		throw new Error(
			`Remote vault folder "${cachedRemoteVaultId}" was deleted from Google Drive. ` +
			"Please disconnect and reconnect to create a new remote vault."
		);
	}

	// Update metadata.json if vault name changed
	await updateMetadataIfNeeded(client, vaultFolder.id, vaultName, logger);

	return {
		remoteVaultId: cachedRemoteVaultId,
		backendUpdates: { remoteVaultFolderId: vaultFolder.id },
	};
}

async function resolveNew(
	client: DriveClient,
	rootFolderId: string,
	vaultName: string,
	logger?: Logger,
): Promise<RemoteVaultResolution> {
	// List all child folders under obsidian-smart-sync
	const children = await client.listFiles(rootFolderId);
	const folders = children.files.filter((f) => f.mimeType === FOLDER_MIME);

	// Check each folder's metadata.json for a matching vaultName
	for (const folder of folders) {
		const metadata = await readMetadata(client, folder.id);
		if (metadata && metadata.vaultName === vaultName) {
			logger?.info("Found existing remote vault", { id: folder.name, vaultName });
			return {
				remoteVaultId: folder.name,
				backendUpdates: { remoteVaultFolderId: folder.id },
			};
		}
	}

	// No match — create a new remote vault
	const remoteVaultId = crypto.randomUUID();
	logger?.info("Creating new remote vault", { id: remoteVaultId, vaultName });

	const vaultFolder = await client.createFolder(remoteVaultId, rootFolderId);
	const smartsyncFolder = await client.createFolder(SMARTSYNC_DIR, vaultFolder.id);
	await writeMetadata(client, smartsyncFolder.id, { vaultName });

	return {
		remoteVaultId,
		backendUpdates: { remoteVaultFolderId: vaultFolder.id },
	};
}

async function findOrCreateFolder(
	client: DriveClient,
	parentId: string,
	name: string,
): Promise<{ id: string }> {
	const existing = await client.findChildByName(parentId, name, FOLDER_MIME);
	if (existing) return existing;
	return client.createFolder(name, parentId);
}

async function readMetadata(
	client: DriveClient,
	vaultFolderId: string,
): Promise<RemoteVaultMetadata | null> {
	const smartsyncFolder = await client.findChildByName(vaultFolderId, SMARTSYNC_DIR, FOLDER_MIME);
	if (!smartsyncFolder) return null;

	const metaFile = await client.findChildByName(smartsyncFolder.id, METADATA_FILE);
	if (!metaFile) return null;

	const content = await client.downloadFile(metaFile.id);
	const text = new TextDecoder().decode(content);
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || !("vaultName" in parsed)) return null;
	return parsed as RemoteVaultMetadata;
}

async function writeMetadata(
	client: DriveClient,
	smartsyncFolderId: string,
	metadata: RemoteVaultMetadata,
): Promise<void> {
	const content = new TextEncoder().encode(JSON.stringify(metadata)).buffer as ArrayBuffer;
	await client.uploadFile(METADATA_FILE, smartsyncFolderId, content, "application/json");
}

async function updateMetadataIfNeeded(
	client: DriveClient,
	vaultFolderId: string,
	vaultName: string,
	logger?: Logger,
): Promise<void> {
	const smartsyncFolder = await client.findChildByName(vaultFolderId, SMARTSYNC_DIR, FOLDER_MIME);
	if (!smartsyncFolder) {
		const newFolder = await client.createFolder(SMARTSYNC_DIR, vaultFolderId);
		await writeMetadata(client, newFolder.id, { vaultName });
		logger?.info("Created missing metadata.json", { vaultName });
		return;
	}

	const metaFile = await client.findChildByName(smartsyncFolder.id, METADATA_FILE);
	if (!metaFile) {
		await writeMetadata(client, smartsyncFolder.id, { vaultName });
		logger?.info("Created missing metadata.json", { vaultName });
		return;
	}

	// Read existing and compare
	const content = await client.downloadFile(metaFile.id);
	const text = new TextDecoder().decode(content);
	const parsed: unknown = JSON.parse(text);
	if (
		parsed && typeof parsed === "object" && "vaultName" in parsed &&
		(parsed as RemoteVaultMetadata).vaultName === vaultName
	) {
		return; // No update needed
	}

	// Update metadata.json with new vault name
	const newContent = new TextEncoder().encode(JSON.stringify({ vaultName })).buffer as ArrayBuffer;
	await client.uploadFile(METADATA_FILE, smartsyncFolder.id, newContent, "application/json", metaFile.id);
	logger?.info("Updated metadata.json vault name", { vaultName });
}
