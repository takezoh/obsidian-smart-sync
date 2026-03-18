import type { ConflictStrategy } from "./sync/types";

export interface AirSyncSettings {
	/** Unique identifier for this vault (used as IndexedDB key) */
	vaultId: string;
	/** Selected backend type (e.g. "googledrive") */
	backendType: string;
	/** Strategy for conflict resolution */
	conflictStrategy: ConflictStrategy;
	/** Gitignore-style patterns to exclude from sync */
	ignorePatterns: string[];
	/** Enable 3-way merge for text files */
	enableThreeWayMerge: boolean;
	/** Dot-prefixed paths to include in sync (e.g. [".templates", ".stversions"]) */
	syncDotPaths: string[];
	/** Maximum file size in MB to sync on mobile */
	mobileMaxFileSizeMB: number;

	/** Write sync logs to .airsync/logs/{device}/{date}.log */
	enableLogging: boolean;
	/** Minimum log level to write */
	logLevel: "debug" | "info" | "warn" | "error";

	/** Backend-specific data, keyed by backend type (e.g. "googledrive") */
	backendData: Record<string, Record<string, unknown>>;
}

export const DEFAULT_SETTINGS: AirSyncSettings = {
	vaultId: "",
	backendType: "googledrive",
	conflictStrategy: "auto_merge",
	ignorePatterns: [],
	syncDotPaths: [],
	enableThreeWayMerge: true,
	mobileMaxFileSizeMB: 10,
	enableLogging: false,
	logLevel: "info",
	backendData: {},
};



