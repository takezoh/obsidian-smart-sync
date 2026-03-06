import { describe, it, expect, vi } from "vitest";
import { spyRequestUrl, mockRes } from "./test-helpers";
import type { DriveClientInternal } from "./test-helpers";

vi.mock("obsidian");

describe("DriveClient error wrapping", () => {
	it("wraps errors with operation name", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockRejectedValue(
			new Error("Request failed")
		);

		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");
		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const client = new DriveClient(auth);
		await expect(client.listFiles("folder-id")).rejects.toThrow(
			"Drive API listFiles failed: Request failed"
		);

		mockRequestUrl.mockRestore();
	});

	it("preserves HTTP status and headers on wrapped errors", async () => {
		const originalError = Object.assign(new Error("Forbidden"), {
			status: 403,
			headers: { "retry-after": "30" },
		});
		const mockRequestUrl = (await spyRequestUrl()).mockRejectedValue(originalError);

		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");
		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const client = new DriveClient(auth);
		try {
			await client.downloadFile("file-id");
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("Drive API downloadFile failed");
			const errObj = err as Record<string, unknown>;
			expect(errObj.status).toBe(403);
			expect(errObj.headers).toEqual({ "retry-after": "30" });
		}

		mockRequestUrl.mockRestore();
	});
});

describe("DriveClient.uploadFile modifiedTime default", () => {
	it("does not send epoch (1970) when modifiedTime is omitted", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			async () => mockRes({ id: "f1", name: "test.txt", mimeType: "text/plain" })
		);

		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");
		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const client = new DriveClient(auth);
		const content = new TextEncoder().encode("hello").buffer;

		// Call without modifiedTime parameter
		await client.uploadFile("test.txt", "parent-id", content as ArrayBuffer);

		// The multipart body should contain a modifiedTime that is NOT 1970
		const callArgs = mockRequestUrl.mock.calls[0]![0] as { body?: ArrayBuffer };
		const bodyText = new TextDecoder().decode(callArgs.body);
		const metaMatch = bodyText.match(/"modifiedTime":"([^"]+)"/);
		expect(metaMatch).toBeTruthy();
		const year = new Date(metaMatch![1]!).getFullYear();
		expect(year).toBeGreaterThan(2020);

		mockRequestUrl.mockRestore();
	});
});

describe("DriveClient.listAllFiles parallelization", () => {
	it("fetches nested folders concurrently via AsyncPool(3)", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		// Track concurrent calls to detect parallelism
		let concurrent = 0;
		let maxConcurrent = 0;

		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async (req) => {
			concurrent++;
			if (concurrent > maxConcurrent) maxConcurrent = concurrent;

			// Small delay to allow parallel calls to overlap
			await new Promise((r) => setTimeout(r, 10));

			const url = typeof req === "string" ? req : req.url;
			const params = new URLSearchParams(url.split("?")[1]);
			const q = params.get("q") ?? "";

			let files: unknown[] = [];
			if (q.includes("'root'")) {
				// Root contains 3 subfolders
				files = [
					{ id: "f1", name: "folder1", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
					{ id: "f2", name: "folder2", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
					{ id: "f3", name: "folder3", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				];
			} else if (q.includes("'f1'")) {
				files = [{ id: "a", name: "a.txt", mimeType: "text/plain", parents: ["f1"] }];
			} else if (q.includes("'f2'")) {
				files = [{ id: "b", name: "b.txt", mimeType: "text/plain", parents: ["f2"] }];
			} else if (q.includes("'f3'")) {
				files = [{ id: "c", name: "c.txt", mimeType: "text/plain", parents: ["f3"] }];
			}

			concurrent--;
			return mockRes({ files });
		});

		const client = new DriveClient(auth);
		const result = await client.listAllFiles("root");

		// 3 folders + 3 files = 6 total
		expect(result).toHaveLength(6);
		// Subfolders should have been fetched concurrently (max 3)
		expect(maxConcurrent).toBeGreaterThan(1);
		expect(maxConcurrent).toBeLessThanOrEqual(3);

		mockRequestUrl.mockRestore();
	});

	it("collects all files from deeply nested structure", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async (req) => {
			const url = typeof req === "string" ? req : req.url;
			const params = new URLSearchParams(url.split("?")[1]);
			const q = params.get("q") ?? "";

			let files: unknown[] = [];
			if (q.includes("'root'")) {
				files = [{ id: "d1", name: "level1", mimeType: "application/vnd.google-apps.folder", parents: ["root"] }];
			} else if (q.includes("'d1'")) {
				files = [{ id: "d2", name: "level2", mimeType: "application/vnd.google-apps.folder", parents: ["d1"] }];
			} else if (q.includes("'d2'")) {
				files = [{ id: "leaf", name: "deep.txt", mimeType: "text/plain", parents: ["d2"] }];
			}

			return mockRes({ files });
		});

		const client = new DriveClient(auth);
		const result = await client.listAllFiles("root");

		expect(result).toHaveLength(3);
		expect(result.map((f) => f.name)).toEqual(
			expect.arrayContaining(["level1", "level2", "deep.txt"])
		);

		mockRequestUrl.mockRestore();
	});

	it("propagates errors from parallel folder fetches", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async (req) => {
			const url = typeof req === "string" ? req : req.url;
			const params = new URLSearchParams(url.split("?")[1]);
			const q = params.get("q") ?? "";

			if (q.includes("'root'")) {
				return mockRes({
					files: [
						{ id: "f1", name: "ok", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
						{ id: "f2", name: "bad", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
					],
				});
			}
			if (q.includes("'f2'")) {
				throw Object.assign(new Error("Rate limited"), { status: 429 });
			}
			return mockRes({ files: [] });
		});

		const client = new DriveClient(auth);
		await expect(client.listAllFiles("root")).rejects.toThrow();

		mockRequestUrl.mockRestore();
	});
});

