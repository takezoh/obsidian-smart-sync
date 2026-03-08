import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyIncrementalChanges, applyIncrementalChangesLightweight } from "./incremental-sync";
import type { IncrementalSyncContext } from "./incremental-sync";
import type { DriveFile } from "./types";
import type { DriveMetadataCache } from "./metadata-cache";
import type { DriveClient } from "./client";
import type { MetadataStore, FileRecord } from "../../store/metadata-store";
import type { FolderHierarchy } from "./folder-hierarchy";

vi.mock("obsidian");

describe("applyIncrementalChanges", () => {
	let listChanges: ReturnType<typeof vi.fn>;
	let getPathById: ReturnType<typeof vi.fn>;
	let collectDescendants: ReturnType<typeof vi.fn>;
	let removePath: ReturnType<typeof vi.fn>;
	let applyFileChange: ReturnType<typeof vi.fn>;
	let loggerInfo: ReturnType<typeof vi.fn>;
	let loggerWarn: ReturnType<typeof vi.fn>;
	let mockClient: DriveClient;
	let mockCache: DriveMetadataCache;
	let ctx: IncrementalSyncContext;

	beforeEach(() => {
		listChanges = vi.fn();
		getPathById = vi.fn();
		collectDescendants = vi.fn().mockReturnValue([]);
		removePath = vi.fn();
		applyFileChange = vi.fn();
		loggerInfo = vi.fn();
		loggerWarn = vi.fn();

		mockClient = { listChanges } as unknown as DriveClient;
		mockCache = {
			getPathById,
			collectDescendants,
			removePath,
			applyFileChange,
		} as unknown as DriveMetadataCache;

		ctx = {
			client: mockClient,
			cache: mockCache,
			logger: {
				info: loggerInfo,
				warn: loggerWarn,
				error: vi.fn(),
				debug: vi.fn(),
			} as unknown as import("../../logging/logger").Logger,
		};
	});

	it("applies incremental changes successfully", async () => {
		const mockFile: DriveFile = {
			id: "file-1",
			name: "test.txt",
			mimeType: "text/plain",
			trashed: false,
		};

		listChanges.mockResolvedValue({
			changes: [{ fileId: "file-1", file: mockFile, removed: false }],
			nextPageToken: undefined,
			newStartPageToken: "new-token-123",
		});

		getPathById.mockReturnValue("/test.txt");

		const result = await applyIncrementalChanges(ctx, "old-token");

		expect(result).toEqual({
			newToken: "new-token-123",
			needsFullScan: false,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			changedPaths: expect.any(Set),
		});
		expect(loggerInfo).toHaveBeenCalledWith("Incremental changes applied", {
			changeCount: 1,
		});
	});

	it("falls back to full scan on 410 (token expired)", async () => {
		const error = new Error("Changes token expired");
		Object.assign(error, { status: 410 });

		listChanges.mockRejectedValue(error);

		const result = await applyIncrementalChanges(ctx, "expired-token");

		expect(result).toEqual({ needsFullScan: true });
		expect(loggerInfo).toHaveBeenCalledWith(
			"Changes token expired (410), falling back to full scan"
		);
	});

	it("falls back to full scan on 401 (unauthorized/invalid page token)", async () => {
		const error = new Error("Unauthorized");
		Object.assign(error, { status: 401 });

		listChanges.mockRejectedValue(error);

		const result = await applyIncrementalChanges(ctx, "invalid-token");

		expect(result).toEqual({ needsFullScan: true });
		expect(loggerWarn).toHaveBeenCalledWith(
			"listChanges returned 401 — page token may be invalid, falling back to full scan"
		);
	});

	it("re-throws other HTTP errors", async () => {
		const error = new Error("Internal server error");
		Object.assign(error, { status: 500 });

		listChanges.mockRejectedValue(error);

		await expect(applyIncrementalChanges(ctx, "valid-token")).rejects.toThrow(
			"Internal server error"
		);
	});

	it("re-throws non-HTTP errors", async () => {
		const error = new Error("Network error");

		listChanges.mockRejectedValue(error);

		await expect(applyIncrementalChanges(ctx, "valid-token")).rejects.toThrow(
			"Network error"
		);
	});
});

