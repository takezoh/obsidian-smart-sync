import { requestUrl } from "obsidian";
import type { Logger } from "../../logging/logger";
import { assertTokenResponse } from "./types";
import { AuthError } from "../errors";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_SERVER_URL = "https://auth-smartsync.takezo.dev";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
export const DEFAULT_CUSTOM_SCOPE = SCOPES;
export const DEFAULT_CUSTOM_REDIRECT_URI = "https://smartsync.takezo.dev/callback";
const REDIRECT_URI = `${AUTH_SERVER_URL}/google/callback`;

const GOOGLE_CLIENT_ID = "135801498656-lfjor2ml3v26t9l63mkoka0bndgl9eue.apps.googleusercontent.com";
const AUTH_FAILED_COOLDOWN = 60_000;

/** Shared interface for GoogleAuth and GoogleAuthDirect */
export interface IGoogleAuth {
	setTokens(refreshToken: string, accessToken: string, expiry: number): void;
	readonly isAuthenticated: boolean;
	getAuthorizationUrl(): Promise<string>;
	getAuthState(): string | null;
	setAuthState(authState: string): void;
	getCodeVerifier(): string | null;
	setCodeVerifier(verifier: string): void;
	handleAuthCallback(params: Record<string, string | undefined>): Promise<void>;
	getAccessToken(forceRefresh?: boolean): Promise<string>;
	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number };
	revokeToken(): Promise<void>;
}

/**
 * Base class for Google OAuth implementations.
 * Manages token storage, refresh deduplication, CSRF state, and revocation.
 * Subclasses provide the auth URL, callback handling, and refresh strategy.
 */
abstract class GoogleAuthBase implements IGoogleAuth {
	protected accessToken = "";
	protected accessTokenExpiry = 0;
	protected refreshToken = "";
	private refreshPromise: Promise<string> | null = null;
	protected logger?: Logger;
	private authState: string | null = null;
	private codeVerifier: string | null = null;
	protected authFailedAt = 0;

	setTokens(refreshToken: string, accessToken: string, expiry: number): void {
		this.refreshToken = refreshToken;
		this.accessToken = accessToken;
		this.accessTokenExpiry = expiry;
		this.authFailedAt = 0;
	}

	get isAuthenticated(): boolean {
		return this.refreshToken.length > 0;
	}

	abstract getAuthorizationUrl(): Promise<string>;

	getAuthState(): string | null {
		return this.authState;
	}

	setAuthState(authState: string): void {
		this.authState = authState;
	}

	getCodeVerifier(): string | null {
		return this.codeVerifier;
	}

	setCodeVerifier(verifier: string): void {
		this.codeVerifier = verifier;
	}

	abstract handleAuthCallback(params: Record<string, string | undefined>): Promise<void>;

	async getAccessToken(forceRefresh = false): Promise<string> {
		if (!this.refreshToken) {
			throw new AuthError("Not authenticated. Please connect to Google Drive first.", 401);
		}
		if (this.authFailedAt > 0 && Date.now() - this.authFailedAt < AUTH_FAILED_COOLDOWN) {
			throw new AuthError("Authentication expired. Please reconnect in settings.", 401);
		}
		if (!forceRefresh && this.accessToken && Date.now() < this.accessTokenExpiry - 60_000) {
			return this.accessToken;
		}
		if (this.refreshPromise) {
			return this.refreshPromise;
		}
		this.refreshPromise = this.performRefresh();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	protected abstract performRefresh(): Promise<string>;

	/** Handle token refresh errors: set authFailedAt timestamp and throw AuthError for 400/401 */
	protected handleRefreshError(err: unknown): never {
		const status = (err as { status?: number }).status;
		if (status === 400 || status === 401) {
			this.authFailedAt = Date.now();
		}
		const msg = err instanceof Error ? err.message : String(err);
		this.logger?.error("Token refresh failed", { error: msg });
		if (status === 400 || status === 401) {
			throw new AuthError(`Token refresh failed: ${msg}`, status);
		}
		throw err as Error;
	}

	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } {
		return {
			refreshToken: this.refreshToken,
			accessToken: this.accessToken,
			accessTokenExpiry: this.accessTokenExpiry,
		};
	}

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
			this.logger?.warn("Failed to revoke Google token (non-fatal)");
		}
	}

	/** Verify CSRF state and clear it. Returns the validated state. */
	protected verifyAndClearState(state: string | undefined): void {
		if (!this.authState) {
			throw new Error("OAuth state is missing. Please restart the authorization flow.");
		}
		if (!state || state !== this.authState) {
			throw new Error("State mismatch - possible CSRF attack");
		}
	}

	protected clearAuthState(): void {
		this.authState = null;
	}

	/** Store tokens from a validated TokenResponse */
	protected storeTokenResponse(token: { access_token: string; refresh_token?: string; expires_in: number }): void {
		this.accessToken = token.access_token;
		this.accessTokenExpiry = Date.now() + token.expires_in * 1000;
		if (token.refresh_token) {
			this.refreshToken = token.refresh_token;
		}
		this.authFailedAt = 0;
	}

	/** Generate a state parameter with the given extra fields */
	protected generateState(extra: Record<string, unknown> = {}): string {
		this.authState = btoa(JSON.stringify({
			app: "obsidian-plugin",
			...extra,
			nonce: generateRandomString(32),
		}));
		return this.authState;
	}
}

