import { describe, it, expect, vi } from "vitest";
import { App, TFile, TFolder } from "obsidian";
import { LocalFs } from "./index";

describe("LocalFs", () => {
	function createLocalFs(): { app: App; vault: App["vault"]; fs: LocalFs } {
		const app = new App();
		const fs = new LocalFs(app);
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
			// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
			const mockFile: TFile = Object.create((await import("obsidian")).TFile.prototype) as TFile;
			Object.assign(mockFile, { path: "a/file.txt", stat: { size: 5, mtime: 0 } });
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

	describe("delete (.smartsync paths)", () => {
		it("deletes a .smartsync file via adapter.remove", async () => {
			const { vault, fs } = createLocalFs();
			await vault.adapter.writeBinary(".smartsync/logs/test.log", new ArrayBuffer(8));
			const removeSpy = vi.spyOn(vault.adapter, "remove");

			await fs.delete(".smartsync/logs/test.log");

			expect(removeSpy).toHaveBeenCalledWith(".smartsync/logs/test.log");
		});

		it("deletes a .smartsync directory via adapter.rmdir", async () => {
			const { vault, fs } = createLocalFs();
			// Create a folder with children on the adapter
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".smartsync", { type: "folder" });
			vaultInternal.files.set(".smartsync/logs", { type: "folder" });
			vaultInternal.files.set(".smartsync/logs/test.log", { type: "file", content: new ArrayBuffer(0), mtime: 0 });
			const rmdirSpy = vi.spyOn(vault.adapter, "rmdir");

			await fs.delete(".smartsync");

			expect(rmdirSpy).toHaveBeenCalledWith(".smartsync", true);
		});

		it("is idempotent for non-existent .smartsync path", async () => {
			const { fs } = createLocalFs();
			await expect(fs.delete(".smartsync/missing")).resolves.not.toThrow();
		});
	});

	describe("stat (.smartsync paths)", () => {
		it("returns FileEntity with hash for a .smartsync file", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("log data").buffer;
			await vault.adapter.writeBinary(".smartsync/logs/test.log", content);

			const entity = await fs.stat(".smartsync/logs/test.log");

			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			expect(entity!.hash).not.toBe("");
			expect(entity!.path).toBe(".smartsync/logs/test.log");
		});

		it("returns FileEntity for a .smartsync directory", async () => {
			const { vault, fs } = createLocalFs();
			const vaultInternal = vault as unknown as { files: Map<string, unknown> };
			vaultInternal.files.set(".smartsync", { type: "folder" });

			const entity = await fs.stat(".smartsync");

			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(true);
		});

		it("returns null for non-existent .smartsync path", async () => {
			const { fs } = createLocalFs();
			const entity = await fs.stat(".smartsync/missing");
			expect(entity).toBeNull();
		});
	});

	describe("read (.smartsync paths)", () => {
		it("reads a .smartsync file via adapter", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("log data").buffer;
			await vault.adapter.writeBinary(".smartsync/test.log", content);

			const result = await fs.read(".smartsync/test.log");
			expect(new TextDecoder().decode(result)).toBe("log data");
		});

		it("throws for non-existent .smartsync file", async () => {
			const { fs } = createLocalFs();
			await expect(fs.read(".smartsync/missing")).rejects.toThrow("File not found: .smartsync/missing");
		});
	});

	describe("write (.smartsync paths)", () => {
		it("writes a .smartsync file via adapter", async () => {
			const { vault, fs } = createLocalFs();
			const content = new TextEncoder().encode("data").buffer;

			const entity = await fs.write(".smartsync/test.log", content, 12345);

			expect(entity.isDirectory).toBe(false);
			expect(entity.path).toBe(".smartsync/test.log");
			expect(entity.hash).not.toBe("");
			expect(await vault.adapter.exists(".smartsync/test.log")).toBe(true);
		});
	});

});
