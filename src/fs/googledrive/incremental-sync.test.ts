import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyIncrementalChanges } from "./incremental-sync";
import type { IncrementalSyncContext } from "./incremental-sync";
import type { DriveFile } from "./types";
import type { DriveMetadataCache } from "./metadata-cache";
import type { DriveClient } from "./client";

vi.mock("obsidian");

describe("applyIncrementalChanges", () => {
	let listChanges: ReturnType<typeof vi.fn>;
	let getPathById: ReturnType<typeof vi.fn>;
	let collectDescendants: ReturnType<typeof vi.fn>;
	let removeTree: ReturnType<typeof vi.fn>;
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
		removeTree = vi.fn();
		applyFileChange = vi.fn();
		loggerInfo = vi.fn();
		loggerWarn = vi.fn();

		mockClient = { listChanges } as unknown as DriveClient;
		mockCache = {
			getPathById,
			collectDescendants,
			removeTree,
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
			changedPaths: new Set(["/test.txt"]),
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

		expect(result).toEqual({ needsFullScan: true, changedPaths: new Set() });
		expect(loggerInfo).toHaveBeenCalledWith(
			"Changes token expired (410), falling back to full scan"
		);
	});

	it("re-throws 401 as auth error (no fallback to full scan)", async () => {
		const error = new Error("Unauthorized");
		Object.assign(error, { status: 401 });

		listChanges.mockRejectedValue(error);

		await expect(applyIncrementalChanges(ctx, "invalid-token")).rejects.toThrow(
			"Unauthorized"
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
