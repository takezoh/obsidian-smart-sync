import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import type { DriveFile } from "./types";
import { spyRequestUrl, mockRes } from "./test-helpers";
import type { GoogleDriveFsInternal, GoogleDriveFsCacheInternal } from "./test-helpers";

vi.mock("obsidian");

describe("GoogleDriveFs folder rename child path rewrite", () => {
	it("rewrites child paths when a folder is renamed via incremental changes", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "folder1", name: "oldFolder", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "file1", name: "child.txt", mimeType: "text/plain", parents: ["folder1"] },
				{ id: "file2", name: "deep.txt", mimeType: "text/plain", parents: ["folder1"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{
						type: "file",
						fileId: "folder1",
						removed: false,
						file: { id: "folder1", name: "newFolder", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
					},
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Initial list to populate cache
		const initial = await fs.list();
		expect(initial.map((e) => e.path).sort()).toEqual([
			"oldFolder",
			"oldFolder/child.txt",
			"oldFolder/deep.txt",
		]);

		// Apply incremental change that renames oldFolder → newFolder
		await fs.applyIncrementalChanges();
		const updated = await fs.list();
		const paths = updated.map((e) => e.path).sort();

		expect(paths).toContain("newFolder");
		expect(paths).toContain("newFolder/child.txt");
		expect(paths).toContain("newFolder/deep.txt");
		expect(paths).not.toContain("oldFolder");
		expect(paths).not.toContain("oldFolder/child.txt");
	});
});

describe("GoogleDriveFs.ensureFolder file collision", () => {
	it("throws when a path segment is a file not a folder", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "file1", name: "docs", mimeType: "text/plain", parents: ["root"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Populate cache
		await fs.list();

		// Trying to mkdir docs/sub should fail because "docs" is a file
		await expect(fs.mkdir("docs/sub")).rejects.toThrow(
			'Cannot create directory "docs/sub": "docs" is a file'
		);
	});
});

describe("GoogleDriveFs.write contentChecksum", () => {
	it("includes contentChecksum in backendMeta when returned by Drive API", async () => {
		const uploadResult = {
			id: "file1",
			name: "test.md",
			mimeType: "text/plain",
			modifiedTime: "2024-01-01T00:00:00.000Z",
			size: "5",
			md5Checksum: "abc123hash",
		};
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			() => Promise.resolve(mockRes(uploadResult))
		);

		const { GoogleDriveFs } = await import("./index");
		const { DriveClient } = await import("./client");
		const client = new DriveClient(() => Promise.resolve("access"));
		const fs = new GoogleDriveFs(client, "root");

		(fs as unknown as GoogleDriveFsInternal).initialized = true;

		const content = new TextEncoder().encode("hello").buffer.slice(0);
		const result = await fs.write("test.md", content, Date.now());

		expect(result.backendMeta?.contentChecksum).toBe("abc123hash");
		expect(result.backendMeta?.driveId).toBe("file1");

		mockRequestUrl.mockRestore();
	});

	it("handles missing contentChecksum (Google Docs) gracefully", async () => {
		const uploadResult = {
			id: "doc1",
			name: "doc.gdoc",
			mimeType: "application/vnd.google-apps.document",
			modifiedTime: "2024-01-01T00:00:00.000Z",
		};
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			(opts: string | { url: string }) => {
				const url = typeof opts === "string" ? opts : opts.url;
				if (url.includes("uploadType=")) return Promise.resolve(mockRes(uploadResult));
				return Promise.resolve(mockRes({ files: [] }));
			}
		);

		const { GoogleDriveFs } = await import("./index");
		const { DriveClient } = await import("./client");
		const client = new DriveClient(() => Promise.resolve("access"));
		const fs = new GoogleDriveFs(client, "root");

		(fs as unknown as GoogleDriveFsInternal).initialized = true;

		const content = new TextEncoder().encode("hello").buffer.slice(0);
		const result = await fs.write("doc.gdoc", content, Date.now());

		expect(result.backendMeta?.contentChecksum).toBeUndefined();
		expect(result.backendMeta?.driveId).toBe("doc1");

		mockRequestUrl.mockRestore();
	});
});

describe("GoogleDriveFs multi-parent resolution", () => {
	it("resolves file with multiple parents to root when rootId is second", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "file1",
					name: "shared.txt",
					mimeType: "text/plain",
					parents: ["outsideId", "root"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();

		expect(files).toHaveLength(1);
		expect(files[0]!.path).toBe("shared.txt");
	});

	it("resolves nested file via known parent when first parent is unknown", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "folder1",
					name: "docs",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				},
				{
					id: "file1",
					name: "note.md",
					mimeType: "text/plain",
					parents: ["outsideFolder", "folder1"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();
		const paths = files.map((f) => f.path).sort();

		expect(paths).toContain("docs");
		expect(paths).toContain("docs/note.md");
	});

	it("single parent still works (regression)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "folder1",
					name: "notes",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				},
				{
					id: "file1",
					name: "hello.md",
					mimeType: "text/plain",
					parents: ["folder1"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();
		const paths = files.map((f) => f.path).sort();

		expect(paths).toContain("notes");
		expect(paths).toContain("notes/hello.md");
	});

	it("resolvePathFromCache handles multi-parent in incremental changes", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "folder1",
					name: "docs",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{
						type: "file",
						fileId: "file1",
						removed: false,
						file: {
							id: "file1",
							name: "new.md",
							mimeType: "text/plain",
							parents: ["outsideId", "folder1"],
						},
					},
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Initial scan
		await fs.list();

		// Apply incremental change with multi-parent file
		await fs.applyIncrementalChanges();
		const files = await fs.list();
		const paths = files.map((f) => f.path).sort();

		expect(paths).toContain("docs");
		expect(paths).toContain("docs/new.md");
	});
});

