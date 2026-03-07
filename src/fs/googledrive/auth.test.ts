import { describe, it, expect, vi } from "vitest";
import { spyRequestUrl, mockRes } from "./test-helpers";
import type { GoogleDriveAuthProviderInternal } from "./test-helpers";

vi.mock("obsidian");

describe("GoogleAuth.handleAuthCallback", () => {
	it("stores tokens when state matches", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setAuthState("my-csrf");

		auth.handleAuthCallback({
			access_token: "access-123",
			refresh_token: "refresh-456",
			expires_in: "3600",
			state: "my-csrf",
		});

		const tokens = auth.getTokenState();
		expect(tokens.accessToken).toBe("access-123");
		expect(tokens.refreshToken).toBe("refresh-456");
		expect(tokens.accessTokenExpiry).toBeGreaterThan(Date.now());
	});

	it("throws when authState is null", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();

		expect(() =>
			auth.handleAuthCallback({
				access_token: "token",
				expires_in: "3600",
				state: "some-state",
			})
		).toThrow("OAuth state is missing");
	});

	it("throws when state does not match", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setAuthState("correct-state");

		expect(() =>
			auth.handleAuthCallback({
				access_token: "token",
				expires_in: "3600",
				state: "wrong-state",
			})
		).toThrow("State mismatch");
	});

	it("throws when state parameter is omitted", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setAuthState("expected-state");

		expect(() =>
			auth.handleAuthCallback({
				access_token: "token",
				expires_in: "3600",
			})
		).toThrow("State mismatch");
	});

	it("clears authState after successful callback", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setAuthState("csrf");

		auth.handleAuthCallback({
			access_token: "token",
			expires_in: "3600",
			state: "csrf",
		});

		expect(auth.getAuthState()).toBeNull();
	});
});

describe("GoogleAuth.getAuthorizationUrl", () => {
	it("returns a Google OAuth URL with state but no PKCE", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();

		const url = auth.getAuthorizationUrl();

		expect(url).toContain("accounts.google.com");
		expect(url).toContain("state=");
		expect(url).not.toContain("code_challenge");
		expect(auth.getAuthState()).not.toBeNull();
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

describe("GoogleDriveProvider.completeAuth", () => {
	it("restores CSRF state on existing auth that lacks it", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const { GoogleAuth } = await import("./auth");
		const provider = new GoogleDriveProvider();
		const authInternal = provider.auth as unknown as GoogleDriveAuthProviderInternal;

		const backendData = {
			pendingAuthState: "saved-state",
		};

		authInternal.googleAuth = new GoogleAuth();
		expect(authInternal.googleAuth.getAuthState()).toBeNull();

		const result = await provider.auth.completeAuth(
			"https://callback?access_token=new-access&refresh_token=new-refresh&expires_in=3600&state=saved-state",
			backendData
		);

		expect(result.refreshToken).toBe("new-refresh");
		expect(authInternal.googleAuth.getAuthState()).toBeNull();
	});

	it("rejects empty callback", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const provider = new GoogleDriveProvider();

		await expect(
			provider.auth.completeAuth("", {})
		).rejects.toThrow("Auth callback is empty");
	});
});

describe("GoogleDriveAuthProvider.getOrCreateGoogleAuth", () => {
	it("recreates auth when refreshToken changes", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const { GoogleAuth } = await import("./auth");
		const provider = new GoogleDriveProvider();
		const authInternal = provider.auth as unknown as GoogleDriveAuthProviderInternal;

		const oldAuth = new GoogleAuth();
		oldAuth.setTokens("old-refresh", "", 0);
		authInternal.googleAuth = oldAuth;

		const data = {
			refreshToken: "new-refresh",
			accessToken: "",
			accessTokenExpiry: 0,
			remoteVaultFolderId: "folder",
			lastKnownVaultName: "",
			changesStartPageToken: "",
			pendingAuthState: "",
		};

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
