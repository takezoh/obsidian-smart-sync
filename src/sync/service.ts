import type { SmartSyncSettings } from "../settings";
import type { IFileSystem } from "../fs/interface";
import type { IBackendProvider } from "../fs/backend";
import type { ConflictStrategy, MixedEntity, SyncDecision } from "../fs/types";
import { AsyncMutex } from "../queue/async-queue";
import { matchGlob } from "../utils/glob";
import { sha256 } from "../utils/hash";
import { SyncStateStore } from "./state";
import { buildMixedEntities, computeDecisions } from "./engine";
import { SyncExecutor, SyncProgress, SyncResult } from "./executor";

export type SyncStatus = "idle" | "syncing" | "error" | "partial_error" | "not_connected";
const MAX_RETRIES = 3;

/** Keys that readFsState() is allowed to write back to settings. */
const FS_STATE_ALLOWED_KEYS: ReadonlyArray<keyof SmartSyncSettings> = [
	"changesStartPageToken",
	"accessToken",
	"accessTokenExpiry",
	"refreshToken",
];

export interface SyncServiceDeps {
	getSettings: () => SmartSyncSettings;
	saveSettings: () => Promise<void>;
	localFs: () => IFileSystem | null;
	remoteFs: () => IFileSystem | null;
	backendProvider: () => IBackendProvider | null;
	onStatusChange: (status: SyncStatus) => void;
	onProgress: (text: string) => void;
	notify: (message: string, durationMs?: number) => void;
	resolveConflict: (decision: SyncDecision) => Promise<ConflictStrategy>;
	resolveConflictBatch: (conflicts: SyncDecision[]) => Promise<ConflictStrategy | null>;
	/** Returns true when running on mobile (used for mobile sync restrictions) */
	isMobile: () => boolean;
}

/**
 * Orchestrates the sync lifecycle: retry logic, progress reporting,
 * conflict resolution UI, and exclusion filtering.
 */
export class SyncService {
	private syncMutex = new AsyncMutex();
	private stateStore: SyncStateStore;
	private syncPending = false;
	private deps: SyncServiceDeps;

	constructor(deps: SyncServiceDeps) {
		this.deps = deps;
		const vaultId = deps.getSettings().vaultId;
		this.stateStore = new SyncStateStore(vaultId);
	}

	get state(): SyncStateStore {
		return this.stateStore;
	}

	get isLocked(): boolean {
		return this.syncMutex.isLocked;
	}

	async close(): Promise<void> {
		await this.stateStore.close();
	}

	shouldSync(): boolean {
		return !!this.deps.remoteFs() && !this.syncMutex.isLocked;
	}

	isExcluded(path: string): boolean {
		const settings = this.deps.getSettings();
		for (const pattern of settings.excludePatterns) {
			if (matchGlob(pattern, path)) return true;
		}
		// On mobile, only include files matching mobileIncludePatterns
		if (this.deps.isMobile() && settings.mobileIncludePatterns.length > 0) {
			const included = settings.mobileIncludePatterns.some((p) =>
				matchGlob(p, path)
			);
			if (!included) return true;
		}
		return false;
	}

