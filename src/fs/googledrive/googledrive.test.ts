import { describe, it, expect, vi } from "vitest";
import type { RequestUrlResponse } from "obsidian";
import { assertDriveFile, assertDriveFileList, assertDriveChangeList } from "./types";
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
			provider.auth.completeAuth("", {} as never)
		).rejects.toThrow("Authorization code is empty");
	});

	it("rejects whitespace-only string", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const provider = new GoogleDriveProvider();

		await expect(
			provider.auth.completeAuth("   ", {} as never)
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

		const settings = {
			pendingCodeVerifier: "saved-verifier",
			pendingAuthState: "saved-state",
		} as never;

		// Create a provider with an existing auth that has no PKCE state
		authInternal.googleAuth = new GoogleAuth();

		// Verify auth initially has no PKCE state
		expect(authInternal.googleAuth.getAuthState()).toBeNull();

		// completeAuth should restore PKCE state from settings then exchange
		const result = await provider.auth.completeAuth(
			"http://127.0.0.1/callback?code=test-code&state=saved-state",
			settings
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

		const settings = {
			refreshToken: "new-refresh",
			accessToken: "",
			accessTokenExpiry: 0,
			driveFolderId: "folder",
			changesStartPageToken: "",
		} as never;

		// The refreshToken mismatch should create a new auth instance
		const auth = provider.auth.getOrCreateGoogleAuth(settings);
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

// ---- Fix 3: Chunked resumable upload ----

describe("DriveClient chunked resumable upload", () => {
	it("uploads in multiple chunks (308 → 308 → 200)", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			async (...args) => {
				const opts = args[0] as { url: string; method?: string; headers?: Record<string, string> };
				callCount++;

				// First call: initiate resumable upload
				if (callCount === 1) {
					return mockRes({}, { headers: { location: "https://upload.example.com/resumable-session" } });
				}

				// Chunk uploads: check Content-Range header
				const contentRange = opts.headers?.["Content-Range"] ?? "";

				// Second call: first chunk → 308
				if (callCount === 2) {
					const err = Object.assign(new Error("Resume Incomplete"), {
						status: 308,
						headers: { range: "bytes=0-5242879" },
					});
					throw err;
				}

				// Third call: second chunk → 308
				if (callCount === 3) {
					const err = Object.assign(new Error("Resume Incomplete"), {
						status: 308,
						headers: { range: "bytes=0-10485759" },
					});
					throw err;
				}

				// Fourth call: final chunk → 200
				if (callCount === 4) {
					expect(contentRange).toMatch(/bytes \d+-\d+\/\d+/);
					return mockRes({
						id: "uploaded-file",
						name: "large.bin",
						mimeType: "application/octet-stream",
						md5Checksum: "finalhash",
					});
				}

				throw new Error("Unexpected call");
			}
		);

		const client = new DriveClient(auth);
		// Create 12MB content (will require 3 chunks at 5MB each)
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
		expect(callCount).toBe(4); // 1 init + 3 chunk uploads

		mockRequestUrl.mockRestore();
	});

	it("parses Range header to determine resume offset", async () => {
		const { GoogleAuth } = await import("./auth");
		const { DriveClient } = await import("./client");

		const auth = new GoogleAuth();
		auth.setTokens("refresh", "access", Date.now() + 3600_000);

		const uploadedRanges: string[] = [];
		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			async (...args) => {
				const opts = args[0] as { headers?: Record<string, string> };
				callCount++;
				if (callCount === 1) {
					return mockRes({}, { headers: { location: "https://upload.example.com/session" } });
				}

				const cr = opts.headers?.["Content-Range"];
				if (cr) uploadedRanges.push(cr);

				if (callCount === 2) {
					// Simulate server only received first 3MB (not the full 5MB chunk)
					const err = Object.assign(new Error("Resume Incomplete"), {
						status: 308,
						headers: { range: "bytes=0-3145727" },
					});
					throw err;
				}

				// Final chunk completes
				return mockRes({
					id: "f1",
					name: "file.bin",
					mimeType: "application/octet-stream",
				});
			}
		);

		const client = new DriveClient(auth);
		const content = new ArrayBuffer(6 * 1024 * 1024); // 6MB
		await client.uploadFile("file.bin", "parent", content);

		// Second chunk should start from byte 3145728 (3MB)
		expect(uploadedRanges[1]).toMatch(/^bytes 3145728-/);

		mockRequestUrl.mockRestore();
	});

	it("propagates non-308 errors during chunk upload", async () => {
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
			// Chunk upload fails with 500
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

	it("handles single chunk upload (file just over threshold)", async () => {
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
			// Single chunk completes immediately
			return mockRes({
				id: "f1",
				name: "medium.bin",
				mimeType: "application/octet-stream",
			});
		});

		const client = new DriveClient(auth);
		// Exactly 5MB + 1 byte — triggers resumable but fits in one chunk
		const content = new ArrayBuffer(5 * 1024 * 1024 + 1);
		const result = await client.uploadFile("medium.bin", "parent", content);

		expect(result.id).toBe("f1");
		expect(callCount).toBe(2); // 1 init + 1 chunk

		mockRequestUrl.mockRestore();
	});
});
