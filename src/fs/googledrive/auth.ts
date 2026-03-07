import { requestUrl } from "obsidian";
import type { Logger } from "../../logging/logger";
import { assertTokenResponse } from "./types";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const AUTH_SERVER_URL = "https://auth-smartsync.takezo.dev";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const REDIRECT_URI = `${AUTH_SERVER_URL}/callback`;

const GOOGLE_CLIENT_ID = "135801498656-lfjor2ml3v26t9l63mkoka0bndgl9eue.apps.googleusercontent.com";

/**
 * Handles OAuth 2.0 authentication for Google Drive.
 * Token exchange is handled server-side by auth-smartsync.takezo.dev
 * (confidential client with client_secret). The plugin only manages
 * CSRF state verification and token storage.
 */
export class GoogleAuth {
	private accessToken = "";
	private accessTokenExpiry = 0;
	private refreshToken = "";
	private refreshPromise: Promise<string> | null = null;
	private logger?: Logger;

	/** Anti-CSRF state parameter for the current auth flow */
	private authState: string | null = null;

	constructor(logger?: Logger) {
		this.logger = logger;
	}

	/** Set stored tokens (loaded from plugin settings) */
	setTokens(refreshToken: string, accessToken: string, expiry: number): void {
		this.refreshToken = refreshToken;
		this.accessToken = accessToken;
		this.accessTokenExpiry = expiry;
	}

	/** Check if we have a valid refresh token */
	get isAuthenticated(): boolean {
		return this.refreshToken.length > 0;
	}

	/**
	 * Generate the OAuth authorization URL for the user to visit.
	 * Uses a random state parameter for CSRF protection.
	 */
	getAuthorizationUrl(): string {
		this.authState = btoa(JSON.stringify({ app: "obsidian-plugin", nonce: generateRandomString(32) }));

		const params = new URLSearchParams({
			client_id: GOOGLE_CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			scope: SCOPES,
			access_type: "offline",
			prompt: "consent",
			state: this.authState,
		});
		return `${GOOGLE_AUTH_URL}?${params.toString()}`;
	}

	/** Get the current auth state for CSRF verification */
	getAuthState(): string | null {
		return this.authState;
	}

	/** Restore auth state (e.g. after plugin reload during auth flow) */
	setAuthState(authState: string): void {
		this.authState = authState;
	}

	/**
	 * Accept tokens returned by the auth server callback.
	 * The auth server already exchanged the authorization code for tokens;
	 * we just verify the CSRF state and store the tokens.
	 */
	handleAuthCallback(params: {
		access_token: string;
		refresh_token?: string;
		expires_in: string;
		state?: string;
	}): void {
		// Verify CSRF state
		if (!this.authState) {
			throw new Error("OAuth state is missing. Please restart the authorization flow.");
		}
		if (!params.state || params.state !== this.authState) {
			throw new Error("State mismatch - possible CSRF attack");
		}
		if (!params.access_token) {
			throw new Error("Access token is missing from auth callback");
		}

		const expiresIn = parseInt(params.expires_in, 10);
		if (isNaN(expiresIn) || expiresIn <= 0) {
			throw new Error("Invalid expires_in from auth callback");
		}

		this.accessToken = params.access_token;
		this.accessTokenExpiry = Date.now() + expiresIn * 1000;
		if (params.refresh_token) {
			this.refreshToken = params.refresh_token;
		}

		// Clear auth state after use
		this.authState = null;
	}

	/**
	 * Get a valid access token, refreshing if necessary.
	 * Concurrent calls share the same refresh request.
	 */
	async getAccessToken(): Promise<string> {
		if (!this.refreshToken) {
			throw new Error("Not authenticated. Please connect to Google Drive first.");
		}

		// Return cached token if still valid (with 60s buffer)
		if (this.accessToken && Date.now() < this.accessTokenExpiry - 60_000) {
			return this.accessToken;
		}

		// Deduplicate concurrent refresh requests
		if (this.refreshPromise) {
			return this.refreshPromise;
		}
		this.refreshPromise = this._refreshToken();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	/** Perform the actual token refresh via the auth server */
	private async _refreshToken(): Promise<string> {
		this.logger?.info("Refreshing access token");

		const response = await requestUrl({
			url: `${AUTH_SERVER_URL}/token/refresh`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh_token: this.refreshToken }),
		});

		const token: unknown = response.json;
		assertTokenResponse(token);
		this.accessToken = token.access_token;
		this.accessTokenExpiry = Date.now() + token.expires_in * 1000;
		if (token.refresh_token) {
			this.refreshToken = token.refresh_token;
		}
		return this.accessToken;
	}

	/** Get current tokens for persistence */
	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } {
		return {
			refreshToken: this.refreshToken,
			accessToken: this.accessToken,
			accessTokenExpiry: this.accessTokenExpiry,
		};
	}

	/** Revoke the current token at Google's endpoint (best-effort, never throws) */
	async revokeToken(): Promise<void> {
		const token = this.refreshToken || this.accessToken;
		if (!token) return;

		try {
			await requestUrl({
				url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
			});
		} catch {
			// Best-effort: log but don't throw — local cleanup still proceeds
			this.logger?.warn("Failed to revoke Google token (non-fatal)");
		}
	}
}

const RANDOM_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a cryptographically random string of the given length */
function generateRandomString(length: number): string {
	const limit = 256 - (256 % RANDOM_CHARSET.length);
	const result: string[] = [];
	while (result.length < length) {
		const array = new Uint8Array(length - result.length);
		crypto.getRandomValues(array);
		for (const b of array) {
			if (b < limit && result.length < length) {
				result.push(RANDOM_CHARSET[b % RANDOM_CHARSET.length]!);
			}
		}
	}
	return result.join("");
}