	async runSync(): Promise<void> {
		const remoteFs = this.deps.remoteFs();
		if (!remoteFs) {
			this.deps.onStatusChange("not_connected");
			this.deps.notify("Not connected to a remote backend");
			return;
		}

		if (this.syncMutex.isLocked) {
			this.syncPending = true;
			return;
		}

		await this.syncMutex.run(async () => {
			do {
				this.syncPending = false;
				this.deps.onStatusChange("syncing");

				let lastError: unknown = null;
				let lastResult: SyncResult | null = null;

				for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
					try {
						lastResult = await this.executeSyncOnce();
						lastError = null;
						break;
					} catch (err) {
						lastError = err;
						const { status, retryAfter } = getErrorInfo(err);

						// Non-retryable errors: abort immediately
						if (status === 401) {
							this.deps.onStatusChange("error");
							this.deps.notify(
								"Authentication error. Please reconnect in settings."
							);
							return;
						}
						if (status === 403 && !isRateLimitError(err)) {
							this.deps.onStatusChange("error");
							this.deps.notify(
								"Authentication error. Please reconnect in settings."
							);
							return;
						}
						if (status === 400 || status === 404) {
							break;
						}

						if (attempt === MAX_RETRIES) break;

						// 429 or 403 rate limit: respect Retry-After header if present
						let delay: number;
						if ((status === 429 || status === 403) && retryAfter !== null) {
							delay = retryAfter * 1000;
						} else {
							// Exponential backoff with ±50% jitter
							const base = Math.pow(2, attempt - 1) * 1000;
							delay = base * (0.5 + Math.random());
						}
						await sleep(delay);
					}
				}

				if (lastError) {
					this.deps.onStatusChange("error");
					const msg =
						lastError instanceof Error
							? lastError.message
							: "Unknown error";
					this.deps.notify(`Sync error: ${msg}`);
					console.error(
						"Smart Sync error after retries:",
						lastError
					);
					return;
				}

				// Set status based on result
				if (lastResult && lastResult.errors.length > 0) {
					this.deps.onStatusChange("partial_error");
				} else {
					this.deps.onStatusChange("idle");
				}
			} while (this.syncPending);
		});
	}

	private async executeSyncOnce(): Promise<SyncResult> {
		const localFs = this.deps.localFs();
		const remoteFs = this.deps.remoteFs();
		if (!localFs || !remoteFs) {
			throw new Error("Cannot sync: local or remote filesystem is not available");
		}
		const settings = this.deps.getSettings();

		const entities = await buildMixedEntities(
			localFs,
			remoteFs,
			this.stateStore
		);

		const isMobile = this.deps.isMobile();
		const maxBytes = settings.mobileMaxFileSizeMB * 1024 * 1024;
		const filtered = entities.filter((e) => {
			if (this.isExcluded(e.path)) return false;
			if (isMobile) {
				const size = Math.max(e.local?.size ?? 0, e.remote?.size ?? 0);
				if (size > maxBytes) return false;
			}
			return true;
		});
		// Resolve empty hashes for initial sync (both exist, no prevSync)
		await this.resolveEmptyHashes(filtered, localFs, remoteFs);

		const decisions = computeDecisions(filtered);

		// Show summary modal for bulk resolution when there are many conflicts
		const conflictDecisions = decisions.filter(
			(d) =>
				d.decision === "conflict_both_modified" ||
				d.decision === "conflict_both_created" ||
				d.decision === "conflict_delete_vs_modify"
		);

		let bulkStrategy: ConflictStrategy | null = null;
		if (conflictDecisions.length >= 5 && settings.conflictStrategy === "ask") {
			bulkStrategy = await this.deps.resolveConflictBatch(conflictDecisions);
		}

		const onProgress = (progress: SyncProgress) => {
			if (progress.total > 0) {
				this.deps.onProgress(
					`Syncing ${progress.completed}/${progress.total}...`
				);
			}
		};

		const onConflict = async (
			decision: SyncDecision
		): Promise<ConflictStrategy> => {
			return this.deps.resolveConflict(decision);
		};

		const executor = new SyncExecutor({
			localFs,
			remoteFs,
			stateStore: this.stateStore,
			defaultStrategy: bulkStrategy ?? settings.conflictStrategy,
			enableThreeWayMerge: settings.enableThreeWayMerge,
			onProgress,
			onConflict: bulkStrategy ? undefined : onConflict,
		});

		const result = await executor.execute(decisions);

		// Persist backend FS state (e.g. changes page token)
		const provider = this.deps.backendProvider();
		if (provider?.readFsState && remoteFs) {
			const fsUpdates = provider.readFsState(remoteFs);
			for (const key of FS_STATE_ALLOWED_KEYS) {
				if (key in fsUpdates) {
					(settings as unknown as Record<string, unknown>)[key] = fsUpdates[key];
				}
			}
		}
		await this.deps.saveSettings();

		const parts: string[] = [];
		if (result.pushed > 0) parts.push(`${result.pushed} pushed`);
		if (result.pulled > 0) parts.push(`${result.pulled} pulled`);
		if (result.conflicts > 0) parts.push(`${result.conflicts} conflicts`);
		if (result.errors.length > 0)
			parts.push(`${result.errors.length} errors`);

		// Notify about files with unresolved merge conflict markers
		if (result.mergeConflictPaths.length > 0) {
			const count = result.mergeConflictPaths.length;
			this.deps.notify(
				`${count} file(s) merged with conflict markers. Please review and resolve manually.`,
				10000
			);
			console.warn(
				"Smart Sync: files with conflict markers:",
				result.mergeConflictPaths
			);
		}

		if (parts.length === 0) {
			this.deps.notify("Everything up to date");
		} else {
			this.deps.notify(`Sync: ${parts.join(", ")}`);
		}

		if (result.errors.length > 0) {
			const MAX_SHOW = 3;
			const shown = result.errors.slice(0, MAX_SHOW);
			const more = result.errors.length - shown.length;
			let errorMsg = `Sync errors:\n${shown.join("\n")}`;
			if (more > 0) errorMsg += `\n...and ${more} more`;
			this.deps.notify(errorMsg, 10000);
			console.error("Smart Sync errors:", result.errors);
			// Per-file errors are reported via notify + partial_error status.
			// Transport errors (network, 5xx) throw from the FS layer directly
			// and are handled by the retry loop in runSync().
		}

		return result;
	}

	/**
	 * For initial sync (both sides exist, no prevSync), list() returns empty hashes.
	 * Read content and compute SHA-256 so the engine can detect identical files.
	 * Only reads when sizes match (different sizes are obviously different content).
	 */
	private async resolveEmptyHashes(
		entities: MixedEntity[],
		localFs: IFileSystem,
		remoteFs: IFileSystem
	): Promise<void> {
		for (const entity of entities) {
			if (entity.local && entity.remote && !entity.prevSync &&
				!entity.local.hash && !entity.remote.hash &&
				entity.local.size === entity.remote.size) {
				const [localContent, remoteContent] = await Promise.all([
					localFs.read(entity.path),
					remoteFs.read(entity.path),
				]);
				const [localHash, remoteHash] = await Promise.all([
					sha256(localContent),
					sha256(remoteContent),
				]);
				entity.local = { ...entity.local, hash: localHash };
				entity.remote = { ...entity.remote, hash: remoteHash };
			}
		}
	}
}

