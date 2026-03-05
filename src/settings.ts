import type { ConflictStrategy } from "./fs/types";

export interface SmartSyncSettings {
	/** Unique identifier for this vault (used as IndexedDB key) */
	vaultId: string;
	/** Selected backend type (e.g. "googledrive") */
	backendType: string;
	/** Auto-sync interval in minutes (0 = disabled) */
	autoSyncIntervalMinutes: number;
	/** Strategy for conflict resolution */
	conflictStrategy: ConflictStrategy;
	/** Glob patterns to exclude from sync */
	excludePatterns: string[];
	/** Enable 3-way merge for text files */
	enableThreeWayMerge: boolean;
	/** Glob patterns for files to include on mobile */
	mobileIncludePatterns: string[];
	/** Maximum file size in MB to sync on mobile */
	mobileMaxFileSizeMB: number;

	/** Write sync logs to .smartsync/{device}/{date}.log */
	enableLogging: boolean;
	/** Minimum log level to write */
	logLevel: "debug" | "info" | "warn" | "error";

	// --- Google Drive backend fields ---
	// These live at the top level for simplicity. Each backend reads
	// only the fields it needs; unknown fields are ignored.
	/** Google Drive folder ID to sync with */
	driveFolderId: string;
	/** OAuth refresh token */
	refreshToken: string;
	/** OAuth access token (transient, cached) */
	accessToken: string;
	/** Access token expiry (Unix epoch ms) */
	accessTokenExpiry: number;
	/** Google Drive changes.list startPageToken for incremental sync */
	changesStartPageToken: string;
	/** Pending PKCE code verifier (survives plugin reload during auth flow) */
	pendingCodeVerifier: string;
	/** Pending auth state (survives plugin reload during auth flow) */
	pendingAuthState: string;
}

export const DEFAULT_SETTINGS: SmartSyncSettings = {
	vaultId: "",
	backendType: "googledrive",
	autoSyncIntervalMinutes: 5,
	conflictStrategy: "keep_newer",
	excludePatterns: [".trash/**"],
	enableThreeWayMerge: false,
	mobileIncludePatterns: ["**/*.md", "**/*.canvas"],
	mobileMaxFileSizeMB: 10,
	enableLogging: false,
	logLevel: "info",
	driveFolderId: "",
	refreshToken: "",
	accessToken: "",
	accessTokenExpiry: 0,
	changesStartPageToken: "",
	pendingCodeVerifier: "",
	pendingAuthState: "",
};

/**
 * Get the default exclude patterns including the vault's config directory.
 * Must be called after the vault is available to resolve configDir.
 */
export function getDefaultExcludePatterns(configDir: string): string[] {
	return [`${configDir}/**`, ".trash/**"];
}
