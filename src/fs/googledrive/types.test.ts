import { describe, it, expect } from "vitest";
import { assertDriveFile, assertDriveFileList, assertDriveChangeList } from "./types";

describe("assertDriveFile", () => {
	it("accepts a valid file", () => {
		expect(() =>
			assertDriveFile({ id: "1", name: "a.txt", mimeType: "text/plain" })
		).not.toThrow();
	});

	it("rejects when mimeType is missing", () => {
		expect(() =>
			assertDriveFile({ id: "1", name: "a.txt" })
		).toThrow("Invalid file metadata");
	});

	it("rejects when mimeType is not a string", () => {
		expect(() =>
			assertDriveFile({ id: "1", name: "a.txt", mimeType: 42 })
		).toThrow("Invalid file metadata");
	});
});

describe("assertDriveFileList", () => {
	it("accepts a valid file list", () => {
		expect(() =>
			assertDriveFileList({
				files: [{ id: "1", name: "a.txt", mimeType: "text/plain" }],
			})
		).not.toThrow();
	});

	it("rejects when files array contains null", () => {
		expect(() =>
			assertDriveFileList({ files: [null] })
		).toThrow("Invalid file metadata");
	});

	it("rejects when a file is missing id", () => {
		expect(() =>
			assertDriveFileList({ files: [{ name: "a.txt", mimeType: "text/plain" }] })
		).toThrow("Invalid file metadata");
	});
});

describe("assertDriveChangeList", () => {
	it("accepts a valid change list", () => {
		expect(() =>
			assertDriveChangeList({
				changes: [
					{ type: "file", fileId: "abc", removed: false },
				],
			})
		).not.toThrow();
	});

	it("rejects when a change entry has non-string fileId", () => {
		expect(() =>
			assertDriveChangeList({
				changes: [{ type: "file", fileId: 123, removed: false }],
			})
		).toThrow("Invalid change entry");
	});

	it("rejects when removed is not a boolean", () => {
		expect(() =>
			assertDriveChangeList({
				changes: [{ type: "file", fileId: "abc", removed: "false" }],
			})
		).toThrow("Invalid change entry");
	});

	it("rejects when type is missing", () => {
		expect(() =>
			assertDriveChangeList({
				changes: [{ fileId: "abc", removed: false }],
			})
		).toThrow("Invalid change entry");
	});

	it("validates file field inside a change entry", () => {
		expect(() =>
			assertDriveChangeList({
				changes: [
					{
						type: "file",
						fileId: "abc",
						removed: false,
						file: { id: 42, name: "bad" },
					},
				],
			})
		).toThrow("Invalid file metadata");
	});
});
