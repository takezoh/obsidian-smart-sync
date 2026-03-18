import type { DriveClient } from "./client";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution, RemoteVaultMetadata } from "../../sync/remote-vault";
import { REMOTE_VAULT_ROOT } from "../../sync/remote-vault";
import { FOLDER_MIME } from "./types";

const AIRSYNC_DIR = ".airsync";
const METADATA_FILE = "metadata.json";

/**
 * Resolve or create a remote vault folder in Google Drive.
 *
 * Layout: Drive root / obsidian-air-sync / {uuid} / .airsync/metadata.json
 *
 * The cached folder ID and last known vault name are read from settings.backendData
 * by the caller (GoogleDriveProvider).
 */
export async function resolveGDriveRemoteVault(
	client: DriveClient,
	vaultName: string,
	cachedFolderId: string | undefined,
	logger?: Logger,
): Promise<RemoteVaultResolution> {
	// 1. If we have a cached folder ID, verify it still exists
	if (cachedFolderId) {
		return resolveLinked(client, cachedFolderId, vaultName, logger);
	}

	// 2. Find or create the root "obsidian-air-sync" folder
	const rootFolder = await findOrCreateFolder(client, "root", REMOTE_VAULT_ROOT);
	logger?.debug("Remote vault root folder", { id: rootFolder.id });

	// 3. Search for matching vault or create new one
	return resolveNew(client, rootFolder.id, vaultName, logger);
}

async function resolveLinked(
	client: DriveClient,
	cachedFolderId: string,
	vaultName: string,
	logger?: Logger,
): Promise<RemoteVaultResolution> {
	// Verify the cached folder still exists
	try {
		await client.getFile(cachedFolderId);
	} catch {
		throw new Error(
			"Remote vault folder was deleted from Google Drive. " +
			"Please disconnect and reconnect to create a new remote vault."
		);
	}

	// Update metadata.json if vault name changed
	await updateMetadataIfNeeded(client, cachedFolderId, vaultName, logger);

	return {
		backendUpdates: { remoteVaultFolderId: cachedFolderId, lastKnownVaultName: vaultName },
	};
}

async function resolveNew(
	client: DriveClient,
	rootFolderId: string,
	vaultName: string,
	logger?: Logger,
): Promise<RemoteVaultResolution> {
	// List all child folders under obsidian-air-sync
	const children = await client.listFiles(rootFolderId);
	const folders = children.files.filter((f) => f.mimeType === FOLDER_MIME);

	// Check each folder's metadata.json for a matching vaultName
	for (const folder of folders) {
		const metadata = await readMetadata(client, folder.id);
		if (metadata && metadata.vaultName === vaultName) {
			logger?.info("Found existing remote vault", { folderId: folder.id, vaultName });
			return {
				backendUpdates: { remoteVaultFolderId: folder.id, lastKnownVaultName: vaultName },
			};
		}
	}

	// No match — create a new remote vault
	const remoteVaultId = crypto.randomUUID();
	logger?.info("Creating new remote vault", { id: remoteVaultId, vaultName });

	const vaultFolder = await client.createFolder(remoteVaultId, rootFolderId);
	const airsyncFolder = await client.createFolder(AIRSYNC_DIR, vaultFolder.id);
	await writeMetadata(client, airsyncFolder.id, { vaultName });

	return {
		backendUpdates: { remoteVaultFolderId: vaultFolder.id, lastKnownVaultName: vaultName },
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
	const airsyncFolder = await client.findChildByName(vaultFolderId, AIRSYNC_DIR, FOLDER_MIME);
	if (!airsyncFolder) return null;

	const metaFile = await client.findChildByName(airsyncFolder.id, METADATA_FILE);
	if (!metaFile) return null;

	const content = await client.downloadFile(metaFile.id);
	const text = new TextDecoder().decode(content);
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || !("vaultName" in parsed)) return null;
	return parsed as RemoteVaultMetadata;
}

async function writeMetadata(
	client: DriveClient,
	airsyncFolderId: string,
	metadata: RemoteVaultMetadata,
): Promise<void> {
	const content = new TextEncoder().encode(JSON.stringify(metadata)).buffer.slice(0);
	await client.uploadFile(METADATA_FILE, airsyncFolderId, content, "application/json");
}

async function updateMetadataIfNeeded(
	client: DriveClient,
	vaultFolderId: string,
	vaultName: string,
	logger?: Logger,
): Promise<void> {
	const airsyncFolder = await client.findChildByName(vaultFolderId, AIRSYNC_DIR, FOLDER_MIME);
	if (!airsyncFolder) {
		const newFolder = await client.createFolder(AIRSYNC_DIR, vaultFolderId);
		await writeMetadata(client, newFolder.id, { vaultName });
		logger?.info("Created missing metadata.json", { vaultName });
		return;
	}

	const metaFile = await client.findChildByName(airsyncFolder.id, METADATA_FILE);
	if (!metaFile) {
		await writeMetadata(client, airsyncFolder.id, { vaultName });
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
	const newContent = new TextEncoder().encode(JSON.stringify({ vaultName })).buffer.slice(0);
	await client.uploadFile(METADATA_FILE, airsyncFolder.id, newContent, "application/json", metaFile.id);
	logger?.info("Updated metadata.json vault name", { vaultName });
}
