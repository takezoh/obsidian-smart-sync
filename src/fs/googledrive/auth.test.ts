import { describe, it, expect, vi } from "vitest";
import { spyRequestUrl, mockRes, createMockSecretStore } from "./test-helpers";
import type { GoogleDriveAuthProviderInternal, GoogleDriveCustomAuthProviderInternal } from "./test-helpers";

vi.mock("obsidian");

describe("GoogleAuth.handleAuthCallback", () => {
	it("stores tokens when state matches", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setAuthState("my-csrf");

		await auth.handleAuthCallback({
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

		await expect(
			auth.handleAuthCallback({
				access_token: "token",
				expires_in: "3600",
				state: "some-state",
			})
		).rejects.toThrow("OAuth state is missing");
	});

	it("throws when state does not match", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setAuthState("correct-state");

		await expect(
			auth.handleAuthCallback({
				access_token: "token",
				expires_in: "3600",
				state: "wrong-state",
			})
		).rejects.toThrow("State mismatch");
	});

	it("throws when state parameter is omitted", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setAuthState("expected-state");

		await expect(
			auth.handleAuthCallback({
				access_token: "token",
				expires_in: "3600",
			})
		).rejects.toThrow("State mismatch");
	});

	it("clears authState after successful callback", async () => {
		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setAuthState("csrf");

		await auth.handleAuthCallback({
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

		const url = await auth.getAuthorizationUrl();

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

	it("short-circuits after refresh failure with status 400", async () => {
		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			() => {
				callCount++;
				const err = new Error("Request failed, status 400");
				(err as Error & { status: number }).status = 400;
				throw err;
			}
		);

		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setTokens("refresh-token", "", 0);

		await expect(auth.getAccessToken()).rejects.toThrow("status 400");
		expect(callCount).toBe(1);

		await expect(auth.getAccessToken()).rejects.toThrow(
			"Authentication expired"
		);
		expect(callCount).toBe(1);

		mockRequestUrl.mockRestore();
	});

	it("resets authFailed when setTokens is called", async () => {
		let callCount = 0;
		const mockRequestUrl = (await spyRequestUrl()).mockImplementation(
			async () => {
				callCount++;
				if (callCount === 1) {
					const err = new Error("Request failed, status 400");
					(err as Error & { status: number }).status = 400;
					throw err;
				}
				return await Promise.resolve(mockRes({
					access_token: "recovered",
					expires_in: 3600,
					token_type: "Bearer",
				}));
			}
		);

		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setTokens("refresh-token", "", 0);

		await expect(auth.getAccessToken()).rejects.toThrow("status 400");

		auth.setTokens("new-refresh-token", "", 0);
		const token = await auth.getAccessToken();
		expect(token).toBe("recovered");
		expect(callCount).toBe(2);

		mockRequestUrl.mockRestore();
	});
});

describe("GoogleDriveProvider.completeAuth", () => {
	it("restores CSRF state on existing auth that lacks it", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const { GoogleAuth } = await import("./auth");
		const secretStore = createMockSecretStore();
		const provider = new GoogleDriveProvider(secretStore);
		const authInternal = provider.auth as unknown as GoogleDriveAuthProviderInternal;

		const backendData = {
			pendingAuthState: "saved-state",
		};

		authInternal.googleAuth = new GoogleAuth();
		expect(authInternal.googleAuth.getAuthState()).toBeNull();

		const result = await provider.auth.completeAuth(
			"https://callback?access_token=new-access&refresh_token=new-refresh&expires_in=3600&state=saved-state",
			backendData,
		);

		// Tokens are stored in SecretStorage, not returned in the result
		expect(result.refreshToken).toBeUndefined();
		expect(secretStore.getSecret("smart-sync-googledrive-refresh-token")).toBe("new-refresh");
		expect(result.accessTokenExpiry).toBeGreaterThan(0);
		expect(authInternal.googleAuth.getAuthState()).toBeNull();
	});

	it("rejects empty callback", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const secretStore = createMockSecretStore();
		const provider = new GoogleDriveProvider(secretStore);

		await expect(
			provider.auth.completeAuth("", {})
		).rejects.toThrow("Auth callback is empty");
	});
});

