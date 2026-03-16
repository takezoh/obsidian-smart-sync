import { describe, it, expect } from "vitest";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import type { FileEntity } from "../fs/types";
import type { SyncRecord } from "./types";

function makeFile(overrides: Partial<FileEntity> = {}): FileEntity {
	return {
		path: "test.md",
		isDirectory: false,
		size: 100,
		mtime: 1000,
		hash: "abc",
		...overrides,
	};
}

function makeRecord(overrides: Partial<SyncRecord> = {}): SyncRecord {
	return {
		path: "test.md",
		hash: "abc",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 100,
		remoteSize: 100,
		syncedAt: 900,
		...overrides,
	};
}

describe("hasChanged", () => {
	it("returns false when mtime, size, and hash all match", () => {
		const file = makeFile({ mtime: 1000, size: 100, hash: "abc" });
		const record = makeRecord({ localMtime: 1000, localSize: 100, hash: "abc" });
		expect(hasChanged(file, record)).toBe(false);
	});

	it("returns true when mtime differs and no hash available", () => {
		const file = makeFile({ mtime: 2000, hash: "" });
		const record = makeRecord({ localMtime: 1000, hash: "" });
		expect(hasChanged(file, record)).toBe(true);
	});

	it("returns true when mtime differs and hash differs", () => {
		const file = makeFile({ mtime: 2000, hash: "new" });
		const record = makeRecord({ localMtime: 1000, hash: "old" });
		expect(hasChanged(file, record)).toBe(true);
	});

	it("returns false when mtime differs but hash matches (touch without edit)", () => {
		const file = makeFile({ mtime: 1001, hash: "abc" });
		const record = makeRecord({ localMtime: 1000, hash: "abc" });
		expect(hasChanged(file, record)).toBe(false);
	});

	it("returns true when mtime+size match but hash differs (same-size edit)", () => {
		const file = makeFile({ mtime: 1000, size: 100, hash: "new-hash" });
		const record = makeRecord({ localMtime: 1000, localSize: 100, hash: "old-hash" });
		expect(hasChanged(file, record)).toBe(true);
	});

	it("returns true when size differs and no hash", () => {
		const file = makeFile({ mtime: 1000, size: 200, hash: "" });
		const record = makeRecord({ localMtime: 1000, localSize: 100, hash: "" });
		expect(hasChanged(file, record)).toBe(true);
	});

	it("returns true when size differs but hash matches (conservative)", () => {
		const file = makeFile({ mtime: 1000, size: 200, hash: "abc" });
		const record = makeRecord({ localMtime: 1000, localSize: 100, hash: "abc" });
		expect(hasChanged(file, record)).toBe(false);
	});

	it("falls back to hash when mtime is 0", () => {
		const file = makeFile({ mtime: 0, hash: "abc" });
		const record = makeRecord({ localMtime: 0, hash: "abc" });
		expect(hasChanged(file, record)).toBe(false);
	});

	it("falls back to hash when record localMtime is 0", () => {
		const file = makeFile({ mtime: 1000, hash: "new" });
		const record = makeRecord({ localMtime: 0, hash: "old" });
		expect(hasChanged(file, record)).toBe(true);
	});

	it("conservative: returns true when mtime is 0 and hash is empty", () => {
		const file = makeFile({ mtime: 0, hash: "" });
		const record = makeRecord({ localMtime: 0, hash: "" });
		expect(hasChanged(file, record)).toBe(true);
	});

	it("conservative: returns true when mtime is 0 and no hash on file", () => {
		const file = makeFile({ mtime: 0, hash: "" });
		const record = makeRecord({ localMtime: 0, hash: "abc" });
		expect(hasChanged(file, record)).toBe(true);
	});
});

