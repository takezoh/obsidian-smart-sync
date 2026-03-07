import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGDriveRemoteVault } from "./remote-vault";
import { REMOTE_VAULT_ROOT } from "../../sync/remote-vault";
import { FOLDER_MIME } from "./types";
import type { DriveFile } from "./types";
import type { DriveClient } from "./client";

vi.mock("obsidian");

function makeDriveFile(overrides: Partial<DriveFile> & { id: string; name: string }): DriveFile {
	return { mimeType: "application/octet-stream", ...overrides };
}

function makeFolder(id: string, name: string): DriveFile {
	return makeDriveFile({ id, name, mimeType: FOLDER_MIME });
}

function createMockClient(): {
	client: DriveClient;
	findChildByName: ReturnType<typeof vi.fn>;
	createFolder: ReturnType<typeof vi.fn>;
	listFiles: ReturnType<typeof vi.fn>;
	downloadFile: ReturnType<typeof vi.fn>;
	uploadFile: ReturnType<typeof vi.fn>;
	getFile: ReturnType<typeof vi.fn>;
} {
	const findChildByName = vi.fn();
	const createFolder = vi.fn();
	const listFiles = vi.fn();
	const downloadFile = vi.fn();
	const uploadFile = vi.fn();
	const getFile = vi.fn();

	const client = {
		findChildByName,
		createFolder,
		listFiles,
		downloadFile,
		uploadFile,
		getFile,
	} as unknown as DriveClient;

	return { client, findChildByName, createFolder, listFiles, downloadFile, uploadFile, getFile };
}

describe("resolveGDriveRemoteVault", () => {
	let mock: ReturnType<typeof createMockClient>;

	beforeEach(() => {
		mock = createMockClient();
		vi.spyOn(crypto, "randomUUID").mockReturnValue("test-uuid-1234" as `${string}-${string}-${string}-${string}-${string}`);
	});

	describe("first-time setup (no cached ID, no existing vaults)", () => {
		it("creates root folder, vault folder, .smartsync, and metadata.json", async () => {
			// Root folder doesn't exist
			mock.findChildByName.mockResolvedValueOnce(null);
			// Create root folder
			mock.createFolder.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// List children of root (empty)
			mock.listFiles.mockResolvedValueOnce({ files: [] });
			// Create vault folder
			mock.createFolder.mockResolvedValueOnce(makeFolder("vault-folder-id", "test-uuid-1234"));
			// Create .smartsync folder
			mock.createFolder.mockResolvedValueOnce(makeFolder("smartsync-folder-id", ".smartsync"));
			// Upload metadata.json
			mock.uploadFile.mockResolvedValueOnce(makeDriveFile({ id: "meta-file-id", name: "metadata.json" }));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.remoteVaultId).toBe("test-uuid-1234");
			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "vault-folder-id" });

			// Verify root folder lookup
			expect(mock.findChildByName).toHaveBeenCalledWith("root", REMOTE_VAULT_ROOT, FOLDER_MIME);
			// Verify folders created
			expect(mock.createFolder).toHaveBeenCalledWith(REMOTE_VAULT_ROOT, "root");
			expect(mock.createFolder).toHaveBeenCalledWith("test-uuid-1234", "root-folder-id");
			expect(mock.createFolder).toHaveBeenCalledWith(".smartsync", "vault-folder-id");
			// Verify metadata written
			expect(mock.uploadFile).toHaveBeenCalledWith(
				"metadata.json", "smartsync-folder-id",
				expect.any(ArrayBuffer), "application/json"
			);
		});
	});

	describe("first-time setup with existing matching vault", () => {
		it("finds and links to existing vault by vaultName", async () => {
			// Root folder exists
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// List children — one existing vault
			const existingVault = makeFolder("existing-vault-folder-id", "existing-uuid");
			mock.listFiles.mockResolvedValueOnce({ files: [existingVault] });
			// Find .smartsync in vault
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".smartsync"));
			// Find metadata.json
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: "metadata.json" }));
			// Download metadata.json
			const metaContent = new TextEncoder().encode(JSON.stringify({ vaultName: "My Vault" }));
			mock.downloadFile.mockResolvedValueOnce(metaContent.buffer);

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.remoteVaultId).toBe("existing-uuid");
			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "existing-vault-folder-id" });
		});
	});

	describe("reconnect with cached ID", () => {
		it("reuses existing vault folder", async () => {
			// Root folder exists
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// Find vault folder by cached ID
			mock.findChildByName.mockResolvedValueOnce(makeFolder("vault-folder-id", "cached-uuid"));
			// Find .smartsync
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".smartsync"));
			// Find metadata.json
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: "metadata.json" }));
			// Download metadata — same vault name
			const metaContent = new TextEncoder().encode(JSON.stringify({ vaultName: "My Vault" }));
			mock.downloadFile.mockResolvedValueOnce(metaContent.buffer);

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", "cached-uuid");

			expect(result.remoteVaultId).toBe("cached-uuid");
			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "vault-folder-id" });
		});

		it("throws when cached vault folder was deleted", async () => {
			// Root folder exists
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// Vault folder not found
			mock.findChildByName.mockResolvedValueOnce(null);

			await expect(
				resolveGDriveRemoteVault(mock.client, "My Vault", "deleted-uuid")
			).rejects.toThrow("was deleted from Google Drive");
		});
	});

	describe("vault name change", () => {
		it("updates metadata.json when vault name differs", async () => {
			// Root folder exists
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// Find vault folder
			mock.findChildByName.mockResolvedValueOnce(makeFolder("vault-folder-id", "cached-uuid"));
			// Find .smartsync
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".smartsync"));
			// Find metadata.json
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: "metadata.json" }));
			// Download metadata — old vault name
			const metaContent = new TextEncoder().encode(JSON.stringify({ vaultName: "Old Name" }));
			mock.downloadFile.mockResolvedValueOnce(metaContent.buffer);
			// Upload updated metadata
			mock.uploadFile.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: "metadata.json" }));

			const result = await resolveGDriveRemoteVault(mock.client, "New Name", "cached-uuid");

			expect(result.remoteVaultId).toBe("cached-uuid");
			// Verify metadata was updated (uploadFile called with existingFileId)
			expect(mock.uploadFile).toHaveBeenCalledWith(
				"metadata.json", "ss-id",
				expect.any(ArrayBuffer), "application/json", "meta-id"
			);
		});
	});

	describe("no match creates new vault", () => {
		it("creates new vault when existing vaults have different names", async () => {
			// Root folder exists
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// List children — one vault with different name
			mock.listFiles.mockResolvedValueOnce({ files: [makeFolder("other-id", "other-uuid")] });
			// Read other vault's metadata
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".smartsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: "metadata.json" }));
			const metaContent = new TextEncoder().encode(JSON.stringify({ vaultName: "Other Vault" }));
			mock.downloadFile.mockResolvedValueOnce(metaContent.buffer);
			// Create new vault
			mock.createFolder.mockResolvedValueOnce(makeFolder("new-vault-id", "test-uuid-1234"));
			mock.createFolder.mockResolvedValueOnce(makeFolder("new-ss-id", ".smartsync"));
			mock.uploadFile.mockResolvedValueOnce(makeDriveFile({ id: "new-meta-id", name: "metadata.json" }));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.remoteVaultId).toBe("test-uuid-1234");
			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "new-vault-id" });
		});
	});
});
