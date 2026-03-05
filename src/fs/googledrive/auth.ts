import { requestUrl } from "obsidian";
import type { TokenResponse } from "./types";
import { assertTokenResponse } from "./types";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/drive";
const REDIRECT_URI = "https://smartsync.takezo.dev/callback/";

// Injected at build time via esbuild define (see esbuild.config.mjs)
const GOOGLE_CLIENT_ID: string = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET: string = process.env.GOOGLE_CLIENT_SECRET ?? "";

/**
 * Handles OAuth 2.0 authentication for Google Drive.
 * Uses PKCE (S256) and loopback redirect for security.
 * Exchanges tokens directly with Google's token endpoint (desktop OAuth client).
 */
export class GoogleAuth {
	private accessToken = "";
	private accessTokenExpiry = 0;
	private refreshToken = "";
	private refreshPromise: Promise<string> | null = null;

	/** PKCE code verifier for the current auth flow */
	private codeVerifier: string | null = null;
	/** Anti-CSRF state parameter for the current auth flow */
	private authState: string | null = null;

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
	 * Uses PKCE (S256) and a state parameter for security.
	 */
	async getAuthorizationUrl(): Promise<string> {
		this.codeVerifier = generateRandomString(64);
		this.authState = generateRandomString(32);
		const codeChallenge = await computeS256Challenge(this.codeVerifier);

		const params = new URLSearchParams({
			client_id: GOOGLE_CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			scope: SCOPES,
			access_type: "offline",
			prompt: "consent",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
			state: this.authState,
		});
		return `${GOOGLE_AUTH_URL}?${params.toString()}`;
	}

	/** Get the current auth state for CSRF verification */
	getAuthState(): string | null {
		return this.authState;
	}

	/** Get the current PKCE code verifier */
	getCodeVerifier(): string | null {
		return this.codeVerifier;
	}

	/** Restore PKCE state (e.g. after plugin reload during auth flow) */
	setPkceState(codeVerifier: string, authState: string): void {
		this.codeVerifier = codeVerifier;
		this.authState = authState;
	}

	/**
	 * Exchange an authorization code for tokens via Google's token endpoint.
	 * Sends the PKCE code_verifier and client_secret alongside the code.
	 */
	async exchangeCode(code: string, state?: string): Promise<TokenResponse> {
		// Verify CSRF state
		if (!this.authState) {
			throw new Error("OAuth state is missing. Please restart the authorization flow.");
		}
		if (!state || state !== this.authState) {
			throw new Error("State mismatch - possible CSRF attack");
		}

		if (!code?.trim()) {
			throw new Error("Authorization code is empty");
		}
		if (!this.codeVerifier?.trim()) {
			throw new Error("PKCE code verifier is missing. Please restart the authorization flow.");
		}

		const params = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: GOOGLE_CLIENT_ID,
			client_secret: GOOGLE_CLIENT_SECRET,
			code_verifier: this.codeVerifier,
		});

		const response = await requestUrl({
			url: GOOGLE_TOKEN_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});

		const token: unknown = response.json;
		assertTokenResponse(token);
		this.accessToken = token.access_token;
		this.accessTokenExpiry = Date.now() + token.expires_in * 1000;
		if (token.refresh_token) {
			this.refreshToken = token.refresh_token;
		}

		// Clear PKCE state after use
		this.codeVerifier = null;
		this.authState = null;

		return token;
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

	/** Perform the actual token refresh (called at most once per expiry cycle) */
	private async _refreshToken(): Promise<string> {
		const params = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: this.refreshToken,
			client_id: GOOGLE_CLIENT_ID,
			client_secret: GOOGLE_CLIENT_SECRET,
		});

		const response = await requestUrl({
			url: GOOGLE_TOKEN_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
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
			console.warn("Smart Sync: failed to revoke Google token (non-fatal)");
		}
	}
}

/** RFC 7636 unreserved characters: [A-Za-z0-9-._~] (66 chars) */
const PKCE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** Generate a cryptographically random string of the given length using RFC 7636 charset */
function generateRandomString(length: number): string {
	const array = new Uint8Array(length);
	crypto.getRandomValues(array);
	return Array.from(array, (b) => PKCE_CHARSET[b % PKCE_CHARSET.length]).join("");
}

/** Compute S256 PKCE code challenge: BASE64URL(SHA256(code_verifier)) */
async function computeS256Challenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return base64urlEncode(new Uint8Array(hash));
}

/** Base64url encode a Uint8Array (no padding, per RFC 7636) */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
