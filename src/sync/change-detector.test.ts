import { describe, it, expect, beforeEach } from "vitest";
import { collectChanges } from "./change-detector";
import type { ChangeDetectorDeps } from "./change-detector";
import { LocalChangeTracker } from "./local-tracker";
import { createMockFs, createMockStateStore, addFile } from "../__mocks__/sync-test-helpers";
import type { SyncRecord } from "./types";

function makeRecord(path: string, overrides: Partial<SyncRecord> = {}): SyncRecord {
	return {
		path,
		hash: "abc",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 10,
		remoteSize: 10,
		syncedAt: 900,
		...overrides,
	};
}

describe("collectChanges — temperature selection", () => {
	let localFs: ReturnType<typeof createMockFs>;
	let remoteFs: ReturnType<typeof createMockFs>;
	let stateStore: ReturnType<typeof createMockStateStore>;
	let localTracker: LocalChangeTracker;

	function makeDeps(): ChangeDetectorDeps {
		return { localFs, remoteFs, stateStore, localTracker };
	}

	beforeEach(() => {
		localFs = createMockFs("local");
		remoteFs = createMockFs("remote");
		stateStore = createMockStateStore();
		localTracker = new LocalChangeTracker();
	});

	describe("cold path", () => {
		it("returns cold when stateStore is empty", async () => {
			addFile(localFs, "a.md", "hello", 1000);
			addFile(remoteFs, "a.md", "hello", 1000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("cold");
		});

		it("includes all local and remote files", async () => {
			addFile(localFs, "a.md", "local", 1000);
			addFile(remoteFs, "b.md", "remote", 1000);

			const result = await collectChanges(makeDeps());

			const paths = result.entries.map((e) => e.path).sort();
			expect(paths).toEqual(["a.md", "b.md"]);
		});

		it("skips directories", async () => {
			addFile(localFs, "notes/a.md", "hello", 1000);
			// notes/ directory is auto-created by addFile

			const result = await collectChanges(makeDeps());

			for (const entry of result.entries) {
				expect(entry.local?.isDirectory ?? false).toBe(false);
				expect(entry.remote?.isDirectory ?? false).toBe(false);
			}
		});

		it("returns empty entries when both sides are empty", async () => {
			const result = await collectChanges(makeDeps());
			expect(result.temperature).toBe("cold");
			expect(result.entries).toHaveLength(0);
		});
	});

	describe("warm path", () => {
		it("returns warm when records exist and tracker is not initialized", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "hello", 1000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
		});

		it("returns warm when tracker is initialized but no dirty paths", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "hello", 1000);
			// Acknowledge to initialize but clear all dirty paths
			localTracker.acknowledge([]);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
		});

		it("detects locally modified files", async () => {
			await stateStore.put(makeRecord("a.md", { localMtime: 500, localSize: 5 }));
			addFile(localFs, "a.md", "modified content", 2000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry).toBeDefined();
			expect(entry?.local).toBeDefined();
		});

		it("detects locally deleted files", async () => {
			await stateStore.put(makeRecord("deleted.md"));
			// deleted.md is not in localFs

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "deleted.md");
			expect(entry).toBeDefined();
			expect(entry?.local).toBeUndefined();
		});

		it("excludes unchanged files from warm results", async () => {
			await stateStore.put(makeRecord("unchanged.md", { localMtime: 1000, localSize: 10 }));
			addFile(localFs, "unchanged.md", "0123456789", 1000);

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			// unchanged.md should not be in warm results
			const entry = result.entries.find((e) => e.path === "unchanged.md");
			expect(entry).toBeUndefined();
		});

		it("detects new local files with no sync record", async () => {
			await stateStore.put(makeRecord("existing.md"));
			addFile(localFs, "existing.md", "content", 1000);
			addFile(localFs, "new-local.md", "brand new", 2000);
			// new-local.md has no sync record

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const entry = result.entries.find((e) => e.path === "new-local.md");
			expect(entry).toBeDefined();
			expect(entry?.local).toBeDefined();
			expect(entry?.prevSync).toBeUndefined();
		});

		it("includes remote changed paths from getChangedPaths", async () => {
			await stateStore.put(makeRecord("remote-changed.md"));
			addFile(remoteFs, "remote-changed.md", "remote new content", 2000);

			// Attach getChangedPaths to remoteFs
			(remoteFs as unknown as { getChangedPaths: () => Promise<{ modified: string[]; deleted: string[] }> })
				.getChangedPaths = async () => ({ modified: ["remote-changed.md"], deleted: [] });

			const result = await collectChanges(makeDeps());

			const entry = result.entries.find((e) => e.path === "remote-changed.md");
			expect(entry).toBeDefined();
			expect(entry?.remote).toBeDefined();
		});
	});

	describe("hot path", () => {
		it("returns hot when tracker is initialized and has dirty paths", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "modified", 2000);
			localTracker.markDirty("a.md");
			localTracker.acknowledge([]); // mark initialized without clearing dirty
			// re-mark after acknowledge
			localTracker.markDirty("a.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
		});

		it("only fetches stat for dirty paths", async () => {
			await stateStore.put(makeRecord("dirty.md", { localMtime: 500 }));
			await stateStore.put(makeRecord("clean.md"));
			addFile(localFs, "dirty.md", "changed", 2000);
			addFile(localFs, "clean.md", "unchanged", 1000);
			localTracker.acknowledge([]); // initialize
			localTracker.markDirty("dirty.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const paths = result.entries.map((e) => e.path);
			expect(paths).toContain("dirty.md");
			expect(paths).not.toContain("clean.md");
		});

		it("includes remote changed paths in hot mode", async () => {
			await stateStore.put(makeRecord("local-dirty.md", { localMtime: 500 }));
			await stateStore.put(makeRecord("remote-only.md"));
			addFile(localFs, "local-dirty.md", "changed", 2000);
			addFile(remoteFs, "remote-only.md", "remote changed", 2000);

			(remoteFs as unknown as { getChangedPaths: () => Promise<{ modified: string[]; deleted: string[] }> })
				.getChangedPaths = async () => ({ modified: ["remote-only.md"], deleted: [] });

			localTracker.acknowledge([]);
			localTracker.markDirty("local-dirty.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const paths = result.entries.map((e) => e.path);
			expect(paths).toContain("local-dirty.md");
			expect(paths).toContain("remote-only.md");
		});

		it("includes remote deleted paths from getChangedPaths in hot mode", async () => {
			await stateStore.put(makeRecord("local-dirty.md", { localMtime: 500 }));
			await stateStore.put(makeRecord("remote-deleted.md"));
			addFile(localFs, "local-dirty.md", "changed", 2000);
			// remote-deleted.md is absent from remoteFs (deleted)

			(remoteFs as unknown as { getChangedPaths: () => Promise<{ modified: string[]; deleted: string[] }> })
				.getChangedPaths = async () => ({ modified: [], deleted: ["remote-deleted.md"] });

			localTracker.acknowledge([]);
			localTracker.markDirty("local-dirty.md");

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			const paths = result.entries.map((e) => e.path);
			expect(paths).toContain("remote-deleted.md");
			const deleted = result.entries.find((e) => e.path === "remote-deleted.md");
			expect(deleted?.remote).toBeUndefined();
		});

		it("returns empty entries when no dirty paths and no remote changes", async () => {
			await stateStore.put(makeRecord("a.md"));
			addFile(localFs, "a.md", "content", 1000);
			localTracker.acknowledge([]); // initialize
			localTracker.markDirty("orphan.md"); // dirty path that doesn't exist anywhere

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("hot");
			// orphan.md has no local, no remote, no prevSync → filtered out
			const entry = result.entries.find((e) => e.path === "orphan.md");
			expect(entry).toBeUndefined();
		});
	});

	describe("getChangedPaths absent or returning null", () => {
		it("warm mode falls back gracefully when getChangedPaths is absent", async () => {
			await stateStore.put(makeRecord("a.md", { localMtime: 500 }));
			addFile(localFs, "a.md", "modified", 2000);
			// remoteFs has no getChangedPaths

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
		});

		it("warm mode handles getChangedPaths returning null", async () => {
			await stateStore.put(makeRecord("a.md", { localMtime: 500 }));
			addFile(localFs, "a.md", "modified", 2000);

			(remoteFs as unknown as { getChangedPaths: () => Promise<null> })
				.getChangedPaths = async () => null;

			const result = await collectChanges(makeDeps());

			expect(result.temperature).toBe("warm");
			const entry = result.entries.find((e) => e.path === "a.md");
			expect(entry).toBeDefined();
		});
	});
});