describe("applyIncrementalChangesLightweight", () => {
	let listChanges: ReturnType<typeof vi.fn>;
	let mockClient: DriveClient;
	let hierarchy: FolderHierarchy;
	const rootId = "root-folder-id";

	function makeLogger() {
		return {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as import("../../logging/logger").Logger;
	}

	function makeMetadataStore(records: FileRecord<DriveFile>[]): MetadataStore<DriveFile> {
		return {
			open: vi.fn(),
			getByFileIds: vi.fn().mockResolvedValue(
				records,
			),
			deleteFiles: vi.fn(),
		} as unknown as MetadataStore<DriveFile>;
	}

	beforeEach(() => {
		listChanges = vi.fn();
		mockClient = { listChanges } as unknown as DriveClient;
		hierarchy = {
			rootFolderId: rootId,
			folders: new Map([
				["folder-1", { name: "docs", parentId: rootId }],
			]),
		};
	});

	it("resolves deleted file paths via MetadataStore instead of falling back to full scan", async () => {
		listChanges.mockResolvedValue({
			changes: [
				{ fileId: "deleted-file-1", file: { id: "deleted-file-1", trashed: true, name: "old.md", mimeType: "text/plain" }, removed: false },
			],
			nextPageToken: undefined,
			newStartPageToken: "new-token",
		});

		const metadataStore = makeMetadataStore([
			{ path: "docs/old.md", file: { id: "deleted-file-1", name: "old.md", mimeType: "text/plain", trashed: false } as DriveFile, isFolder: false },
		]);

		const result = await applyIncrementalChangesLightweight(
			mockClient, hierarchy, "old-token", makeLogger(), metadataStore,
		);

		expect(result.needsFullScan).toBe(false);
		expect("deletedPaths" in result && result.deletedPaths).toEqual(["docs/old.md"]);
		expect("changedPaths" in result && result.changedPaths.has("docs/old.md")).toBe(true);
	});

	it("falls back to full scan on deletion when no MetadataStore is provided", async () => {
		listChanges.mockResolvedValue({
			changes: [
				{ fileId: "deleted-file-1", file: { id: "deleted-file-1", trashed: true, name: "old.md", mimeType: "text/plain" }, removed: false },
			],
			nextPageToken: undefined,
			newStartPageToken: "new-token",
		});

		const result = await applyIncrementalChangesLightweight(
			mockClient, hierarchy, "old-token", makeLogger(),
		);

		expect(result).toEqual({ needsFullScan: true });
	});

	it("falls back to full scan when MetadataStore lookup fails", async () => {
		listChanges.mockResolvedValue({
			changes: [
				{ fileId: "deleted-file-1", removed: true, file: null },
			],
			nextPageToken: undefined,
			newStartPageToken: "new-token",
		});

		const metadataStore = {
			open: vi.fn(),
			getByFileIds: vi.fn().mockRejectedValue(new Error("IDB error")),
		} as unknown as MetadataStore<DriveFile>;

		const result = await applyIncrementalChangesLightweight(
			mockClient, hierarchy, "old-token", makeLogger(), metadataStore,
		);

		expect(result).toEqual({ needsFullScan: true });
	});

	it("handles mixed additions and deletions in the same batch", async () => {
		const addedFile: DriveFile = {
			id: "new-file-1",
			name: "new.md",
			mimeType: "text/plain",
			trashed: false,
			parents: [rootId],
			modifiedTime: "2026-01-01T00:00:00Z",
			size: "100",
			md5Checksum: "abc123",
		};

		listChanges.mockResolvedValue({
			changes: [
				{ fileId: "new-file-1", file: addedFile, removed: false },
				{ fileId: "deleted-file-1", removed: true, file: null },
			],
			nextPageToken: undefined,
			newStartPageToken: "new-token",
		});

		const metadataStore = makeMetadataStore([
			{ path: "removed.md", file: { id: "deleted-file-1", name: "removed.md", mimeType: "text/plain", trashed: false } as DriveFile, isFolder: false },
		]);

		const result = await applyIncrementalChangesLightweight(
			mockClient, hierarchy, "old-token", makeLogger(), metadataStore,
		);

		expect(result.needsFullScan).toBe(false);
		if (!result.needsFullScan) {
			expect(result.changedPaths.has("new.md")).toBe(true);
			expect(result.changedPaths.has("removed.md")).toBe(true);
			expect(result.changedFiles.has("new.md")).toBe(true);
			expect(result.changedFiles.has("removed.md")).toBe(false); // Deleted — not in changedFiles
			expect(result.deletedPaths).toEqual(["removed.md"]);
		}
	});
});
