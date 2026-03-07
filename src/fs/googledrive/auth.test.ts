import { describe, it, expect, vi } from "vitest";
import { spyRequestUrl, mockRes } from "./test-helpers";
import type { GoogleDriveAuthProviderInternal } from "./test-helpers";

vi.mock("obsidian");

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
			remoteVaultFolderId: "folder",
			changesStartPageToken: "",
			pendingCodeVerifier: "",
			pendingAuthState: "",
		};

		// The refreshToken mismatch should create a new auth instance
		const auth = provider.auth.getOrCreateGoogleAuth(data);
		expect(auth).not.toBe(oldAuth);
	});
});

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
