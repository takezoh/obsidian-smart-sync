import { describe, it, expect, beforeEach } from "vitest";
import { resolveConflict, buildSyncRecord, generateConflictPath } from "./conflict";
import type { SyncRecord } from "../fs/types";
import { createMockFs, createMockStateStore, addFile, readText } from "../__mocks__/sync-test-helpers";

describe("resolveConflict", () => {
	let localFs: ReturnType<typeof createMockFs>;
	let remoteFs: ReturnType<typeof createMockFs>;

	beforeEach(() => {
		localFs = createMockFs("local");
		remoteFs = createMockFs("remote");
	});

	describe("keep_local", () => {
		it("overwrites remote with local content", async () => {
			const local = addFile(localFs, "file.md", "local content", 2000);
			addFile(remoteFs, "file.md", "remote content", 1000);

			const result = await resolveConflict(
				"file.md", "keep_local", localFs, remoteFs, local, remoteFs.files.get("file.md")!.entity
			);

			expect(result.action).toBe("kept_local");
			expect(readText(remoteFs, "file.md")).toBe("local content");
		});

		it("deletes remote when local is missing (delete-vs-modify)", async () => {
			addFile(remoteFs, "file.md", "remote content", 1000);

			const result = await resolveConflict(
				"file.md", "keep_local", localFs, remoteFs, undefined, remoteFs.files.get("file.md")!.entity
			);

			expect(result.action).toBe("kept_local");
			expect(remoteFs.files.has("file.md")).toBe(false);
		});
	});

	describe("keep_remote", () => {
		it("overwrites local with remote content", async () => {
			addFile(localFs, "file.md", "local content", 1000);
			const remote = addFile(remoteFs, "file.md", "remote content", 2000);

			const result = await resolveConflict(
				"file.md", "keep_remote", localFs, remoteFs, localFs.files.get("file.md")!.entity, remote
			);

			expect(result.action).toBe("kept_remote");
			expect(readText(localFs, "file.md")).toBe("remote content");
		});

		it("deletes local when remote is missing (delete-vs-modify)", async () => {
			addFile(localFs, "file.md", "local content", 1000);

			const result = await resolveConflict(
				"file.md", "keep_remote", localFs, remoteFs, localFs.files.get("file.md")!.entity, undefined
			);

			expect(result.action).toBe("kept_remote");
			expect(localFs.files.has("file.md")).toBe(false);
		});
	});

	describe("keep_newer", () => {
		it("keeps local when local is newer", async () => {
			const local = addFile(localFs, "file.md", "local newer", 2000);
			const remote = addFile(remoteFs, "file.md", "remote older", 1000);

			const result = await resolveConflict(
				"file.md", "keep_newer", localFs, remoteFs, local, remote
			);

			expect(result.action).toBe("kept_local");
			expect(readText(remoteFs, "file.md")).toBe("local newer");
		});

		it("keeps remote when remote is newer", async () => {
			const local = addFile(localFs, "file.md", "local older", 1000);
			const remote = addFile(remoteFs, "file.md", "remote newer", 2000);

			const result = await resolveConflict(
				"file.md", "keep_newer", localFs, remoteFs, local, remote
			);

			expect(result.action).toBe("kept_remote");
			expect(readText(localFs, "file.md")).toBe("remote newer");
		});

		it("keeps remote side when only remote exists (delete-vs-modify)", async () => {
			const remote = addFile(remoteFs, "file.md", "remote only", 1000);

			const result = await resolveConflict(
				"file.md", "keep_newer", localFs, remoteFs, undefined, remote
			);

			expect(result.action).toBe("kept_remote");
			expect(readText(localFs, "file.md")).toBe("remote only");
		});

		it("keeps local side when only local exists (delete-vs-modify)", async () => {
			const local = addFile(localFs, "file.md", "local only", 1000);

			const result = await resolveConflict(
				"file.md", "keep_newer", localFs, remoteFs, local, undefined
			);

			expect(result.action).toBe("kept_local");
			expect(readText(remoteFs, "file.md")).toBe("local only");
		});

		it("duplicates when mtime is equal and hashes differ", async () => {
			const local = addFile(localFs, "file.md", "local ver", 1000);
			local.hash = "aaa";
			const remote = addFile(remoteFs, "file.md", "remote ver", 1000);
			remote.hash = "bbb";

			const result = await resolveConflict(
				"file.md", "keep_newer", localFs, remoteFs, local, remote
			);

			expect(result.action).toBe("duplicated");
		});

		it("keeps local when mtime is equal and hashes match", async () => {
			const local = addFile(localFs, "file.md", "same content", 1000);
			local.hash = "same-hash";
			const remote = addFile(remoteFs, "file.md", "same content", 1000);
			remote.hash = "same-hash";

			const result = await resolveConflict(
				"file.md", "keep_newer", localFs, remoteFs, local, remote
			);

			expect(result.action).toBe("kept_local");
		});

		it("falls through to duplicate when one side has mtime=0 (M1)", async () => {
			const local = addFile(localFs, "file.md", "local ver", 0);
			local.hash = "aaa";
			const remote = addFile(remoteFs, "file.md", "remote ver", 2000);
			remote.hash = "bbb";

			const result = await resolveConflict(
				"file.md", "keep_newer", localFs, remoteFs, local, remote
			);

			// mtime=0 is unknown, so mtime comparison is skipped; hashes differ → duplicate
			expect(result.action).toBe("duplicated");
		});

		it("keeps local when both mtime=0 and hashes match (M1)", async () => {
			const local = addFile(localFs, "file.md", "same content", 0);
			local.hash = "same-hash";
			const remote = addFile(remoteFs, "file.md", "same content", 0);
			remote.hash = "same-hash";

			const result = await resolveConflict(
				"file.md", "keep_newer", localFs, remoteFs, local, remote
			);

			expect(result.action).toBe("kept_local");
		});

		it("duplicates when mtime is equal and hashes are empty", async () => {
			const local = addFile(localFs, "file.md", "local ver", 1000);
			const remote = addFile(remoteFs, "file.md", "remote ver", 1000);

			const result = await resolveConflict(
				"file.md", "keep_newer", localFs, remoteFs, local, remote
			);

			expect(result.action).toBe("duplicated");
		});
	});

	describe("duplicate", () => {
		it("creates a conflict copy when both exist", async () => {
			const local = addFile(localFs, "file.md", "local ver", 2000);
			const remote = addFile(remoteFs, "file.md", "remote ver", 1000);

			const result = await resolveConflict(
				"file.md", "duplicate", localFs, remoteFs, local, remote
			);

			expect(result.action).toBe("duplicated");
			expect(result.duplicatePath).toBe("file.conflict.md");
			// Original path should have local content pushed to remote
			expect(readText(remoteFs, "file.md")).toBe("local ver");
			// Conflict file should have remote content
			expect(readText(localFs, "file.conflict.md")).toBe("remote ver");
		});

		it("creates sequential conflict paths when conflict file already exists", async () => {
			// Pre-seed a .conflict file
			addFile(localFs, "file.conflict.md", "old conflict", 500);

			const local = addFile(localFs, "file.md", "local ver", 2000);
			const remote = addFile(remoteFs, "file.md", "remote ver", 1000);

			const result = await resolveConflict(
				"file.md", "duplicate", localFs, remoteFs, local, remote
			);

			expect(result.action).toBe("duplicated");
			expect(result.duplicatePath).toBe("file.conflict-2.md");
			// Old conflict file should still exist
			expect(readText(localFs, "file.conflict.md")).toBe("old conflict");
		});

		it("restores remote version locally when local is deleted", async () => {
			const remote = addFile(remoteFs, "file.md", "remote content", 1000);

			const result = await resolveConflict(
				"file.md", "duplicate", localFs, remoteFs, undefined, remote
			);

			expect(result.action).toBe("duplicated");
			expect(readText(localFs, "file.md")).toBe("remote content");
		});

		it("restores local version remotely when remote is deleted", async () => {
			const local = addFile(localFs, "file.md", "local content", 1000);

			const result = await resolveConflict(
				"file.md", "duplicate", localFs, remoteFs, local, undefined
			);

			expect(result.action).toBe("duplicated");
			expect(readText(remoteFs, "file.md")).toBe("local content");
		});
	});

	describe("three_way_merge", () => {
		it("merges non-conflicting changes from both sides", async () => {
			const base = "line1\nline2\nline3\nline4\nline5\n";
			const localText = "line1\nlocal-change\nline3\nline4\nline5\n";
			const remoteText = "line1\nline2\nline3\nline4\nremote-change\n";

			addFile(localFs, "file.md", localText, 2000);
			addFile(remoteFs, "file.md", remoteText, 2000);

			const stateStore = createMockStateStore();
			const baseBuf = new TextEncoder().encode(base).buffer as ArrayBuffer;
			stateStore.contents.set("file.md", baseBuf);

			const prevSync: SyncRecord = {
				path: "file.md", hash: "", localMtime: 1000, remoteMtime: 1000, size: base.length, syncedAt: 900,
			};

			const result = await resolveConflict(
				"file.md",
				"three_way_merge",
				localFs,
				remoteFs,
				localFs.files.get("file.md")!.entity,
				remoteFs.files.get("file.md")!.entity,
				prevSync,
				stateStore as any,
			);

			expect(result.action).toBe("merged");
			expect(result.hasConflictMarkers).toBe(false);
		});

		it("inserts conflict markers when both sides edit the same line", async () => {
			const base = "line1\noriginal\nline3\n";
			const localText = "line1\nlocal-edit\nline3\n";
			const remoteText = "line1\nremote-edit\nline3\n";

			addFile(localFs, "file.md", localText, 2000);
			addFile(remoteFs, "file.md", remoteText, 2000);

			const stateStore = createMockStateStore();
			const baseBuf = new TextEncoder().encode(base).buffer as ArrayBuffer;
			stateStore.contents.set("file.md", baseBuf);

			const prevSync: SyncRecord = {
				path: "file.md", hash: "", localMtime: 1000, remoteMtime: 1000, size: base.length, syncedAt: 900,
			};

			const result = await resolveConflict(
				"file.md",
				"three_way_merge",
				localFs,
				remoteFs,
				localFs.files.get("file.md")!.entity,
				remoteFs.files.get("file.md")!.entity,
				prevSync,
				stateStore as any,
			);

			expect(result.action).toBe("merged");
			expect(result.hasConflictMarkers).toBe(true);
		});

		it("falls back when prevSync is missing", async () => {
			const local = addFile(localFs, "file.md", "local", 2000);
			const remote = addFile(remoteFs, "file.md", "remote", 1000);

			const result = await resolveConflict(
				"file.md",
				"three_way_merge",
				localFs,
				remoteFs,
				local,
				remote,
				undefined, // no prevSync
			);

			// Falls back to keep_newer → local is newer
			expect(result.action).toBe("kept_local");
		});

		it("falls back for binary files", async () => {
			const local = addFile(localFs, "image.png", "local-binary", 2000);
			const remote = addFile(remoteFs, "image.png", "remote-binary", 1000);

			const stateStore = createMockStateStore();
			const baseBuf = new TextEncoder().encode("base").buffer as ArrayBuffer;
			stateStore.contents.set("image.png", baseBuf);

			const prevSync: SyncRecord = {
				path: "image.png", hash: "", localMtime: 1000, remoteMtime: 1000, size: 4, syncedAt: 900,
			};

			const result = await resolveConflict(
				"image.png",
				"three_way_merge",
				localFs,
				remoteFs,
				local,
				remote,
				prevSync,
				stateStore as any,
			);

			// .png is not merge-eligible, falls back to keep_newer → local is newer
			expect(result.action).toBe("kept_local");
		});
	});

	describe("buildSyncRecord", () => {
		it("returns a record when both sides exist", async () => {
			addFile(localFs, "file.md", "content", 1000);
			addFile(remoteFs, "file.md", "content", 1000);

			const record = await buildSyncRecord("file.md", localFs, remoteFs);
			expect(record).not.toBeNull();
			expect(record!.path).toBe("file.md");
			expect(record!.localMtime).toBe(1000);
			expect(record!.remoteMtime).toBe(1000);
		});

		it("returns null when neither side exists", async () => {
			const record = await buildSyncRecord("nonexistent.md", localFs, remoteFs);
			expect(record).toBeNull();
		});

		it("stores content for merge-eligible text files when storeContent is true", async () => {
			addFile(localFs, "file.md", "hello", 1000);
			addFile(remoteFs, "file.md", "hello", 1000);
			const stateStore = createMockStateStore();

			await buildSyncRecord("file.md", localFs, remoteFs, true, stateStore as any);
			expect(stateStore.contents.has("file.md")).toBe(true);
		});

		it("does not store content for binary files even when storeContent is true", async () => {
			addFile(localFs, "image.png", "binary-data", 1000);
			addFile(remoteFs, "image.png", "binary-data", 1000);
			const stateStore = createMockStateStore();

			await buildSyncRecord("image.png", localFs, remoteFs, true, stateStore as any);
			expect(stateStore.contents.has("image.png")).toBe(false);
		});

		it("does not store content for files exceeding 1MB even when storeContent is true", async () => {
			const bigContent = "x".repeat(1024 * 1024 + 1);
			addFile(localFs, "big.md", bigContent, 1000);
			addFile(remoteFs, "big.md", bigContent, 1000);
			const stateStore = createMockStateStore();

			await buildSyncRecord("big.md", localFs, remoteFs, true, stateStore as any);
			expect(stateStore.contents.has("big.md")).toBe(false);
		});

		it("returns a record when only one side exists", async () => {
			addFile(localFs, "local-only.md", "content", 1000);

			const record = await buildSyncRecord("local-only.md", localFs, remoteFs);
			expect(record).not.toBeNull();
			expect(record!.localMtime).toBe(1000);
			expect(record!.remoteMtime).toBe(0);
		});
	});

	describe("generateConflictPath", () => {
		it("generates .conflict suffix for first conflict", async () => {
			const path = await generateConflictPath("notes/file.md", localFs);
			expect(path).toBe("notes/file.conflict.md");
		});

		it("generates sequential numbering when conflict file exists", async () => {
			addFile(localFs, "file.conflict.md", "existing", 1000);
			const path = await generateConflictPath("file.md", localFs);
			expect(path).toBe("file.conflict-2.md");
		});

		it("skips multiple existing conflict files", async () => {
			addFile(localFs, "file.conflict.md", "v1", 1000);
			addFile(localFs, "file.conflict-2.md", "v2", 1000);
			addFile(localFs, "file.conflict-3.md", "v3", 1000);
			const path = await generateConflictPath("file.md", localFs);
			expect(path).toBe("file.conflict-4.md");
		});

		it("handles files without extension", async () => {
			const path = await generateConflictPath("README", localFs);
			expect(path).toBe("README.conflict");
		});

		it("handles files with extension-less dot in directory", async () => {
			const path = await generateConflictPath("dir.name/file", localFs);
			expect(path).toBe("dir.name/file.conflict");
		});

		it("skips conflict path that exists only on remoteFs", async () => {
			addFile(remoteFs, "file.conflict.md", "remote conflict", 1000);

			const path = await generateConflictPath("file.md", localFs, remoteFs);
			expect(path).toBe("file.conflict-2.md");
		});

		it("skips conflict paths existing on either filesystem", async () => {
			addFile(localFs, "file.conflict.md", "local conflict", 1000);
			addFile(remoteFs, "file.conflict-2.md", "remote conflict", 1000);

			const path = await generateConflictPath("file.md", localFs, remoteFs);
			expect(path).toBe("file.conflict-3.md");
		});
	});

	describe("three_way_merge — JSON/Canvas validation", () => {
		it("falls back to duplicate when JSON merge produces invalid JSON", async () => {
			// Base is valid JSON, local and remote make conflicting edits to the same key
			const base = '{"key": "base", "other": 1}';
			const localText = '{"key": "local-edit", "other": 1}';
			const remoteText = '{"key": "remote-edit", "other": 1}';

			addFile(localFs, "data.json", localText, 2000);
			addFile(remoteFs, "data.json", remoteText, 2000);

			const stateStore = createMockStateStore();
			const baseBuf = new TextEncoder().encode(base).buffer as ArrayBuffer;
			stateStore.contents.set("data.json", baseBuf);

			const prevSync: SyncRecord = {
				path: "data.json", hash: "", localMtime: 1000, remoteMtime: 1000, size: base.length, syncedAt: 900,
			};

			const result = await resolveConflict(
				"data.json",
				"three_way_merge",
				localFs,
				remoteFs,
				localFs.files.get("data.json")!.entity,
				remoteFs.files.get("data.json")!.entity,
				prevSync,
				stateStore as any,
			);

			// Conflicting edits to the same JSON key → conflict markers → invalid JSON → duplicate fallback
			expect(result.action).toBe("duplicated");
		});

		it("falls back to duplicate for .canvas files with merge conflicts", async () => {
			const base = '{"nodes": []}';
			const localText = '{"nodes": [{"id": "1"}]}';
			const remoteText = '{"nodes": [{"id": "2"}]}';

			addFile(localFs, "note.canvas", localText, 2000);
			addFile(remoteFs, "note.canvas", remoteText, 2000);

			const stateStore = createMockStateStore();
			const baseBuf = new TextEncoder().encode(base).buffer as ArrayBuffer;
			stateStore.contents.set("note.canvas", baseBuf);

			const prevSync: SyncRecord = {
				path: "note.canvas", hash: "", localMtime: 1000, remoteMtime: 1000, size: base.length, syncedAt: 900,
			};

			const result = await resolveConflict(
				"note.canvas",
				"three_way_merge",
				localFs,
				remoteFs,
				localFs.files.get("note.canvas")!.entity,
				remoteFs.files.get("note.canvas")!.entity,
				prevSync,
				stateStore as any,
			);

			expect(result.action).toBe("duplicated");
		});

		it("accepts clean JSON merge when result is valid", async () => {
			// Use multi-line JSON where changes are on separate lines to produce a clean merge
			const base = '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4\n}';
			const localText = '{\n  "a": 10,\n  "b": 2,\n  "c": 3,\n  "d": 4\n}';
			const remoteText = '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 40\n}';

			addFile(localFs, "config.json", localText, 2000);
			addFile(remoteFs, "config.json", remoteText, 2000);

			const stateStore = createMockStateStore();
			const baseBuf = new TextEncoder().encode(base).buffer as ArrayBuffer;
			stateStore.contents.set("config.json", baseBuf);

			const prevSync: SyncRecord = {
				path: "config.json", hash: "", localMtime: 1000, remoteMtime: 1000, size: base.length, syncedAt: 900,
			};

			const result = await resolveConflict(
				"config.json",
				"three_way_merge",
				localFs,
				remoteFs,
				localFs.files.get("config.json")!.entity,
				remoteFs.files.get("config.json")!.entity,
				prevSync,
				stateStore as any,
			);

			expect(result.action).toBe("merged");
			expect(result.hasConflictMarkers).toBe(false);

			// Verify the merged result is valid JSON
			const mergedContent = readText(localFs, "config.json");
			const parsed = JSON.parse(mergedContent);
			expect(parsed.a).toBe(10);
			expect(parsed.d).toBe(40);
		});
	});

	describe("three_way_merge recovery", () => {
		it("restores local to pre-merge state when remote write fails", async () => {
			const base = "line1\nline2\nline3\n";
			const localText = "line1\nlocal-change\nline3\n";
			const remoteText = "line1\nline2\nremote-change\n";

			addFile(localFs, "file.md", localText, 2000);
			addFile(remoteFs, "file.md", remoteText, 2000);

			// Make remote write throw
			const originalWrite = remoteFs.write.bind(remoteFs);
			let writeCalls = 0;
			remoteFs.write = async (path: string, content: ArrayBuffer, mtime?: number) => {
				writeCalls++;
				throw new Error("Remote write failed");
			};

			const stateStore = createMockStateStore();
			const baseBuf = new TextEncoder().encode(base).buffer as ArrayBuffer;
			stateStore.contents.set("file.md", baseBuf);

			const prevSync: SyncRecord = {
				path: "file.md", hash: "", localMtime: 1000, remoteMtime: 1000, size: base.length, syncedAt: 900,
			};

			await expect(resolveConflict(
				"file.md",
				"three_way_merge",
				localFs,
				remoteFs,
				localFs.files.get("file.md")!.entity,
				remoteFs.files.get("file.md")!.entity,
				prevSync,
				stateStore as any,
			)).rejects.toThrow("Remote write failed");

			// Local should be restored to pre-merge content
			expect(readText(localFs, "file.md")).toBe(localText);
		});
	});
});
