import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { SyncStateStore } from "./state";
import type { SyncRecord } from "../fs/types";

function makeRecord(path: string, overrides: Partial<SyncRecord> = {}): SyncRecord {
	return {
		path,
		hash: "abc",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 100,
		remoteSize: 100,
		syncedAt: 900,
		...overrides,
	};
}

describe("SyncStateStore", () => {
	let store: SyncStateStore;

	beforeEach(() => {
		store = new SyncStateStore(`test-vault-${Math.random()}`);
	});

	afterEach(async () => {
		await store.close();
	});

	it("open: opens successfully and can be called multiple times", async () => {
		await store.open();
		await store.open(); // idempotent
	});

	it("put + get: round-trips a sync record", async () => {
		const record = makeRecord("notes/hello.md");
		await store.put(record);
		const result = await store.get("notes/hello.md");
		expect(result).toEqual(record);
	});

	it("get: returns undefined for nonexistent path", async () => {
		const result = await store.get("does-not-exist.md");
		expect(result).toBeUndefined();
	});

	it("getAll: returns all stored records", async () => {
		await store.put(makeRecord("a.md"));
		await store.put(makeRecord("b.md"));
		await store.put(makeRecord("c.md"));

		const all = await store.getAll();
		expect(all).toHaveLength(3);
		const paths = all.map((r) => r.path).sort();
		expect(paths).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("getAll: returns empty array when no records exist", async () => {
		const all = await store.getAll();
		expect(all).toHaveLength(0);
	});

	it("put: updates an existing record", async () => {
		await store.put(makeRecord("a.md", { localSize: 100 }));
		await store.put(makeRecord("a.md", { localSize: 200 }));

		const result = await store.get("a.md");
		expect(result?.localSize).toBe(200);

		const all = await store.getAll();
		expect(all).toHaveLength(1);
	});

	it("delete: removes a record and its content", async () => {
		const content = new TextEncoder().encode("hello").buffer as ArrayBuffer;
		await store.put(makeRecord("a.md"));
		await store.putContent("a.md", content);

		await store.delete("a.md");

		expect(await store.get("a.md")).toBeUndefined();
		expect(await store.getContent("a.md")).toBeUndefined();
	});

	it("delete: does not throw for nonexistent path", async () => {
		await expect(store.delete("nonexistent.md")).resolves.toBeUndefined();
	});

	it("clear: removes all records and content", async () => {
		const content = new TextEncoder().encode("data").buffer as ArrayBuffer;
		await store.put(makeRecord("a.md"));
		await store.put(makeRecord("b.md"));
		await store.putContent("a.md", content);

		await store.clear();

		expect(await store.getAll()).toHaveLength(0);
		expect(await store.getContent("a.md")).toBeUndefined();
	});

	it("putContent + getContent: round-trips content", async () => {
		const content = new TextEncoder().encode("hello world").buffer as ArrayBuffer;
		await store.putContent("notes/test.md", content);

		const result = await store.getContent("notes/test.md");
		expect(result).toBeDefined();
		const text = new TextDecoder().decode(result);
		expect(text).toBe("hello world");
	});

	it("getContent: returns undefined for nonexistent path", async () => {
		const result = await store.getContent("nonexistent.md");
		expect(result).toBeUndefined();
	});

	it("close: can be called multiple times safely", async () => {
		await store.open();
		await store.close();
		await store.close();
	});

	it("concurrent open() calls resolve without error", async () => {
		await Promise.all([store.open(), store.open(), store.open()]);
		// Should work normally after concurrent opens
		await store.put(makeRecord("a.md"));
		const result = await store.get("a.md");
		expect(result?.path).toBe("a.md");
	});

	it("close then re-open works correctly", async () => {
		await store.put(makeRecord("a.md"));
		await store.close();
		await store.open();
		const result = await store.get("a.md");
		expect(result?.path).toBe("a.md");
	});

	it("re-opens after close", async () => {
		await store.put(makeRecord("a.md"));
		await store.close();

		// Re-open and verify data persists
		const result = await store.get("a.md");
		expect(result?.path).toBe("a.md");
	});

	it("recovers after onversionchange closes the db", async () => {
		await store.put(makeRecord("a.md"));

		// Simulate onversionchange: close db and null it out
		const internal = store as unknown as {
			helper: { db: IDBDatabase | null; openPromise: Promise<void> | null };
		};
		internal.helper.db?.close();
		internal.helper.db = null;
		internal.helper.openPromise = null;

		// getDb() should re-open and recover
		const result = await store.get("a.md");
		expect(result?.path).toBe("a.md");
	});
});
