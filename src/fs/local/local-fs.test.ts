import { describe, it, expect, vi } from "vitest";
import { App, TFile, TFolder } from "obsidian";
import { LocalFs } from "./index";

describe("LocalFs", () => {
	function createLocalFs(dotPaths: string[] = []): { app: App; vault: App["vault"]; fs: LocalFs } {
		const app = new App();
		const fs = new LocalFs(app, () => dotPaths);
		return { app, vault: app.vault, fs };
	}

	describe("mkdirRecursive (via write)", () => {
		it("creates parent directories when writing a nested file", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("hello").buffer;

			await fs.write("a/b/file.txt", content, Date.now());

			expect(vault.getAbstractFileByPath("a")).toBeInstanceOf(TFolder);
			expect(vault.getAbstractFileByPath("a/b")).toBeInstanceOf(TFolder);
		});

		it("skips createFolder when the folder already exists in vault index", async () => {
			const { vault, fs } = createLocalFs();
			await vault.createFolder("a");
			const spy = vi.spyOn(vault, "createFolder");

			const content = new TextEncoder().encode("hello").buffer;
			await fs.write("a/file.txt", content, Date.now());

			expect(spy).not.toHaveBeenCalled();
		});

		it("skips createFolder when folder exists on disk but not in vault index", async () => {
			const { vault, fs } = createLocalFs();
			// getAbstractFileByPath returns null (not in index), but exists() returns true (on disk)
			vi.spyOn(vault, "getAbstractFileByPath").mockReturnValue(null);
			vi.spyOn(vault.adapter, "exists").mockResolvedValue(true);
			const createSpy = vi.spyOn(vault, "createFolder");
			const mockFile = new TFile();
			mockFile.path = "a/file.txt";
			mockFile.stat = { size: 5, mtime: 0, ctime: 0 };
			vi.spyOn(vault, "createBinary").mockResolvedValue(mockFile);

			const content = new TextEncoder().encode("hello").buffer;
			await fs.write("a/file.txt", content, Date.now());

			expect(createSpy).not.toHaveBeenCalled();
		});

		it("calls createFolder when folder does not exist on disk or in index", async () => {
			const { vault, fs } = createLocalFs();
			const createSpy = vi.spyOn(vault, "createFolder");

			const content = new TextEncoder().encode("hello").buffer;
			await fs.write("a/file.txt", content, Date.now());

			expect(createSpy).toHaveBeenCalledWith("a");
		});
	});

	describe("delete (.airsync paths)", () => {
		it("deletes a .airsync file via adapter.remove", async () => {
			const { vault, fs } = createLocalFs();
			await vault.adapter.writeBinary(".airsync/logs/test.log", new ArrayBuffer(8));
			const removeSpy = vi.spyOn(vault.adapter, "remove");

			await fs.delete(".airsync/logs/test.log");

			expect(removeSpy).toHaveBeenCalledWith(".airsync/logs/test.log");
		});

		it("deletes a .airsync directory via adapter.rmdir", async () => {
			const { vault, fs } = createLocalFs();
			// Create a folder with children on the adapter
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".airsync", { type: "folder" });
			vaultInternal.files.set(".airsync/logs", { type: "folder" });
			vaultInternal.files.set(".airsync/logs/test.log", { type: "file", content: new ArrayBuffer(0), mtime: 0 });
			const rmdirSpy = vi.spyOn(vault.adapter, "rmdir");

			await fs.delete(".airsync");

			expect(rmdirSpy).toHaveBeenCalledWith(".airsync", true);
		});

		it("is idempotent for non-existent .airsync path", async () => {
			const { fs } = createLocalFs();
			await expect(fs.delete(".airsync/missing")).resolves.not.toThrow();
		});
	});

	describe("stat (.airsync paths)", () => {
		it("returns FileEntity with hash for a .airsync file", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("log data").buffer;
			await vault.adapter.writeBinary(".airsync/logs/test.log", content);

			const entity = await fs.stat(".airsync/logs/test.log");

			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			expect(entity!.hash).not.toBe("");
			expect(entity!.path).toBe(".airsync/logs/test.log");
		});

		it("returns FileEntity for a .airsync directory", async () => {
			const { vault, fs } = createLocalFs();
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".airsync", { type: "folder" });

			const entity = await fs.stat(".airsync");

			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(true);
		});

		it("returns null for non-existent .airsync path", async () => {
			const { fs } = createLocalFs();
			const entity = await fs.stat(".airsync/missing");
			expect(entity).toBeNull();
		});
	});

	describe("read (.airsync paths)", () => {
		it("reads a .airsync file via adapter", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("log data").buffer;
			await vault.adapter.writeBinary(".airsync/test.log", content);

			const result = await fs.read(".airsync/test.log");
			expect(new TextDecoder().decode(result)).toBe("log data");
		});

		it("throws for non-existent .airsync file", async () => {
			const { fs } = createLocalFs();
			await expect(fs.read(".airsync/missing")).rejects.toThrow("File not found: .airsync/missing");
		});
	});

	describe("write (.airsync paths)", () => {
		it("writes a .airsync file via adapter", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("data").buffer;

			const entity = await fs.write(".airsync/test.log", content, 12345);

			expect(entity.isDirectory).toBe(false);
			expect(entity.path).toBe(".airsync/test.log");
			expect(entity.hash).not.toBe("");
			expect(await vault.adapter.exists(".airsync/test.log")).toBe(true);
		});
	});

	describe("syncDotPaths", () => {
		it("includes custom dot paths in list()", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			vaultInternal.files.set(".templates/daily.md", {
				type: "file",
				content: new TextEncoder().encode("template").buffer,
				mtime: 100,
			});

			const entities = await fs.list();
			const paths = entities.map((e) => e.path);
			expect(paths).toContain(".templates/daily.md");
		});

		it("stat works for custom dot path files", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const content = new TextEncoder().encode("data").buffer;
			await vault.adapter.writeBinary(".templates/note.md", content);

			const entity = await fs.stat(".templates/note.md");
			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			expect(entity!.hash).not.toBe("");
		});

		it("read works for custom dot path files", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const content = new TextEncoder().encode("hello").buffer;
			await vault.adapter.writeBinary(".templates/note.md", content);

			const result = await fs.read(".templates/note.md");
			expect(new TextDecoder().decode(result)).toBe("hello");
		});

		it("write works for custom dot path files", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const content = new TextEncoder().encode("data").buffer;

			const entity = await fs.write(".templates/note.md", content, 12345);
			expect(entity.path).toBe(".templates/note.md");
			expect(await vault.adapter.exists(".templates/note.md")).toBe(true);
		});

		it("delete works for custom dot path files", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			await vault.adapter.writeBinary(".templates/note.md", new ArrayBuffer(0));

			await fs.delete(".templates/note.md");
			expect(await vault.adapter.exists(".templates/note.md")).toBe(false);
		});

		it("listDir works for custom dot path", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			vaultInternal.files.set(".templates/daily.md", {
				type: "file",
				content: new ArrayBuffer(5),
				mtime: 100,
			});

			const entities = await fs.listDir(".templates");
			expect(entities.map((e) => e.path)).toContain(".templates/daily.md");
		});

		it("rename works for custom dot path files", async () => {
			const { vault, fs } = createLocalFs([".templates"]);
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			const content = new TextEncoder().encode("data").buffer;
			await vault.adapter.writeBinary(".templates/old.md", content);

			await fs.rename(".templates/old.md", ".templates/new.md");

			expect(await vault.adapter.exists(".templates/new.md")).toBe(true);
			expect(await vault.adapter.exists(".templates/old.md")).toBe(false);
		});

		it("does not include dot paths when syncDotPaths is empty", async () => {
			const { vault, fs } = createLocalFs();
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".templates", { type: "folder" });
			vaultInternal.files.set(".templates/daily.md", {
				type: "file",
				content: new ArrayBuffer(5),
				mtime: 100,
			});

			const entities = await fs.list();
			const paths = entities.map((e) => e.path);
			expect(paths).not.toContain(".templates");
			expect(paths).not.toContain(".templates/daily.md");
		});
	});
});
