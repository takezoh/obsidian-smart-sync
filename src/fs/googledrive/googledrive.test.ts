import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import type { RequestUrlResponse } from "obsidian";
import { assertDriveFile, assertDriveFileList, assertDriveChangeList } from "./types";
import type { DriveFile } from "./types";
import type { GoogleAuth } from "./auth";

vi.mock("obsidian");

/** Simplified requestUrl type for test mocks (avoids RequestUrlResponsePromise complexity) */
type MockableRequestUrl = (request: string | import("obsidian").RequestUrlParam) => Promise<RequestUrlResponse>;

/** Helper to spy on the mocked obsidian.requestUrl with proper typing */
async function spyRequestUrl() {
	const obsidian = await import("obsidian");
	return vi.spyOn(obsidian as unknown as { requestUrl: MockableRequestUrl }, "requestUrl");
}

/** Shorthand to build a partial RequestUrlResponse for mocks */
function mockRes(json: unknown, extra?: Partial<RequestUrlResponse>): RequestUrlResponse {
	return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "", json, ...extra } as RequestUrlResponse;
}

/** Type for accessing private fields on GoogleDriveFs in tests */
interface GoogleDriveFsInternal {
	initialized: boolean;
}

/** Type for accessing private fields on GoogleDriveAuthProvider in tests */
interface GoogleDriveAuthProviderInternal {
	googleAuth: GoogleAuth;
}

// ---- L10: Runtime validator tests ----

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

// ---- M4: parseAuthInput empty code ----

describe("parseAuthInput (via provider)", () => {
	it("rejects empty string", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const provider = new GoogleDriveProvider();

		await expect(
			provider.auth.completeAuth("", {})
		).rejects.toThrow("Authorization code is empty");
	});

	it("rejects whitespace-only string", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const provider = new GoogleDriveProvider();

		await expect(
			provider.auth.completeAuth("   ", {})
		).rejects.toThrow("Authorization code is empty");
	});
});

// ---- H3: Token refresh deduplication ----

describe("GoogleAuth.getAccessToken concurrency", () => {
	it("deduplicates concurrent refresh calls", async () => {
		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			async () => {
				callCount++;
				await new Promise((r) => setTimeout(r, 50));
				return mockRes({
					access_token: "new-access-token",
					expires_in: 3600,
					token_type: "Bearer",
				});
			}
		);

		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setTokens("refresh-token", "", 0);

		// Fire 3 concurrent calls
		const [t1, t2, t3] = await Promise.all([
			auth.getAccessToken(),
			auth.getAccessToken(),
			auth.getAccessToken(),
		]);

		expect(callCount).toBe(1);
		expect(t1).toBe("new-access-token");
		expect(t2).toBe("new-access-token");
		expect(t3).toBe("new-access-token");

		mockRequestUrl.mockRestore();
	});
});

// ---- H1: rewriteChildPaths ----

describe("GoogleDriveFs folder rename child path rewrite", () => {
	it("rewrites child paths when a folder is renamed via incremental changes", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "folder1", name: "oldFolder", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "file1", name: "child.txt", mimeType: "text/plain", parents: ["folder1"] },
				{ id: "file2", name: "deep.txt", mimeType: "text/plain", parents: ["folder1"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{
						type: "file",
						fileId: "folder1",
						removed: false,
						file: { id: "folder1", name: "newFolder", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
					},
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Initial list to populate cache
		const initial = await fs.list();
		expect(initial.map((e) => e.path).sort()).toEqual([
			"oldFolder",
			"oldFolder/child.txt",
			"oldFolder/deep.txt",
		]);

		// Apply incremental change that renames oldFolder → newFolder
		await fs.applyIncrementalChanges();
		const updated = await fs.list();
		const paths = updated.map((e) => e.path).sort();

		expect(paths).toContain("newFolder");
		expect(paths).toContain("newFolder/child.txt");
		expect(paths).toContain("newFolder/deep.txt");
		expect(paths).not.toContain("oldFolder");
		expect(paths).not.toContain("oldFolder/child.txt");
	});
});

// ---- H2: ensureFolder file/folder collision ----

describe("GoogleDriveFs.ensureFolder file collision", () => {
	it("throws when a path segment is a file not a folder", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "file1", name: "docs", mimeType: "text/plain", parents: ["root"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Populate cache
		await fs.list();

		// Trying to mkdir docs/sub should fail because "docs" is a file
		await expect(fs.mkdir("docs/sub")).rejects.toThrow(
			'Cannot create directory "docs/sub": "docs" is a file'
		);
	});
});

// ---- Issue 1: OAuth state validation ----

describe("GoogleAuth.exchangeCode state validation", () => {
	it("throws when authState is null", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		// authState is null by default (no getAuthorizationUrl called)
		await expect(auth.exchangeCode("some-code", "some-state")).rejects.toThrow(
			"OAuth state is missing"
		);
	});

	it("throws when state does not match", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setPkceState("verifier", "correct-state");
		await expect(auth.exchangeCode("some-code", "wrong-state")).rejects.toThrow(
			"State mismatch"
		);
	});

	it("throws when state parameter is omitted", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setPkceState("verifier", "expected-state");
		await expect(auth.exchangeCode("some-code")).rejects.toThrow(
			"State mismatch"
		);
	});
});