describe("hasRemoteChanged", () => {
	it("returns false when mtime, size, and hash all match", () => {
		const file = makeFile({ mtime: 1000, size: 100, hash: "abc" });
		const record = makeRecord({ remoteMtime: 1000, remoteSize: 100, hash: "abc" });
		expect(hasRemoteChanged(file, record)).toBe(false);
	});

	it("returns true when mtime differs and no md5 or hash", () => {
		const file = makeFile({ mtime: 2000, hash: "" });
		const record = makeRecord({ remoteMtime: 1000, hash: "" });
		expect(hasRemoteChanged(file, record)).toBe(true);
	});

	it("returns true when mtime differs and md5 differs", () => {
		const file = makeFile({ mtime: 2000, backendMeta: { contentChecksum: "bbb" } });
		const record = makeRecord({ remoteMtime: 1000, backendMeta: { contentChecksum: "aaa" } });
		expect(hasRemoteChanged(file, record)).toBe(true);
	});

	it("returns false when mtime differs but md5 matches (Drive mtime jitter)", () => {
		const file = makeFile({ mtime: 1001, backendMeta: { contentChecksum: "aaa" } });
		const record = makeRecord({ remoteMtime: 1000, backendMeta: { contentChecksum: "aaa" } });
		expect(hasRemoteChanged(file, record)).toBe(false);
	});

	it("returns true when mtime+size match but hash differs (same-size edit)", () => {
		const file = makeFile({ mtime: 1000, size: 100, hash: "new-hash" });
		const record = makeRecord({ remoteMtime: 1000, remoteSize: 100, hash: "old-hash" });
		expect(hasRemoteChanged(file, record)).toBe(true);
	});

	it("returns false when mtime+size match and hash matches", () => {
		const file = makeFile({ mtime: 1000, size: 100, hash: "same" });
		const record = makeRecord({ remoteMtime: 1000, remoteSize: 100, hash: "same" });
		expect(hasRemoteChanged(file, record)).toBe(false);
	});

	it("falls back to md5 when mtime is 0 and md5 matches", () => {
		const file = makeFile({ mtime: 0, hash: "", backendMeta: { contentChecksum: "aaa" } });
		const record = makeRecord({ remoteMtime: 0, hash: "", backendMeta: { contentChecksum: "aaa" } });
		expect(hasRemoteChanged(file, record)).toBe(false);
	});

	it("returns true when mtime is 0 and md5 differs", () => {
		const file = makeFile({ mtime: 0, hash: "", backendMeta: { contentChecksum: "bbb" } });
		const record = makeRecord({ remoteMtime: 0, hash: "", backendMeta: { contentChecksum: "aaa" } });
		expect(hasRemoteChanged(file, record)).toBe(true);
	});

	it("falls back to hash when mtime is 0 and md5 unavailable, hashes match", () => {
		const file = makeFile({ mtime: 0, hash: "abc" });
		const record = makeRecord({ remoteMtime: 0, hash: "abc" });
		expect(hasRemoteChanged(file, record)).toBe(false);
	});

	it("falls back to hash when mtime is 0 and md5 unavailable, hashes differ", () => {
		const file = makeFile({ mtime: 0, hash: "new" });
		const record = makeRecord({ remoteMtime: 0, hash: "old" });
		expect(hasRemoteChanged(file, record)).toBe(true);
	});

	it("conservative: returns true when mtime is 0 and no md5 or hash", () => {
		const file = makeFile({ mtime: 0, hash: "" });
		const record = makeRecord({ remoteMtime: 0, hash: "" });
		expect(hasRemoteChanged(file, record)).toBe(true);
	});

	it("treats non-string contentChecksum as unavailable (falls through to hash)", () => {
		const file = makeFile({ mtime: 0, hash: "abc", backendMeta: { contentChecksum: 12345 } });
		const record = makeRecord({ remoteMtime: 0, hash: "abc", backendMeta: { contentChecksum: null } });
		expect(hasRemoteChanged(file, record)).toBe(false);
	});

	it("treats undefined contentChecksum as unavailable", () => {
		const file = makeFile({ mtime: 0, hash: "different", backendMeta: { contentChecksum: undefined } });
		const record = makeRecord({ remoteMtime: 0, hash: "abc", backendMeta: { contentChecksum: undefined } });
		expect(hasRemoteChanged(file, record)).toBe(true);
	});

	it("mtime differs, md5 present only on file side → conservative changed", () => {
		const file = makeFile({ mtime: 2000, backendMeta: { contentChecksum: "aaa" } });
		const record = makeRecord({ remoteMtime: 1000 });
		expect(hasRemoteChanged(file, record)).toBe(true);
	});

	it("mtime differs, md5 present only on record side → conservative changed", () => {
		const file = makeFile({ mtime: 2000 });
		const record = makeRecord({ remoteMtime: 1000, backendMeta: { contentChecksum: "aaa" } });
		expect(hasRemoteChanged(file, record)).toBe(true);
	});
});