/**
 * Handles OAuth 2.0 authentication for Google Drive.
 * Token exchange is handled server-side by auth-smartsync.takezo.dev
 * (confidential client with client_secret). The plugin only manages
 * CSRF state verification and token storage.
 */
export class GoogleAuth extends GoogleAuthBase {
	constructor(logger?: Logger) {
		super();
		this.logger = logger;
	}

	getAuthorizationUrl(): Promise<string> {
		const state = this.generateState();

		const params = new URLSearchParams({
			client_id: GOOGLE_CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			scope: SCOPES,
			access_type: "offline",
			prompt: "consent",
			state,
		});
		return Promise.resolve(`${GOOGLE_AUTH_URL}?${params.toString()}`);
	}

	/**
	 * Accept tokens returned by the auth server callback.
	 * The auth server already exchanged the authorization code for tokens;
	 * we just verify the CSRF state and store the tokens.
	 */
	handleAuthCallback(params: Record<string, string | undefined>): Promise<void> {
		try {
			this.verifyAndClearState(params.state);
			if (!params.access_token) {
				throw new Error("Access token is missing from auth callback");
			}

			const expiresIn = parseInt(params.expires_in ?? "3600", 10);
			if (isNaN(expiresIn) || expiresIn <= 0) {
				throw new Error("Invalid expires_in from auth callback");
			}

			this.accessToken = params.access_token;
			this.accessTokenExpiry = Date.now() + expiresIn * 1000;
			if (params.refresh_token) {
				this.refreshToken = params.refresh_token;
			}

			this.clearAuthState();
			return Promise.resolve();
		} catch (err: unknown) {
			return Promise.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}

	protected async performRefresh(): Promise<string> {
		this.logger?.info("Refreshing access token");
		try {
			const response = await requestUrl({
				url: `${AUTH_SERVER_URL}/google/token/refresh`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refresh_token: this.refreshToken }),
			});

			const token: unknown = response.json;
			assertTokenResponse(token);
			this.storeTokenResponse(token);
			return this.accessToken;
		} catch (err) {
			this.handleRefreshError(err);
		}
	}
}

/**
 * Direct OAuth 2.0 authentication using user-provided client credentials.
 * The auth server relays the authorization code back without exchanging it;
 * this class exchanges the code and refreshes tokens directly with Google.
 */
export class GoogleAuthDirect extends GoogleAuthBase {
	private clientId: string;
	private clientSecret: string;
	private scope: string;
	private redirectUri: string;

	constructor(clientId: string, clientSecret: string, logger?: Logger, scope?: string, redirectUri?: string) {
		super();
		this.clientId = clientId;
		this.clientSecret = clientSecret;
		this.scope = scope || SCOPES;
		this.redirectUri = redirectUri || DEFAULT_CUSTOM_REDIRECT_URI;
		this.logger = logger;
	}

	async getAuthorizationUrl(): Promise<string> {
		const state = this.generateState({ custom: true });
		const codeVerifier = generateRandomString(64);
		this.setCodeVerifier(codeVerifier);
		const codeChallenge = await computeS256Challenge(codeVerifier);

		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: this.redirectUri,
			response_type: "code",
			scope: this.scope,
			access_type: "offline",
			prompt: "consent",
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		return `${GOOGLE_AUTH_URL}?${params.toString()}`;
	}

	/**
	 * Exchange the authorization code for tokens directly with Google.
	 * The auth server passes back code + state without exchanging them.
	 * Sends code_verifier for PKCE verification.
	 */
	async handleAuthCallback(params: Record<string, string | undefined>): Promise<void> {
		this.verifyAndClearState(params.state);
		if (!params.code) {
			throw new Error("Authorization code is missing from auth callback");
		}
		const codeVerifier = this.getCodeVerifier();
		if (!codeVerifier) {
			throw new Error("PKCE code verifier is missing. Please restart the authorization flow.");
		}

		const response = await requestUrl({
			url: GOOGLE_TOKEN_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code: params.code,
				client_id: this.clientId,
				client_secret: this.clientSecret,
				redirect_uri: this.redirectUri,
				grant_type: "authorization_code",
				code_verifier: codeVerifier,
			}).toString(),
		});

		const token: unknown = response.json;
		assertTokenResponse(token);
		this.storeTokenResponse(token);
		this.clearAuthState();
	}

	protected async performRefresh(): Promise<string> {
		this.logger?.info("Refreshing access token (direct)");
		try {
			const response = await requestUrl({
				url: GOOGLE_TOKEN_URL,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					refresh_token: this.refreshToken,
					grant_type: "refresh_token",
				}).toString(),
			});

			const token: unknown = response.json;
			assertTokenResponse(token);
			this.storeTokenResponse(token);
			return this.accessToken;
		} catch (err) {
			this.handleRefreshError(err);
		}
	}
}

/** Compute S256 code challenge: base64url(SHA-256(verifier)) */
async function computeS256Challenge(verifier: string): Promise<string> {
	const data = new TextEncoder().encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	// base64url encoding (RFC 7636 Appendix A)
	let base64 = "";
	const bytes = new Uint8Array(hash);
	for (const b of bytes) {
		base64 += String.fromCharCode(b);
	}
	return btoa(base64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