describe("GoogleDriveProvider.completeAuth PKCE restoration", () => {
	it("restores PKCE state on existing auth that lacks it", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(mockRes({
			access_token: "new-access",
			expires_in: 3600,
			token_type: "Bearer",
			refresh_token: "new-refresh",
		}));

		const { GoogleDriveProvider } = await import("./provider");
		const { GoogleAuth } = await import("./auth");
		const provider = new GoogleDriveProvider();
		const authInternal = provider.auth as unknown as GoogleDriveAuthProviderInternal;

		const backendData = {
			pendingCodeVerifier: "saved-verifier",
			pendingAuthState: "saved-state",
		};

		// Create a provider with an existing auth that has no PKCE state
		authInternal.googleAuth = new GoogleAuth();

		// Verify auth initially has no PKCE state
		expect(authInternal.googleAuth.getAuthState()).toBeNull();

		// completeAuth should restore PKCE state from backendData then exchange
		const result = await provider.auth.completeAuth(
			"http://127.0.0.1/callback?code=test-code&state=saved-state",
			backendData
		);

		// exchangeCode should have succeeded (state matched after restoration)
		expect(result.refreshToken).toBe("new-refresh");
		// State is cleared after successful exchange
		expect(authInternal.googleAuth.getAuthState()).toBeNull();

		mockRequestUrl.mockRestore();
	});
});

// ---- Issue 2: getOrCreateAuth refreshToken comparison ----

describe("GoogleDriveAuthProvider.getOrCreateGoogleAuth", () => {
	it("recreates auth when refreshToken changes", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const { GoogleAuth } = await import("./auth");
		const provider = new GoogleDriveProvider();
		const authInternal = provider.auth as unknown as GoogleDriveAuthProviderInternal;

		// Set up existing auth with old refresh token
		const oldAuth = new GoogleAuth();
		oldAuth.setTokens("old-refresh", "", 0);
		authInternal.googleAuth = oldAuth;

		const data = {
			refreshToken: "new-refresh",
			accessToken: "",
			accessTokenExpiry: 0,
			driveFolderId: "folder",
			changesStartPageToken: "",
			pendingCodeVerifier: "",
			pendingAuthState: "",
		};

		// The refreshToken mismatch should create a new auth instance
		const auth = provider.auth.getOrCreateGoogleAuth(data);
		expect(auth).not.toBe(oldAuth);
	});
});

// ---- Issue 3: revokeToken ----

describe("GoogleAuth.revokeToken", () => {
	it("calls Google revoke endpoint", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(mockRes({}));

		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setTokens("my-refresh-token", "", 0);

		await auth.revokeToken();

		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				url: expect.stringContaining("oauth2.googleapis.com/revoke"),
				method: "POST",
			})
		);
		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				url: expect.stringContaining("my-refresh-token"),
			})
		);

		mockRequestUrl.mockRestore();
	});

	it("does not throw when revoke fails", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockRejectedValue(
			new Error("Network error")
		);

		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setTokens("token", "", 0);

		// Should not throw
		await expect(auth.revokeToken()).resolves.toBeUndefined();

		mockRequestUrl.mockRestore();
	});

	it("skips revoke when no token is set", async () => {
		const mockRequestUrl = await spyRequestUrl();

		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();

		await auth.revokeToken();
		expect(mockRequestUrl).not.toHaveBeenCalled();

		mockRequestUrl.mockRestore();
	});
});

