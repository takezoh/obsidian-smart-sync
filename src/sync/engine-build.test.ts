import { describe, it, expect, beforeEach } from "vitest";
import { buildMixedEntities } from "./engine";
import { MockFs } from "../fs/mock/index";
import type { SyncStateStore } from "./state";
import { createMockStateStore } from "../__mocks__/sync-test-helpers";

describe("buildMixedEntities", () => {
	let localFs: MockFs;
	let remoteFs: MockFs;
	let stateStore: ReturnType<typeof createMockStateStore>;

	beforeEach(() => {
		localFs = new MockFs("local");
		remoteFs = new MockFs("remote");
		stateStore = createMockStateStore();
	});

	it("returns empty array when all are empty", async () => {
		const result = await buildMixedEntities(
			localFs, remoteFs, stateStore as unknown as SyncStateStore
		);
		expect(result).toHaveLength(0);
	});

	it("includes local-only files", async () => {
		localFs.seed("note.md", "content", 1000);

		const result = await buildMixedEntities(
			localFs, remoteFs, stateStore as unknown as SyncStateStore
		);

		expect(result).toHaveLength(1);
		expect(result[0]!.path).toBe("note.md");
		expect(result[0]!.local).toBeDefined();
		expect(result[0]!.remote).toBeUndefined();
		expect(result[0]!.prevSync).toBeUndefined();
	});

	it("includes remote-only files", async () => {
		remoteFs.seed("remote.md", "content", 1000);

		const result = await buildMixedEntities(
			localFs, remoteFs, stateStore as unknown as SyncStateStore
		);

		expect(result).toHaveLength(1);
		expect(result[0]!.path).toBe("remote.md");
		expect(result[0]!.local).toBeUndefined();
		expect(result[0]!.remote).toBeDefined();
	});

	it("includes prevSync-only records", async () => {
		stateStore.records.set("deleted.md", {
			path: "deleted.md",
			hash: "abc",
			localMtime: 1000,
			remoteMtime: 1000,
			size: 10,
			syncedAt: 900,
		});

		const result = await buildMixedEntities(
			localFs, remoteFs, stateStore as unknown as SyncStateStore
		);

		expect(result).toHaveLength(1);
		expect(result[0]!.path).toBe("deleted.md");
		expect(result[0]!.local).toBeUndefined();
		expect(result[0]!.remote).toBeUndefined();
		expect(result[0]!.prevSync).toBeDefined();
	});

	it("merges entities with the same path from all sources", async () => {
		localFs.seed("shared.md", "local content", 2000);
		remoteFs.seed("shared.md", "remote content", 1500);
		stateStore.records.set("shared.md", {
			path: "shared.md",
			hash: "xyz",
			localMtime: 1000,
			remoteMtime: 1000,
			size: 10,
			syncedAt: 900,
		});

		const result = await buildMixedEntities(
			localFs, remoteFs, stateStore as unknown as SyncStateStore
		);

		expect(result).toHaveLength(1);
		expect(result[0]!.local).toBeDefined();
		expect(result[0]!.remote).toBeDefined();
		expect(result[0]!.prevSync).toBeDefined();
	});

	it("handles multiple files correctly", async () => {
		localFs.seed("a.md", "aaa", 1000);
		localFs.seed("b.md", "bbb", 1000);
		remoteFs.seed("b.md", "bbb remote", 1000);
		remoteFs.seed("c.md", "ccc", 1000);

		const result = await buildMixedEntities(
			localFs, remoteFs, stateStore as unknown as SyncStateStore
		);

		const paths = result.map((e) => e.path).sort();
		expect(paths).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("skips directories", async () => {
		localFs.seed("dir/note.md", "content", 1000);
		// dir/ is implicitly created as a directory by seed

		const result = await buildMixedEntities(
			localFs, remoteFs, stateStore as unknown as SyncStateStore
		);

		// Should only include the file, not the directory
		const filePaths = result.filter((e) => e.path === "note.md" || e.path === "dir/note.md");
		expect(filePaths).toHaveLength(1);
		expect(filePaths[0]!.path).toBe("dir/note.md");

		// No directory entries should appear
		const dirs = result.filter((e) => e.path === "dir");
		expect(dirs).toHaveLength(0);
	});
});
