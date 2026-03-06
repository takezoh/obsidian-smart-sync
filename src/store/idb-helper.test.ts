import { describe, it, expect, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBHelper, sanitizeDbName } from "./idb-helper";

describe("IDBHelper", () => {
	let helper: IDBHelper;

	afterEach(async () => {
		await helper?.close();
	});

	function createHelper(): IDBHelper {
		helper = new IDBHelper({
			dbName: `test-idb-${Math.random()}`,
			version: 1,
			onUpgrade: (db) => {
				if (!db.objectStoreNames.contains("items")) {
					db.createObjectStore("items", { keyPath: "id" });
				}
			},
		});
		return helper;
	}

	it("open/close are idempotent", async () => {
		const h = createHelper();
		await h.open();
		await h.open();
		await h.close();
		await h.close();
	});

	it("runTransaction writes and reads data", async () => {
		const h = createHelper();

		await h.runTransaction("items", "readwrite", (tx) => {
			tx.objectStore("items").put({ id: "a", value: 42 });
			return () => {};
		});

		const result = await h.runTransaction("items", "readonly", (tx) => {
			const req = tx.objectStore("items").get("a");
			return () => req.result as { id: string; value: number };
		});

		expect(result).toEqual({ id: "a", value: 42 });
	});

	it("recovers after onversionchange closes the db", async () => {
		const h = createHelper();
		await h.open();

		const internal = h as unknown as {
			db: IDBDatabase | null;
			openPromise: Promise<void> | null;
		};
		internal.db?.close();
		internal.db = null;
		internal.openPromise = null;

		// getDb() should re-open
		const db = await h.getDb();
		expect(db).toBeTruthy();
	});
});

describe("sanitizeDbName", () => {
	it("replaces non-alphanumeric characters", () => {
		expect(sanitizeDbName("my vault/name.ext")).toBe("my_vault_name_ext");
	});

	it("preserves hyphens and underscores", () => {
		expect(sanitizeDbName("vault-id_123")).toBe("vault-id_123");
	});
});