// ---- Issue 5: Error wrapping ----

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

// ---- Issue 6: modifiedTime default ----

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

// ---- Fix 1: write() returns md5Checksum in backendMeta ----

describe("GoogleDriveFs.write md5Checksum", () => {
	it("includes md5Checksum in backendMeta when returned by Drive API", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			async () => mockRes({
				id: "file1",
				name: "test.md",
				mimeType: "text/plain",
				modifiedTime: "2024-01-01T00:00:00.000Z",
				size: "5",
				md5Checksum: "abc123hash",
			})
		);

		const { GoogleDriveFs } = await import("./index");
		const { DriveClient } = await import("./client");
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);
		const client = new DriveClient(auth);
		const fs = new GoogleDriveFs(client, "root");

		(fs as unknown as GoogleDriveFsInternal).initialized = true;

		const content = new TextEncoder().encode("hello").buffer as ArrayBuffer;
		const result = await fs.write("test.md", content, Date.now());

		expect(result.backendMeta?.md5Checksum).toBe("abc123hash");
		expect(result.backendMeta?.driveId).toBe("file1");

		mockRequestUrl.mockRestore();
	});

	it("handles missing md5Checksum (Google Docs) gracefully", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			async () => mockRes({
				id: "doc1",
				name: "doc.gdoc",
				mimeType: "application/vnd.google-apps.document",
				modifiedTime: "2024-01-01T00:00:00.000Z",
			})
		);

		const { GoogleDriveFs } = await import("./index");
		const { DriveClient } = await import("./client");
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);
		const client = new DriveClient(auth);
		const fs = new GoogleDriveFs(client, "root");

		(fs as unknown as GoogleDriveFsInternal).initialized = true;

		const content = new TextEncoder().encode("hello").buffer as ArrayBuffer;
		const result = await fs.write("doc.gdoc", content, Date.now());

		expect(result.backendMeta?.md5Checksum).toBeUndefined();
		expect(result.backendMeta?.driveId).toBe("doc1");

		mockRequestUrl.mockRestore();
	});
});

// ---- Fix 2: Multi-parent resolution ----

describe("GoogleDriveFs multi-parent resolution", () => {
	it("resolves file with multiple parents to root when rootId is second", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "file1",
					name: "shared.txt",
					mimeType: "text/plain",
					parents: ["outsideId", "root"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();

		expect(files).toHaveLength(1);
		expect(files[0]!.path).toBe("shared.txt");
	});

	it("resolves nested file via known parent when first parent is unknown", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "folder1",
					name: "docs",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				},
				{
					id: "file1",
					name: "note.md",
					mimeType: "text/plain",
					parents: ["outsideFolder", "folder1"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();
		const paths = files.map((f) => f.path).sort();

		expect(paths).toContain("docs");
		expect(paths).toContain("docs/note.md");
	});

	it("single parent still works (regression)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "folder1",
					name: "notes",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				},
				{
					id: "file1",
					name: "hello.md",
					mimeType: "text/plain",
					parents: ["folder1"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();
		const paths = files.map((f) => f.path).sort();

		expect(paths).toContain("notes");
		expect(paths).toContain("notes/hello.md");
	});

	it("resolvePathFromCache handles multi-parent in incremental changes", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{
					id: "folder1",
					name: "docs",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{
						type: "file",
						fileId: "file1",
						removed: false,
						file: {
							id: "file1",
							name: "new.md",
							mimeType: "text/plain",
							parents: ["outsideId", "folder1"],
						},
					},
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Initial scan
		await fs.list();

		// Apply incremental change with multi-parent file
		await fs.applyIncrementalChanges();
		const files = await fs.list();
		const paths = files.map((f) => f.path).sort();

		expect(paths).toContain("docs");
		expect(paths).toContain("docs/new.md");
	});
});

// ---- Circular parent reference detection ----