describe("DriveClient resumable upload", () => {
	it("uploads large file via resumable session (init + single PUT)", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return mockRes({}, { headers: { location: "https://upload.example.com/resumable-session" } });
			}
			return mockRes({
				id: "uploaded-file",
				name: "large.bin",
				mimeType: "application/octet-stream",
				md5Checksum: "finalhash",
			});
		});

		const client = new DriveClient(auth);
		const content = new ArrayBuffer(12 * 1024 * 1024);
		const result = await client.uploadFile(
			"large.bin",
			"parent-id",
			content,
			"application/octet-stream",
			undefined,
			Date.now()
		);

		expect(result.id).toBe("uploaded-file");
		expect(callCount).toBe(2); // 1 init + 1 upload

		mockRequestUrl.mockRestore();
	});

	it("caches resume URL on upload failure and resumes on retry", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const fileSize = 6 * 1024 * 1024;
		const content = new ArrayBuffer(fileSize);
		let callCount = 0;

		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async (req) => {
			callCount++;
			if (callCount === 1) {
				// Init: return session URL
				return mockRes({}, { headers: { location: "https://upload.example.com/session-abc" } });
			}
			if (callCount === 2) {
				// First PUT: fails midway
				throw Object.assign(new Error("Connection reset"), { status: 500 });
			}
			if (callCount === 3) {
				// Status query: 308 with Range header (Google received first 2MB)
				throw Object.assign(new Error("Resume Incomplete"), {
					status: 308,
					headers: { range: "bytes=0-2097151" },
				});
			}
			if (callCount === 4) {
				// Resume PUT: verify Content-Range header
				const headers = typeof req === "string" ? {} : (req.headers ?? {});
				const contentRange = headers["Content-Range"] ?? "";
				expect(contentRange).toBe(`bytes 2097152-${fileSize - 1}/${fileSize}`);
				return mockRes({
					id: "resumed-file",
					name: "file.bin",
					mimeType: "application/octet-stream",
				});
			}
			throw new Error("Unexpected call");
		});

		const client = new DriveClient(auth);

		// First attempt: should fail and cache the resume URL
		await expect(
			client.uploadFile("file.bin", "parent", content)
		).rejects.toThrow();

		// Verify cache was populated
		const cache = (client as unknown as DriveClientInternal).resumableUploader.resumeCache;
		expect(cache.size).toBe(1);
		expect(cache.get("parent/file.bin")?.uploadUrl).toBe("https://upload.example.com/session-abc");

		// Second attempt (retry): should query status and resume
		const result = await client.uploadFile("file.bin", "parent", content);
		expect(result.id).toBe("resumed-file");
		expect(callCount).toBe(4); // init + fail + status + resume

		// Cache should be cleared after successful resume
		expect(cache.size).toBe(0);

		mockRequestUrl.mockRestore();
	});

	it("falls back to fresh upload when status query fails", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const fileSize = 6 * 1024 * 1024;
		const content = new ArrayBuffer(fileSize);
		let callCount = 0;

		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				// Init
				return mockRes({}, { headers: { location: "https://upload.example.com/session-1" } });
			}
			if (callCount === 2) {
				// First PUT fails
				throw Object.assign(new Error("Timeout"), { status: 408 });
			}
			if (callCount === 3) {
				// Status query: fails with 404 (session expired)
				throw Object.assign(new Error("Not Found"), { status: 404 });
			}
			if (callCount === 4) {
				// Fresh init
				return mockRes({}, { headers: { location: "https://upload.example.com/session-2" } });
			}
			if (callCount === 5) {
				// Fresh PUT succeeds
				return mockRes({
					id: "fresh-file",
					name: "file.bin",
					mimeType: "application/octet-stream",
				});
			}
			throw new Error("Unexpected call");
		});

		const client = new DriveClient(auth);

		// First attempt fails
		await expect(client.uploadFile("file.bin", "parent", content)).rejects.toThrow();

		// Retry: status query fails → fresh upload
		const result = await client.uploadFile("file.bin", "parent", content);
		expect(result.id).toBe("fresh-file");
		expect(callCount).toBe(5); // init + fail + status(fail) + init + put

		mockRequestUrl.mockRestore();
	});

	it("returns completed file when status query returns 200", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const fileSize = 6 * 1024 * 1024;
		const content = new ArrayBuffer(fileSize);
		let callCount = 0;

		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return mockRes({}, { headers: { location: "https://upload.example.com/session-done" } });
			}
			if (callCount === 2) {
				throw Object.assign(new Error("Reset"), { status: 500 });
			}
			if (callCount === 3) {
				// Status query returns 200 — upload already completed
				return mockRes({
					id: "already-done",
					name: "file.bin",
					mimeType: "application/octet-stream",
				});
			}
			throw new Error("Unexpected call");
		});

		const client = new DriveClient(auth);

		await expect(client.uploadFile("file.bin", "parent", content)).rejects.toThrow();

		const result = await client.uploadFile("file.bin", "parent", content);
		expect(result.id).toBe("already-done");
		expect(callCount).toBe(3); // init + fail + status(200)

		mockRequestUrl.mockRestore();
	});

	it("ignores expired cache entries", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const fileSize = 6 * 1024 * 1024;
		const content = new ArrayBuffer(fileSize);
		let callCount = 0;

		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return mockRes({}, { headers: { location: "https://upload.example.com/fresh" } });
			}
			return mockRes({
				id: "fresh-upload",
				name: "file.bin",
				mimeType: "application/octet-stream",
			});
		});

		const client = new DriveClient(auth);
		const cache = (client as unknown as DriveClientInternal).resumableUploader.resumeCache;

		// Manually insert an expired cache entry (7 hours old)
		cache.set("parent/file.bin", {
			uploadUrl: "https://upload.example.com/expired",
			totalSize: fileSize,
			createdAt: Date.now() - 7 * 60 * 60 * 1000,
		});

		// Should ignore expired cache and do fresh upload
		const result = await client.uploadFile("file.bin", "parent", content);
		expect(result.id).toBe("fresh-upload");
		expect(callCount).toBe(2); // init + put (no status query)

		mockRequestUrl.mockRestore();
	});

	it("ignores cache when file size differs", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return mockRes({}, { headers: { location: "https://upload.example.com/new" } });
			}
			return mockRes({
				id: "new-file",
				name: "file.bin",
				mimeType: "application/octet-stream",
			});
		});

		const client = new DriveClient(auth);
		const cache = (client as unknown as DriveClientInternal).resumableUploader.resumeCache;

		// Cache entry with different totalSize
		cache.set("parent/file.bin", {
			uploadUrl: "https://upload.example.com/old",
			totalSize: 10 * 1024 * 1024,
			createdAt: Date.now(),
		});

		const content = new ArrayBuffer(6 * 1024 * 1024);
		const result = await client.uploadFile("file.bin", "parent", content);
		expect(result.id).toBe("new-file");
		expect(callCount).toBe(2); // fresh init + put

		mockRequestUrl.mockRestore();
	});

	it("uses existingFileId as cache key when provided", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const fileSize = 6 * 1024 * 1024;
		const content = new ArrayBuffer(fileSize);
		let callCount = 0;

		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return mockRes({}, { headers: { location: "https://upload.example.com/session" } });
			}
			if (callCount === 2) {
				throw Object.assign(new Error("Fail"), { status: 500 });
			}
			throw new Error("Unexpected call");
		});

		const client = new DriveClient(auth);
		await expect(
			client.uploadFile("file.bin", "parent", content, "application/octet-stream", "existing-id-123")
		).rejects.toThrow();

		const cache = (client as unknown as DriveClientInternal).resumableUploader.resumeCache;
		expect(cache.has("existing-id-123")).toBe(true);
		expect(cache.has("parent/file.bin")).toBe(false);

		mockRequestUrl.mockRestore();
	});

	it("propagates errors during resumable upload", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return mockRes({}, { headers: { location: "https://upload.example.com/session" } });
			}
			const err = Object.assign(new Error("Internal Server Error"), {
				status: 500,
			});
			throw err;
		});

		const client = new DriveClient(auth);
		const content = new ArrayBuffer(6 * 1024 * 1024);

		await expect(
			client.uploadFile("file.bin", "parent", content)
		).rejects.toThrow("uploadFileResumable:upload failed");

		mockRequestUrl.mockRestore();
	});

	it("handles file just over threshold", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return mockRes({}, { headers: { location: "https://upload.example.com/session" } });
			}
			return mockRes({
				id: "f1",
				name: "medium.bin",
				mimeType: "application/octet-stream",
			});
		});

		const client = new DriveClient(auth);
		const content = new ArrayBuffer(5 * 1024 * 1024 + 1);
		const result = await client.uploadFile("medium.bin", "parent", content);

		expect(result.id).toBe("f1");
		expect(callCount).toBe(2); // 1 init + 1 upload

		mockRequestUrl.mockRestore();
	});

	it("clearResumeCache removes all entries", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		const client = new DriveClient(auth);
		const cache = (client as unknown as DriveClientInternal).resumableUploader.resumeCache;

		cache.set("key1", { uploadUrl: "url1", totalSize: 100, createdAt: Date.now() });
		cache.set("key2", { uploadUrl: "url2", totalSize: 200, createdAt: Date.now() });
		expect(cache.size).toBe(2);

		client.clearResumeCache();
		expect(cache.size).toBe(0);
	});
});
