import { describe, it, expect, beforeEach } from "vitest";
import type { LoggerAdapter } from "../logging/logger";
import type { ConflictRecord } from "./types";
import { ConflictHistory } from "./conflict-history";

function createMockAdapter(): LoggerAdapter & { files: Map<string, string>; dirs: Set<string> } {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	return {
		files,
		dirs,
		exists: (path: string) => Promise.resolve(files.has(path) || dirs.has(path)),
		read: (path: string) => {
			const content = files.get(path);
			if (content === undefined) return Promise.reject(new Error(`File not found: ${path}`));
			return Promise.resolve(content);
		},
		write: (path: string, data: string) => {
			files.set(path, data);
			return Promise.resolve();
		},
		mkdir: (path: string) => {
			dirs.add(path);
			return Promise.resolve();
		},
	};
}

function makeRecord(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
	return {
		path: "notes/test.md",
		actionType: "conflict",
		strategy: "auto_merge",
		action: "kept_local",
		resolvedAt: "2026-03-07T10:00:00.000Z",
		sessionId: "test-session",
		...overrides,
	};
}

const DEVICE = "test-desktop";
const FILE_PATH = `.airsync/conflicts/${DEVICE}.json`;

describe("ConflictHistory", () => {
	let adapter: ReturnType<typeof createMockAdapter>;
	let history: ConflictHistory;

	beforeEach(() => {
		adapter = createMockAdapter();
		history = new ConflictHistory(adapter, DEVICE);
	});

	it("load() returns empty array when file does not exist", async () => {
		const records = await history.load();
		expect(records).toEqual([]);
	});

	it("append() + load() round-trip", async () => {
		const record = makeRecord({ path: "a.md" });
		await history.append([record]);

		const loaded = await history.load();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]!.path).toBe("a.md");
	});

	it("append() accumulates records across calls", async () => {
		await history.append([makeRecord({ path: "a.md" })]);
		await history.append([makeRecord({ path: "b.md" })]);

		const loaded = await history.load();
		expect(loaded).toHaveLength(2);
		expect(loaded[0]!.path).toBe("a.md");
		expect(loaded[1]!.path).toBe("b.md");
	});

	it("gracefully handles corrupted JSON", async () => {
		adapter.files.set(FILE_PATH, "not valid json{{{");

		const records = await history.load();
		expect(records).toEqual([]);

		// Can still append after corruption
		await history.append([makeRecord()]);
		const loaded = await history.load();
		expect(loaded).toHaveLength(1);
	});

	it("caps records at MAX_RECORDS (500)", async () => {
		const existing: ConflictRecord[] = [];
		for (let i = 0; i < 499; i++) {
			existing.push(makeRecord({ path: `old-${i}.md` }));
		}
		adapter.dirs.add(".airsync");
		adapter.dirs.add(".airsync/conflicts");
		adapter.files.set(FILE_PATH, JSON.stringify(existing));

		await history.append([
			makeRecord({ path: "new-1.md" }),
			makeRecord({ path: "new-2.md" }),
		]);

		const loaded = await history.load();
		expect(loaded).toHaveLength(500);
		// Oldest record should be trimmed
		expect(loaded[0]!.path).toBe("old-1.md");
		expect(loaded[loaded.length - 1]!.path).toBe("new-2.md");
	});

	it("append() with empty array is a no-op", async () => {
		await history.append([]);

		expect(adapter.files.has(FILE_PATH)).toBe(false);
	});

	it("creates .airsync and conflicts directories if missing", async () => {
		await history.append([makeRecord()]);

		expect(adapter.dirs.has(".airsync")).toBe(true);
		expect(adapter.dirs.has(".airsync/conflicts")).toBe(true);
		expect(adapter.files.has(FILE_PATH)).toBe(true);
	});

	it("uses separate files per device", async () => {
		const mobileHistory = new ConflictHistory(adapter, "mobile-phone");

		await history.append([makeRecord({ path: "desktop.md" })]);
		await mobileHistory.append([makeRecord({ path: "mobile.md" })]);

		const desktopRecords = await history.load();
		const mobileRecords = await mobileHistory.load();

		expect(desktopRecords).toHaveLength(1);
		expect(desktopRecords[0]!.path).toBe("desktop.md");
		expect(mobileRecords).toHaveLength(1);
		expect(mobileRecords[0]!.path).toBe("mobile.md");

		// Verify sanitized file names
		expect(adapter.files.has(FILE_PATH)).toBe(true);
		expect(adapter.files.has(".airsync/conflicts/mobile-phone.json")).toBe(true);
	});
});