describe("GoogleDriveFs circular parent reference", () => {
	it("handles mutual cycle (A→B→A) without infinite loop", async () => {
		const { GoogleDriveFs } = await import("./index");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "a", name: "folderA", mimeType: "application/vnd.google-apps.folder", parents: ["b"] },
				{ id: "b", name: "folderB", mimeType: "application/vnd.google-apps.folder", parents: ["a"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();

		// list() completes without hanging
		expect(files.length).toBe(2);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("circular parent reference detected")
		);

		warnSpy.mockRestore();
	});

	it("handles self-referencing parent (X→X) without infinite loop", async () => {
		const { GoogleDriveFs } = await import("./index");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "x", name: "selfRef", mimeType: "text/plain", parents: ["x"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		const files = await fs.list();

		expect(files.length).toBe(1);
		expect(files[0]!.path).toBe("selfRef");
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("circular parent reference detected")
		);

		warnSpy.mockRestore();
	});
});

// ---- TODO 2: listAllFiles() parallelization ----

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

// ---- Fix 3: Resumable upload (single PUT + resume-on-retry) ----

/** Type for accessing private resumeCache on DriveClient in tests */
interface DriveClientInternal {
	resumeCache: Map<string, { uploadUrl: string; totalSize: number; createdAt: number }>;
}

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
				const headers = typeof req === "string" ? {} : (req.headers ?? {}) as Record<string, string>;
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
		const cache = (client as unknown as DriveClientInternal).resumeCache;
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
		const cache = (client as unknown as DriveClientInternal).resumeCache;

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
		const cache = (client as unknown as DriveClientInternal).resumeCache;

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

		const cache = (client as unknown as DriveClientInternal).resumeCache;
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
		const cache = (client as unknown as DriveClientInternal).resumeCache;

		cache.set("key1", { uploadUrl: "url1", totalSize: 100, createdAt: Date.now() });
		cache.set("key2", { uploadUrl: "url2", totalSize: 200, createdAt: Date.now() });
		expect(cache.size).toBe(2);

		client.clearResumeCache();
		expect(cache.size).toBe(0);
	});
});

// ---- Children index tests ----

/** Type for accessing the children index on GoogleDriveFs in tests */
interface GoogleDriveFsChildrenIndex {
	children: Map<string, Set<string>>;
}