describe("GoogleDriveFs circular parent reference", () => {
	it("handles mutual cycle (A→B→A) without infinite loop", async () => {
		const { GoogleDriveFs } = await import("./index");
		const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "a", name: "folderA", mimeType: "application/vnd.google-apps.folder", parents: ["b"] },
				{ id: "b", name: "folderB", mimeType: "application/vnd.google-apps.folder", parents: ["a"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root", mockLogger);
		const files = await fs.list();

		// list() completes without hanging
		expect(files.length).toBe(2);
		expect((mockLogger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
			expect.stringContaining("Circular parent reference"),
			expect.any(Object)
		);
	});

	it("handles self-referencing parent (X→X) without infinite loop", async () => {
		const { GoogleDriveFs } = await import("./index");
		const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "x", name: "selfRef", mimeType: "text/plain", parents: ["x"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root", mockLogger);
		const files = await fs.list();

		expect(files.length).toBe(1);
		expect(files[0]!.path).toBe("selfRef");
		expect((mockLogger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
			expect.stringContaining("Circular parent reference"),
			expect.any(Object)
		);
	});
});

describe("GoogleDriveFs children index", () => {
	it("removeTree removes all descendants (nested folders)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "a", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "f2", name: "b", mimeType: "application/vnd.google-apps.folder", parents: ["f1"] },
				{ id: "file1", name: "c.txt", mimeType: "text/plain", parents: ["f2"] },
				{ id: "file2", name: "d.txt", mimeType: "text/plain", parents: ["f1"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{ type: "file", fileId: "f1", removed: true },
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Populate cache
		const initial = await fs.list();
		expect(initial).toHaveLength(4);

		// Delete folder "a" via incremental changes
		await fs.applyIncrementalChanges();
		const after = await fs.list();

		// All descendants should be removed
		expect(after).toHaveLength(0);
	});

	it("rewriteChildPaths correctly updates deeply nested paths", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "top", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "f2", name: "mid", mimeType: "application/vnd.google-apps.folder", parents: ["f1"] },
				{ id: "f3", name: "deep", mimeType: "application/vnd.google-apps.folder", parents: ["f2"] },
				{ id: "file1", name: "leaf.txt", mimeType: "text/plain", parents: ["f3"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{
						type: "file",
						fileId: "f1",
						removed: false,
						file: { id: "f1", name: "renamed", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
					},
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();
		await fs.applyIncrementalChanges();
		const after = await fs.list();
		const paths = after.map((e) => e.path).sort();

		expect(paths).toEqual([
			"renamed",
			"renamed/mid",
			"renamed/mid/deep",
			"renamed/mid/deep/leaf.txt",
		]);

		// Verify children index is consistent
		const cache = (fs as unknown as GoogleDriveFsCacheInternal).cache;
		expect(cache.getChildren("renamed")?.has("renamed/mid")).toBe(true);
		expect(cache.getChildren("renamed/mid")?.has("renamed/mid/deep")).toBe(true);
		expect(cache.getChildren("renamed/mid/deep")?.has("renamed/mid/deep/leaf.txt")).toBe(true);
	});

	it("listDir returns only direct children (not recursive)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "parent", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "f2", name: "child", mimeType: "application/vnd.google-apps.folder", parents: ["f1"] },
				{ id: "file1", name: "a.txt", mimeType: "text/plain", parents: ["f1"] },
				{ id: "file2", name: "b.txt", mimeType: "text/plain", parents: ["f2"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		const children = await fs.listDir("parent");
		const childPaths = children.map((e) => e.path).sort();

		expect(childPaths).toEqual(["parent/a.txt", "parent/child"]);
		// Should NOT include parent/child/b.txt
		expect(childPaths).not.toContain("parent/child/b.txt");
	});
});

describe("GoogleDriveFs cache persistence", () => {

	it("fullScan persists cache, loadFromCache restores it", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");

		const allFiles = [
			{ id: "f1", name: "docs", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
			{ id: "file1", name: "note.md", mimeType: "text/plain", parents: ["f1"], modifiedTime: "2024-01-01T00:00:00.000Z", size: "100" },
		];
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue(allFiles),
			getChangesStartToken: vi.fn().mockResolvedValue("token-abc"),
		} as never;

		const store = new MetadataStore<DriveFile>("persist-test", { dbNamePrefix: "smart-sync-drive", version: 1 });

		// First instance: fullScan populates and persists
		const fs1 = new GoogleDriveFs(mockClient, "root", undefined, store);
		const files1 = await fs1.list();
		expect(files1).toHaveLength(2);

		// Wait for async persist to complete
		await new Promise((r) => setTimeout(r, 50));

		// Second instance: should load from IDB, no fullScan needed
		const listAllFilesSpy = vi.fn();
		const mockClient2 = {
			listAllFiles: listAllFilesSpy,
			getChangesStartToken: vi.fn(),
			listChanges: vi.fn().mockResolvedValue({ changes: [], newStartPageToken: "token-abc" }),
		} as never;
		const fs2 = new GoogleDriveFs(mockClient2, "root", undefined, store);
		const files2 = await fs2.list();

		expect(files2).toHaveLength(2);
		expect(files2.map((f) => f.path).sort()).toEqual(["docs", "docs/note.md"]);
		// listAllFiles should NOT have been called (loaded from cache)
		expect(listAllFilesSpy).not.toHaveBeenCalled();

		await store.close();
	});

	it("rootFolderId mismatch falls back to fullScan", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");

		const mockClient1 = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["root1"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const store = new MetadataStore<DriveFile>("mismatch-test", { dbNamePrefix: "smart-sync-drive", version: 1 });

		// Persist with rootFolderId = "root1"
		const fs1 = new GoogleDriveFs(mockClient1, "root1", undefined, store);
		await fs1.list();

		// Second instance with different rootFolderId
		const listAllFilesSpy2 = vi.fn().mockResolvedValue([
			{ id: "file2", name: "b.md", mimeType: "text/plain", parents: ["root2"] },
		]);
		const mockClient2 = {
			listAllFiles: listAllFilesSpy2,
			getChangesStartToken: vi.fn().mockResolvedValue("token2"),
		} as never;
		const fs2 = new GoogleDriveFs(mockClient2, "root2", undefined, store);
		const files = await fs2.list();

		// Should have done a full scan with root2
		expect(listAllFilesSpy2).toHaveBeenCalled();
		expect(files[0]!.path).toBe("b.md");

		await store.close();
	});

	it("invalidateCache clears IDB so next load does fullScan", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["root"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const store = new MetadataStore<DriveFile>("invalidate-test", { dbNamePrefix: "smart-sync-drive", version: 1 });
		const fs = new GoogleDriveFs(mockClient, "root", undefined, store);
		await fs.list();
		// Wait for async persist
		await new Promise((r) => setTimeout(r, 50));

		// Verify IDB has data
		let loaded = await store.loadAll();
		expect(loaded.files).toHaveLength(1);

		// Now invalidate and wait for clear
		fs.invalidateCache();
		await new Promise((r) => setTimeout(r, 50));

		loaded = await store.loadAll();
		expect(loaded.files).toHaveLength(0);
		expect(loaded.meta.size).toBe(0);

		await store.close();
	});
});

describe("GoogleDriveFs.getChangedPaths", () => {
	it("returns modified and deleted paths on successful incremental changes", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "notes", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "file1", name: "keep.md", mimeType: "text/plain", parents: ["f1"] },
				{ id: "file2", name: "remove.md", mimeType: "text/plain", parents: ["f1"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					// file1 (keep.md) is modified
					{
						type: "file",
						fileId: "file1",
						removed: false,
						file: { id: "file1", name: "keep.md", mimeType: "text/plain", parents: ["f1"], modifiedTime: "2024-06-01T00:00:00.000Z" },
					},
					// file2 (remove.md) is deleted
					{ type: "file", fileId: "file2", removed: true },
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		const result = await fs.getChangedPaths();

		expect(result).not.toBeNull();
		expect(result!.modified).toContain("notes/keep.md");
		expect(result!.deleted).toContain("notes/remove.md");
	});

	it("returns null when not initialized (triggers full scan)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const listAllFiles = vi.fn().mockResolvedValue([
			{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["root"] },
		]);
		const mockClient = {
			listAllFiles,
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		// Do NOT call list() first — fs is not initialized

		const result = await fs.getChangedPaths();

		// null means a full scan was performed
		expect(result).toBeNull();
		// Full scan should have initialized the fs
		expect(listAllFiles).toHaveBeenCalledOnce();
	});

	it("returns null on 410 fallback (token expired)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const httpError = { status: 410, message: "Gone" };
		const listAllFiles = vi.fn().mockResolvedValue([
			{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["root"] },
		]);
		const mockClient = {
			listAllFiles,
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockRejectedValue(httpError),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		const result = await fs.getChangedPaths();

		// 410 triggers full scan, returns null
		expect(result).toBeNull();
		// A second full scan should have been triggered
		expect(listAllFiles).toHaveBeenCalledTimes(2);
	});

	it("propagates auth errors from the Drive API", async () => {
		const { GoogleDriveFs } = await import("./index");

		const authError = { status: 401, message: "Unauthorized" };
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["root"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockRejectedValue(authError),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		await expect(fs.getChangedPaths()).rejects.toEqual(authError);
	});
});