export interface ErrorInfo {
	status: number | null;
	retryAfter: number | null;
}

export function getErrorInfo(err: unknown): ErrorInfo {
	if (err && typeof err === "object") {
		const status =
			"status" in err ? (err as { status: number }).status : null;
		let retryAfter: number | null = null;
		if ("headers" in err) {
			const headers = (err as { headers: unknown }).headers;
			let ra: string | null | undefined;
			if (headers && typeof (headers as any).get === "function") {
				// Fetch API Headers object
				ra = (headers as Headers).get("retry-after");
			} else if (headers && typeof headers === "object") {
				const h = headers as Record<string, string>;
				ra = h["retry-after"] ?? h["Retry-After"];
			}
			if (ra) {
				const parsed = Number(ra);
				if (!isNaN(parsed)) {
					retryAfter = parsed;
				} else {
					// RFC 7231: Retry-After can be an HTTP-date
					const dateMs = Date.parse(ra);
					if (!isNaN(dateMs)) {
						retryAfter = Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
					}
				}
			}
		}
		return { status, retryAfter };
	}
	return { status: null, retryAfter: null };
}

const RATE_LIMIT_REASONS = new Set([
	"rateLimitExceeded",
	"userRateLimitExceeded",
	"dailyLimitExceeded",
]);

/** Check if a 403 error is actually a Google Drive rate limit (not an auth error) */
export function isRateLimitError(err: unknown): boolean {
	if (!err || typeof err !== "object" || !("json" in err)) return false;
	try {
		const json = (err as Record<string, unknown>).json;
		if (!json || typeof json !== "object") return false;
		const errors = (json as Record<string, unknown>).error;
		if (!errors || typeof errors !== "object") return false;
		const errList = (errors as Record<string, unknown>).errors;
		if (!Array.isArray(errList)) return false;
		return errList.some(
			(e: unknown) =>
				e &&
				typeof e === "object" &&
				"reason" in e &&
				typeof (e as { reason: unknown }).reason === "string" &&
				RATE_LIMIT_REASONS.has((e as { reason: string }).reason)
		);
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