describe("GoogleDriveFs children index", () => {
	it("removePath removes all descendants (nested folders)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "a", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "f2", name: "b", mimeType: "application/vnd.google-apps.folder", parents: ["f1"] },
				{ id: "file1", name: "c.txt", mimeType: "text/plain", parents: ["f2"] },
				{ id: "file2", name: "d.txt", mimeType: "text/plain", parents: ["f1"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{ type: "file", fileId: "f1", removed: true },
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");

		// Populate cache
		const initial = await fs.list();
		expect(initial).toHaveLength(4);

		// Delete folder "a" via incremental changes
		await fs.applyIncrementalChanges();
		const after = await fs.list();

		// All descendants should be removed
		expect(after).toHaveLength(0);
	});

	it("rewriteChildPaths correctly updates deeply nested paths", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "top", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "f2", name: "mid", mimeType: "application/vnd.google-apps.folder", parents: ["f1"] },
				{ id: "f3", name: "deep", mimeType: "application/vnd.google-apps.folder", parents: ["f2"] },
				{ id: "file1", name: "leaf.txt", mimeType: "text/plain", parents: ["f3"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			listChanges: vi.fn().mockResolvedValue({
				changes: [
					{
						type: "file",
						fileId: "f1",
						removed: false,
						file: { id: "f1", name: "renamed", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
					},
				],
				newStartPageToken: "token2",
			}),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();
		await fs.applyIncrementalChanges();
		const after = await fs.list();
		const paths = after.map((e) => e.path).sort();

		expect(paths).toEqual([
			"renamed",
			"renamed/mid",
			"renamed/mid/deep",
			"renamed/mid/deep/leaf.txt",
		]);

		// Verify children index is consistent
		const idx = (fs as unknown as GoogleDriveFsChildrenIndex).children;
		expect(idx.get("renamed")?.has("renamed/mid")).toBe(true);
		expect(idx.get("renamed/mid")?.has("renamed/mid/deep")).toBe(true);
		expect(idx.get("renamed/mid/deep")?.has("renamed/mid/deep/leaf.txt")).toBe(true);
	});

	it("listDir returns only direct children (not recursive)", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "f1", name: "parent", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
				{ id: "f2", name: "child", mimeType: "application/vnd.google-apps.folder", parents: ["f1"] },
				{ id: "file1", name: "a.txt", mimeType: "text/plain", parents: ["f1"] },
				{ id: "file2", name: "b.txt", mimeType: "text/plain", parents: ["f2"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		const children = await fs.listDir("parent");
		const childPaths = children.map((e) => e.path).sort();

		expect(childPaths).toEqual(["parent/a.txt", "parent/child"]);
		// Should NOT include parent/child/b.txt
		expect(childPaths).not.toContain("parent/child/b.txt");
	});
});

// ---- Cache persistence integration tests ----

describe("GoogleDriveFs cache persistence", () => {

	it("fullScan persists cache, loadFromCache restores it", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");

		const allFiles = [
			{ id: "f1", name: "docs", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
			{ id: "file1", name: "note.md", mimeType: "text/plain", parents: ["f1"], modifiedTime: "2024-01-01T00:00:00.000Z", size: "100" },
		];
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue(allFiles),
			getChangesStartToken: vi.fn().mockResolvedValue("token-abc"),
		} as never;

		const store = new MetadataStore<DriveFile>("persist-test", { dbNamePrefix: "smart-sync-drive", version: 1 });

		// First instance: fullScan populates and persists
		const fs1 = new GoogleDriveFs(mockClient, "root", undefined, store);
		const files1 = await fs1.list();
		expect(files1).toHaveLength(2);

		// Wait for async persist to complete
		await new Promise((r) => setTimeout(r, 50));

		// Second instance: should load from IDB, no fullScan needed
		const listAllFilesSpy = vi.fn();
		const mockClient2 = {
			listAllFiles: listAllFilesSpy,
			getChangesStartToken: vi.fn(),
			listChanges: vi.fn().mockResolvedValue({ changes: [], newStartPageToken: "token-abc" }),
		} as never;
		const fs2 = new GoogleDriveFs(mockClient2, "root", undefined, store);
		const files2 = await fs2.list();

		expect(files2).toHaveLength(2);
		expect(files2.map((f) => f.path).sort()).toEqual(["docs", "docs/note.md"]);
		// listAllFiles should NOT have been called (loaded from cache)
		expect(listAllFilesSpy).not.toHaveBeenCalled();

		await store.close();
	});

	it("rootFolderId mismatch falls back to fullScan", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");

		const mockClient1 = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["root1"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const store = new MetadataStore<DriveFile>("mismatch-test", { dbNamePrefix: "smart-sync-drive", version: 1 });

		// Persist with rootFolderId = "root1"
		const fs1 = new GoogleDriveFs(mockClient1, "root1", undefined, store);
		await fs1.list();

		// Second instance with different rootFolderId
		const listAllFilesSpy2 = vi.fn().mockResolvedValue([
			{ id: "file2", name: "b.md", mimeType: "text/plain", parents: ["root2"] },
		]);
		const mockClient2 = {
			listAllFiles: listAllFilesSpy2,
			getChangesStartToken: vi.fn().mockResolvedValue("token2"),
		} as never;
		const fs2 = new GoogleDriveFs(mockClient2, "root2", undefined, store);
		const files = await fs2.list();

		// Should have done a full scan with root2
		expect(listAllFilesSpy2).toHaveBeenCalled();
		expect(files[0]!.path).toBe("b.md");

		await store.close();
	});

	it("invalidateCache clears IDB so next load does fullScan", async () => {
		const { GoogleDriveFs } = await import("./index");
		const { MetadataStore } = await import("../../store/metadata-store");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "file1", name: "a.md", mimeType: "text/plain", parents: ["root"] },
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const store = new MetadataStore<DriveFile>("invalidate-test", { dbNamePrefix: "smart-sync-drive", version: 1 });
		const fs = new GoogleDriveFs(mockClient, "root", undefined, store);
		await fs.list();
		// Wait for async persist
		await new Promise((r) => setTimeout(r, 50));

		// Verify IDB has data
		let loaded = await store.loadAll();
		expect(loaded.files).toHaveLength(1);

		// Now invalidate and wait for clear
		fs.invalidateCache();
		await new Promise((r) => setTimeout(r, 50));

		loaded = await store.loadAll();
		expect(loaded.files).toHaveLength(0);
		expect(loaded.meta.size).toBe(0);

		await store.close();
	});
});
