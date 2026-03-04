import { describe, it, expect, beforeEach } from "vitest";
import { MockFs } from "./index";

describe("MockFs", () => {
	let fs: MockFs;

	beforeEach(() => {
		fs = new MockFs("test");
	});

	describe("rename", () => {
		it("renames a single file", async () => {
			fs.seed("a.txt", "hello");
			await fs.rename("a.txt", "b.txt");
			expect(fs.has("a.txt")).toBe(false);
			expect(fs.readString("b.txt")).toBe("hello");
		});

		it("renames a directory and all its children", async () => {
			fs.seed("dir/a.txt", "aaa");
			fs.seed("dir/sub/b.txt", "bbb");
			await fs.rename("dir", "renamed");
			expect(fs.has("dir")).toBe(false);
			expect(fs.has("dir/a.txt")).toBe(false);
			expect(fs.has("dir/sub/b.txt")).toBe(false);
			expect(fs.readString("renamed/a.txt")).toBe("aaa");
			expect(fs.readString("renamed/sub/b.txt")).toBe("bbb");
			expect(fs.has("renamed")).toBe(true);
			expect(fs.has("renamed/sub")).toBe(true);
		});

		it("does not affect entries that share a prefix but are not children", async () => {
			fs.seed("dir-extra/c.txt", "ccc");
			fs.seed("dir/a.txt", "aaa");
			await fs.rename("dir", "renamed");
			expect(fs.readString("dir-extra/c.txt")).toBe("ccc");
		});

		it("throws when source does not exist", async () => {
			await expect(fs.rename("missing", "dest")).rejects.toThrow("File not found: missing");
		});

		it("throws when destination already exists", async () => {
			fs.seed("a.txt", "aaa");
			fs.seed("b.txt", "bbb");
			await expect(fs.rename("a.txt", "b.txt")).rejects.toThrow("Destination already exists: b.txt");
		});

		it("throws when renaming to itself", async () => {
			fs.seed("a.txt", "hello");
			await expect(fs.rename("a.txt", "a.txt")).rejects.toThrow(
				'Cannot rename "a.txt" to itself'
			);
		});

		it("throws when moving into own subtree", async () => {
			fs.seed("dir/a.txt", "aaa");
			await expect(fs.rename("dir", "dir/sub")).rejects.toThrow(
				'Cannot move "dir" into its own subtree "dir/sub"'
			);
		});

		it("creates parent directories for new path", async () => {
			fs.seed("a.txt", "hello");
			await fs.rename("a.txt", "new-dir/sub/b.txt");
			expect(fs.has("new-dir")).toBe(true);
			expect(fs.has("new-dir/sub")).toBe(true);
			expect(fs.readString("new-dir/sub/b.txt")).toBe("hello");
		});

		it("preserves file content and mtime through rename", async () => {
			fs.seed("old.txt", "content", 12345);
			await fs.rename("old.txt", "new.txt");
			const entity = await fs.stat("new.txt");
			expect(entity).not.toBeNull();
			expect(entity!.mtime).toBe(12345);
			expect(fs.readString("new.txt")).toBe("content");
		});
	});

	describe("list", () => {
		it("returns all seeded files and directories", async () => {
			fs.seed("a.txt", "aaa");
			fs.seed("dir/b.txt", "bbb");
			const entities = await fs.list();
			const paths = entities.map((e) => e.path).sort();
			expect(paths).toContain("a.txt");
			expect(paths).toContain("dir");
			expect(paths).toContain("dir/b.txt");
		});

		it("returns empty array when no files exist", async () => {
			const entities = await fs.list();
			expect(entities).toEqual([]);
		});

		it("returns hash as empty string for performance", async () => {
			fs.seed("a.txt", "hello");
			const entities = await fs.list();
			const file = entities.find((e) => e.path === "a.txt");
			expect(file!.hash).toBe("");
		});

		it("returns correct size and mtime", async () => {
			fs.seed("a.txt", "hello", 99999);
			const entities = await fs.list();
			const file = entities.find((e) => e.path === "a.txt");
			expect(file!.mtime).toBe(99999);
			expect(file!.size).toBe(new TextEncoder().encode("hello").byteLength);
		});
	});

	describe("stat", () => {
		it("returns FileEntity with hash for an existing file", async () => {
			fs.seed("a.txt", "hello");
			const entity = await fs.stat("a.txt");
			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			expect(entity!.hash).not.toBe("");
		});

		it("returns FileEntity for a directory", async () => {
			await fs.mkdir("dir");
			const entity = await fs.stat("dir");
			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(true);
			expect(entity!.hash).toBe("");
		});

		it("returns null for non-existent path", async () => {
			const entity = await fs.stat("missing");
			expect(entity).toBeNull();
		});
	});

	describe("read", () => {
		it("returns file content as ArrayBuffer", async () => {
			fs.seed("a.txt", "hello");
			const buf = await fs.read("a.txt");
			const text = new TextDecoder().decode(buf);
			expect(text).toBe("hello");
		});

		it("returns a copy (not the original buffer)", async () => {
			fs.seed("a.txt", "hello");
			const buf1 = await fs.read("a.txt");
			const buf2 = await fs.read("a.txt");
			expect(buf1).not.toBe(buf2);
		});

		it("throws for non-existent file", async () => {
			await expect(fs.read("missing")).rejects.toThrow("File not found: missing");
		});

		it("throws for a directory with distinct message", async () => {
			await fs.mkdir("dir");
			await expect(fs.read("dir")).rejects.toThrow(
				"Not a file (is a directory): dir"
			);
		});
	});

	describe("write", () => {
		it("creates a new file and returns FileEntity with hash", async () => {
			const content = new TextEncoder().encode("hello").buffer.slice(0);
			const entity = await fs.write("a.txt", content, Date.now());
			expect(entity.isDirectory).toBe(false);
			expect(entity.hash).not.toBe("");
			expect(fs.readString("a.txt")).toBe("hello");
		});

		it("overwrites existing file", async () => {
			fs.seed("a.txt", "old");
			const content = new TextEncoder().encode("new").buffer.slice(0);
			await fs.write("a.txt", content, Date.now());
			expect(fs.readString("a.txt")).toBe("new");
		});

		it("creates parent directories automatically", async () => {
			const content = new TextEncoder().encode("data").buffer.slice(0);
			await fs.write("a/b/c.txt", content, Date.now());
			expect(fs.has("a")).toBe(true);
			expect(fs.has("a/b")).toBe(true);
			expect(fs.readString("a/b/c.txt")).toBe("data");
		});

		it("throws when writing to an existing directory", async () => {
			await fs.mkdir("dir");
			const content = new TextEncoder().encode("data").buffer.slice(0);
			await expect(fs.write("dir", content, Date.now())).rejects.toThrow(
				'Cannot write file: "dir" is an existing directory'
			);
		});

		it("uses provided mtime", async () => {
			const content = new TextEncoder().encode("data").buffer.slice(0);
			const entity = await fs.write("a.txt", content, 12345);
			expect(entity.mtime).toBe(12345);
		});
	});

	describe("delete", () => {
		it("deletes a file", async () => {
			fs.seed("a.txt", "hello");
			await fs.delete("a.txt");
			expect(fs.has("a.txt")).toBe(false);
		});

		it("deletes a directory and all children", async () => {
			fs.seed("dir/a.txt", "aaa");
			fs.seed("dir/sub/b.txt", "bbb");
			await fs.delete("dir");
			expect(fs.has("dir")).toBe(false);
			expect(fs.has("dir/a.txt")).toBe(false);
			expect(fs.has("dir/sub/b.txt")).toBe(false);
		});

		it("is idempotent for non-existent path", async () => {
			await expect(fs.delete("missing")).resolves.not.toThrow();
		});

		it("does not affect entries sharing a prefix", async () => {
			fs.seed("dir/a.txt", "aaa");
			fs.seed("dir-extra/b.txt", "bbb");
			await fs.delete("dir");
			expect(fs.readString("dir-extra/b.txt")).toBe("bbb");
		});
	});

	describe("mkdir", () => {
		it("creates a directory", async () => {
			await fs.mkdir("a");
			expect(fs.has("a")).toBe(true);
			const entity = await fs.stat("a");
			expect(entity!.isDirectory).toBe(true);
		});

		it("creates intermediate directories", async () => {
			await fs.mkdir("a/b/c");
			expect(fs.has("a")).toBe(true);
			expect(fs.has("a/b")).toBe(true);
			expect(fs.has("a/b/c")).toBe(true);
		});

		it("is idempotent for existing directories", async () => {
			await fs.mkdir("a/b");
			await expect(fs.mkdir("a/b")).resolves.not.toThrow();
		});

		it("throws if an intermediate path is a file", async () => {
			fs.seed("a/b", "file-content");
			await expect(fs.mkdir("a/b/c")).rejects.toThrow(
				'Cannot create directory "a/b/c": "a/b" is a file'
			);
		});

		it("throws if the target path itself is a file", async () => {
			fs.seed("x", "file");
			await expect(fs.mkdir("x")).rejects.toThrow(
				'Cannot create directory "x": "x" is a file'
			);
		});
	});

	describe("path normalization", () => {
		it("stat with trailing slash", async () => {
			fs.seed("a.txt", "hello");
			const entity = await fs.stat("a.txt/");
			expect(entity).not.toBeNull();
			expect(entity!.path).toBe("a.txt");
		});

		it("stat with leading slash", async () => {
			fs.seed("a.txt", "hello");
			const entity = await fs.stat("/a.txt");
			expect(entity).not.toBeNull();
		});

		it("read with backslash path", async () => {
			fs.seed("dir/a.txt", "hello");
			const buf = await fs.read("dir\\a.txt");
			expect(new TextDecoder().decode(buf)).toBe("hello");
		});

		it("write with double slash", async () => {
			const content = new TextEncoder().encode("data").buffer.slice(0);
			await fs.write("dir//a.txt", content, 100);
			expect(fs.readString("dir/a.txt")).toBe("data");
		});

		it("delete with leading slash", async () => {
			fs.seed("a.txt", "hello");
			await fs.delete("/a.txt");
			expect(fs.has("a.txt")).toBe(false);
		});
	});
});
