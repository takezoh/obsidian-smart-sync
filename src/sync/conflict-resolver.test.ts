import { describe, it, expect, beforeEach } from "vitest";
import { resolveConflictV2 } from "./conflict-resolver";
import type { SyncRecord } from "./types";
import { createMockFs, createMockStateStore, addFile, readText } from "../__mocks__/sync-test-helpers";

describe("resolveConflictV2", () => {
	let localFs: ReturnType<typeof createMockFs>;
	let remoteFs: ReturnType<typeof createMockFs>;

	beforeEach(() => {
		localFs = createMockFs("local");
		remoteFs = createMockFs("remote");
	});

	describe("duplicate strategy", () => {
		it("creates a conflict copy when both files exist", async () => {
			const local = addFile(localFs, "file.md", "local content", 2000);
			const remote = addFile(remoteFs, "file.md", "remote content", 1000);

			const result = await resolveConflictV2(
				{ path: "file.md", localFs, remoteFs, local, remote },
				"duplicate",
			);

			expect(result.action).toBe("duplicated");
			expect(result.duplicatePath).toBe("file.conflict.md");
			expect(readText(remoteFs, "file.md")).toBe("local content");
			expect(readText(localFs, "file.conflict.md")).toBe("remote content");
		});

		it("restores remote version locally when local is deleted", async () => {
			const remote = addFile(remoteFs, "file.md", "remote only", 1000);

			const result = await resolveConflictV2(
				{ path: "file.md", localFs, remoteFs, remote },
				"duplicate",
			);

			expect(result.action).toBe("duplicated");
			expect(readText(localFs, "file.md")).toBe("remote only");
		});

		it("restores local version remotely when remote is deleted", async () => {
			const local = addFile(localFs, "file.md", "local only", 1000);

			const result = await resolveConflictV2(
				{ path: "file.md", localFs, remoteFs, local },
				"duplicate",
			);

			expect(result.action).toBe("duplicated");
			expect(readText(remoteFs, "file.md")).toBe("local only");
		});
	});

	describe("auto_merge strategy", () => {
		it("performs 3-way merge when all prerequisites are met", async () => {
			const base = "line1\nline2\nline3\nline4\nline5\n";
			const localText = "line1\nlocal-change\nline3\nline4\nline5\n";
			const remoteText = "line1\nline2\nline3\nline4\nremote-change\n";

			addFile(localFs, "file.md", localText, 2000);
			addFile(remoteFs, "file.md", remoteText, 2000);

			const stateStore = createMockStateStore();
			stateStore.contents.set("file.md", new TextEncoder().encode(base).buffer.slice(0));

			const baseline: SyncRecord = {
				path: "file.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: base.length, remoteSize: base.length, syncedAt: 900,
			};

			const result = await resolveConflictV2(
				{
					path: "file.md", localFs, remoteFs,
					local: localFs.files.get("file.md")!.entity,
					remote: remoteFs.files.get("file.md")!.entity,
					baseline, stateStore,
				},
				"auto_merge",
			);

			expect(result.action).toBe("merged");
			expect(result.hasConflictMarkers).toBe(false);
		});

		it("reports conflict markers when both sides edit the same line", async () => {
			const base = "line1\noriginal\nline3\n";
			const localText = "line1\nlocal-edit\nline3\n";
			const remoteText = "line1\nremote-edit\nline3\n";

			addFile(localFs, "file.md", localText, 2000);
			addFile(remoteFs, "file.md", remoteText, 2000);

			const stateStore = createMockStateStore();
			stateStore.contents.set("file.md", new TextEncoder().encode(base).buffer.slice(0));

			const baseline: SyncRecord = {
				path: "file.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: base.length, remoteSize: base.length, syncedAt: 900,
			};

			const result = await resolveConflictV2(
				{
					path: "file.md", localFs, remoteFs,
					local: localFs.files.get("file.md")!.entity,
					remote: remoteFs.files.get("file.md")!.entity,
					baseline, stateStore,
				},
				"auto_merge",
			);

			expect(result.action).toBe("merged");
			expect(result.hasConflictMarkers).toBe(true);
		});

		it("falls back to keep_newer when baseline is missing", async () => {
			const local = addFile(localFs, "file.md", "local content", 2000);
			const remote = addFile(remoteFs, "file.md", "remote content", 1000);

			const result = await resolveConflictV2(
				{ path: "file.md", localFs, remoteFs, local, remote },
				"auto_merge",
			);

			// keep_newer → local is newer
			expect(result.action).toBe("kept_local");
			expect(readText(remoteFs, "file.md")).toBe("local content");
		});

		it("falls back to keep_newer when stateStore is missing", async () => {
			const local = addFile(localFs, "file.md", "local content", 2000);
			const remote = addFile(remoteFs, "file.md", "remote content", 1000);

			const baseline: SyncRecord = {
				path: "file.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 10, remoteSize: 10, syncedAt: 900,
			};

			const result = await resolveConflictV2(
				{ path: "file.md", localFs, remoteFs, local, remote, baseline },
				"auto_merge",
			);

			// Missing stateStore → fallback to keep_newer via auto_merge in resolveConflict
			expect(result.action).toBe("kept_local");
		});

		it("falls back to keep_newer for binary files (not merge eligible)", async () => {
			const local = addFile(localFs, "image.png", "local-binary", 2000);
			const remote = addFile(remoteFs, "image.png", "remote-binary", 1000);

			const stateStore = createMockStateStore();
			stateStore.contents.set("image.png", new TextEncoder().encode("base").buffer.slice(0));

			const baseline: SyncRecord = {
				path: "image.png", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 4, remoteSize: 4, syncedAt: 900,
			};

			const result = await resolveConflictV2(
				{ path: "image.png", localFs, remoteFs, local, remote, baseline, stateStore },
				"auto_merge",
			);

			// .png not eligible → keep_newer → local is newer
			expect(result.action).toBe("kept_local");
		});

		it("falls back to duplicate when mtime is equal and hashes differ (keep_newer fallback)", async () => {
			const local = addFile(localFs, "file.md", "local ver", 1000);
			local.hash = "aaa";
			const remote = addFile(remoteFs, "file.md", "remote ver", 1000);
			remote.hash = "bbb";

			// No stateStore → skips 3-way merge path → keep_newer
			const result = await resolveConflictV2(
				{ path: "file.md", localFs, remoteFs, local, remote },
				"auto_merge",
			);

			expect(result.action).toBe("duplicated");
		});

		it("falls back to keep_newer when base content is unavailable in store", async () => {
			const local = addFile(localFs, "file.md", "local content", 2000);
			const remote = addFile(remoteFs, "file.md", "remote content", 1000);

			const stateStore = createMockStateStore();
			// No content stored for this path

			const baseline: SyncRecord = {
				path: "file.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 10, remoteSize: 10, syncedAt: 900,
			};

			const result = await resolveConflictV2(
				{ path: "file.md", localFs, remoteFs, local, remote, baseline, stateStore },
				"auto_merge",
			);

			// stateStore has no content → falls back to keep_newer → local is newer
			expect(result.action).toBe("kept_local");
		});
	});

	describe("ask strategy", () => {
		it("falls back to duplicate when no app is provided", async () => {
			const local = addFile(localFs, "file.md", "local content", 2000);
			const remote = addFile(remoteFs, "file.md", "remote content", 1000);

			const result = await resolveConflictV2(
				{ path: "file.md", localFs, remoteFs, local, remote },
				"ask",
			);

			expect(result.action).toBe("duplicated");
		});
	});
});