describe("GoogleDriveAuthProvider.getOrCreateGoogleAuth", () => {
	it("reuses existing auth instance", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const { GoogleAuth } = await import("./auth");
		const secretStore = createMockSecretStore();
		const provider = new GoogleDriveProvider(secretStore);
		const authInternal = provider.auth as unknown as GoogleDriveAuthProviderInternal;

		const existingAuth = new GoogleAuth();
		authInternal.googleAuth = existingAuth;

		const data = {
			accessTokenExpiry: 0,
			remoteVaultFolderId: "folder",
			lastKnownVaultName: "",
			changesStartPageToken: "",
			pendingAuthState: "",
		};

		const auth = provider.auth.getOrCreateGoogleAuth(data);
		expect(auth).toBe(existingAuth);
	});

	it("creates auth when none exists", async () => {
		const { GoogleDriveProvider } = await import("./provider");
		const secretStore = createMockSecretStore();
		const provider = new GoogleDriveProvider(secretStore);

		const data = {
			accessTokenExpiry: 0,
			remoteVaultFolderId: "folder",
			lastKnownVaultName: "",
			changesStartPageToken: "",
			pendingAuthState: "",
		};

		const auth = provider.auth.getOrCreateGoogleAuth(data);
		expect(auth).toBeDefined();
	});
});

describe("GoogleAuth.revokeToken", () => {
	it("calls Google revoke endpoint", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(mockRes({}));

		const { GoogleAuth } = await import("./auth");
		const auth = new GoogleAuth();
		auth.setTokens("my-refresh-token", "", 0);

		await auth.revokeToken();

		const callArg = mockRequestUrl.mock.calls[0]?.[0] as { url: string; method: string };
		expect(callArg.url).toContain("oauth2.googleapis.com/revoke");
		expect(callArg.method).toBe("POST");
		expect(callArg.url).toContain("my-refresh-token");

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

describe("GoogleAuthDirect.getAuthorizationUrl", () => {
	it("uses custom client_id and includes PKCE S256 challenge", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect("custom-client-id", "custom-secret");

		const url = await auth.getAuthorizationUrl();

		expect(url).toContain("accounts.google.com");
		expect(url).toContain("client_id=custom-client-id");
		expect(url).toContain("code_challenge=");
		expect(url).toContain("code_challenge_method=S256");
		expect(auth.getCodeVerifier()).not.toBeNull();

		const state = auth.getAuthState();
		expect(state).not.toBeNull();
		const decoded = JSON.parse(atob(state!)) as { custom: boolean };
		expect(decoded.custom).toBe(true);
	});
});

describe("GoogleAuthDirect.handleAuthCallback", () => {
	it("exchanges code for tokens with PKCE code_verifier", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(
			mockRes({
				access_token: "direct-access",
				refresh_token: "direct-refresh",
				expires_in: 3600,
				token_type: "Bearer",
			})
		);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect("my-client-id", "my-secret");
		auth.setAuthState("csrf-state");
		auth.setCodeVerifier("test-verifier-string");

		await auth.handleAuthCallback({
			code: "auth-code-123",
			state: "csrf-state",
		});

		const tokens = auth.getTokenState();
		expect(tokens.accessToken).toBe("direct-access");
		expect(tokens.refreshToken).toBe("direct-refresh");

		const callArg = mockRequestUrl.mock.calls[0]?.[0] as { url: string; method: string };
		expect(callArg.url).toContain("oauth2.googleapis.com/token");
		expect(callArg.method).toBe("POST");
		// Verify body contains client credentials and PKCE verifier
		const callBody = mockRequestUrl.mock.calls[0]?.[0];
		const body = typeof callBody === "object" && callBody !== null && "body" in callBody
			? (callBody as { body: string }).body : "";
		expect(body).toContain("client_id=my-client-id");
		expect(body).toContain("client_secret=my-secret");
		expect(body).toContain("code=auth-code-123");
		expect(body).toContain("grant_type=authorization_code");
		expect(body).toContain("code_verifier=test-verifier-string");

		mockRequestUrl.mockRestore();
	});

	it("throws when code is missing", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect("id", "secret");
		auth.setAuthState("state");
		auth.setCodeVerifier("verifier");

		await expect(
			auth.handleAuthCallback({ state: "state" })
		).rejects.toThrow("Authorization code is missing");
	});

	it("throws when code verifier is missing", async () => {
		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect("id", "secret");
		auth.setAuthState("state");

		await expect(
			auth.handleAuthCallback({ code: "code", state: "state" })
		).rejects.toThrow("PKCE code verifier is missing");
	});
});

