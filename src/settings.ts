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

	/** Write sync logs to .smartsync/logs/{device}/{date}.log */
	enableLogging: boolean;
	/** Minimum log level to write */
	logLevel: "debug" | "info" | "warn" | "error";

	/** Backend-specific data, keyed by backend type (e.g. "googledrive") */
	backendData: Record<string, Record<string, unknown>>;
}

export const DEFAULT_SETTINGS: SmartSyncSettings = {
	vaultId: "",
	backendType: "googledrive",
	autoSyncIntervalMinutes: 5,
	conflictStrategy: "keep_newer",
	excludePatterns: [],
	enableThreeWayMerge: false,
	mobileIncludePatterns: ["**/*.md", "**/*.canvas"],
	mobileMaxFileSizeMB: 10,
	enableLogging: false,
	logLevel: "info",
	backendData: {},
};