describe("GoogleAuthDirect._refreshToken", () => {
	it("refreshes directly against Google token endpoint", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(
			mockRes({
				access_token: "refreshed-access",
				expires_in: 3600,
				token_type: "Bearer",
			})
		);

		const { GoogleAuthDirect } = await import("./auth");
		const auth = new GoogleAuthDirect("my-client", "my-secret");
		auth.setTokens("my-refresh", "", 0);

		const token = await auth.getAccessToken();
		expect(token).toBe("refreshed-access");

		const callBody = mockRequestUrl.mock.calls[0]?.[0];
		const body = typeof callBody === "object" && callBody !== null && "body" in callBody
			? (callBody as { body: string }).body : "";
		expect(body).toContain("grant_type=refresh_token");
		expect(body).toContain("client_id=my-client");
		expect(body).toContain("client_secret=my-secret");
		expect(body).toContain("refresh_token=my-refresh");

		mockRequestUrl.mockRestore();
	});
});

describe("GoogleDriveCustomProvider.completeAuth", () => {
	it("exchanges code via GoogleAuthDirect with PKCE", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(
			mockRes({
				access_token: "custom-access",
				refresh_token: "custom-refresh",
				expires_in: 3600,
				token_type: "Bearer",
			})
		);

		const { GoogleDriveCustomProvider } = await import("./provider-custom");
		const { GoogleAuthDirect } = await import("./auth");
		const secretStore = createMockSecretStore({ cid: "cid-value", csecret: "csecret-value" });
		const provider = new GoogleDriveCustomProvider(secretStore);
		const authInternal = provider.auth as unknown as GoogleDriveCustomAuthProviderInternal;

		authInternal.googleAuth = new GoogleAuthDirect("cid", "csecret");
		authInternal.googleAuth.setAuthState("csrf");
		authInternal.googleAuth.setCodeVerifier("my-verifier");

		const result = await provider.auth.completeAuth(
			"https://callback?code=my-code&state=csrf",
			{ customClientId: "cid", customClientSecret: "csecret" },
		);

		// Tokens are stored in SecretStorage, not returned in the result
		expect(result.refreshToken).toBeUndefined();
		expect(secretStore.getSecret("smart-sync-googledrive-custom-refresh-token")).toBe("custom-refresh");
		expect(secretStore.getSecret("smart-sync-googledrive-custom-access-token")).toBe("custom-access");
		expect(result.accessTokenExpiry).toBeGreaterThan(0);

		// Verify code_verifier was sent in token exchange
		const callBody = mockRequestUrl.mock.calls[0]?.[0];
		const body = typeof callBody === "object" && callBody !== null && "body" in callBody
			? (callBody as { body: string }).body : "";
		expect(body).toContain("code_verifier=my-verifier");

		mockRequestUrl.mockRestore();
	});

	it("restores code verifier from backendData on plugin reload", async () => {
		const mockRequestUrl = (await spyRequestUrl()).mockResolvedValue(
			mockRes({
				access_token: "access",
				refresh_token: "refresh",
				expires_in: 3600,
				token_type: "Bearer",
			})
		);

		const { GoogleDriveCustomProvider } = await import("./provider-custom");
		const secretStore = createMockSecretStore({ cid: "cid-value", csecret: "csecret-value" });
		const provider = new GoogleDriveCustomProvider(secretStore);

		// Simulate plugin reload: no in-memory auth, but backendData has persisted state
		const result = await provider.auth.completeAuth(
			"https://callback?code=code&state=persisted-state",
			{
				customClientId: "cid",
				customClientSecret: "csecret",
				pendingAuthState: "persisted-state",
				pendingCodeVerifier: "persisted-verifier",
			},
		);

		// Tokens stored in SecretStorage
		expect(result.refreshToken).toBeUndefined();
		expect(secretStore.getSecret("smart-sync-googledrive-custom-refresh-token")).toBe("refresh");
		const callBody = mockRequestUrl.mock.calls[0]?.[0];
		const body = typeof callBody === "object" && callBody !== null && "body" in callBody
			? (callBody as { body: string }).body : "";
		expect(body).toContain("code_verifier=persisted-verifier");

		mockRequestUrl.mockRestore();
	});
});
