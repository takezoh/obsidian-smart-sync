import type { IFileSystem } from "../fs/interface";
import type { MixedEntity, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { LocalChangeTracker } from "./local-tracker";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import { md5 } from "../utils/md5";

export interface ChangeSet {
	entries: MixedEntity[];
	temperature: "hot" | "warm" | "cold";
}

export interface ChangeDetectorDeps {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	stateStore: SyncStateStore;
	localTracker: LocalChangeTracker;
}

/**
 * Collect changes using the appropriate temperature mode.
 *
 * hot  (O(delta)): tracker initialized + dirty paths → stat() + cache + getMany()
 * warm (O(n) local + O(delta) remote): list() + getAll() diff + remote delta
 * cold (O(n)): both list() + full join (equivalent to buildMixedEntities)
 */
export async function collectChanges(deps: ChangeDetectorDeps): Promise<ChangeSet> {
	const { localTracker, stateStore } = deps;

	// Determine temperature
	if (localTracker.isInitialized()) {
		const dirtyPaths = localTracker.getDirtyPaths();
		if (dirtyPaths.size > 0) {
			return collectHot(deps);
		}
	}

	const allRecords = await stateStore.getAll();
	const isCold = allRecords.length === 0;

	if (isCold) {
		return collectCold(deps, allRecords);
	}

	return collectWarm(deps, allRecords);
}

async function collectHot(deps: ChangeDetectorDeps): Promise<ChangeSet> {
	const { localFs, remoteFs, stateStore, localTracker } = deps;

	const dirtyPaths = localTracker.getDirtyPaths();

	// Get remote changed paths if supported
	const remoteChangedPaths = await getRemoteChangedPaths(remoteFs);

	// Union of local dirty and remote changed paths
	const changedPaths = new Set<string>(dirtyPaths);
	for (const p of remoteChangedPaths) {
		changedPaths.add(p);
	}

	const pathArray = Array.from(changedPaths);

	// Fetch local stats, remote stats, and sync records in parallel
	const [localStats, remoteStats, syncRecords] = await Promise.all([
		Promise.all(pathArray.map((p) => localFs.stat(p))),
		Promise.all(pathArray.map((p) => remoteFs.stat(p))),
		stateStore.getMany(pathArray),
	]);

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const local = localStats[i] ?? undefined;
		const remote = remoteStats[i] ?? undefined;
		const prevSync = syncRecords.get(path);
		return {
			path,
			local: local?.isDirectory ? undefined : local,
			remote: remote?.isDirectory ? undefined : remote,
			prevSync,
		};
	});

	// Also include unchanged records not in changedPaths so downstream has full picture
	// (only entries with actual changes are included in hot mode — callers handle partial sets)
	const filtered = entries.filter((e) => {
		// Include if local or remote exists, or if there's a prevSync (deletion case)
		return e.local !== undefined || e.remote !== undefined || e.prevSync !== undefined;
	});

	// Check which hot entries actually changed vs baseline (prune no-ops)
	const changed = filtered.filter((e) => {
		const prev = e.prevSync;
		// Deletion: exists in prev but not locally or remotely
		if (!e.local && !e.remote) return !!prev;
		// New file: no prev record
		if (!prev) return true;
		// Local changed
		if (e.local && hasChanged(e.local, prev)) return true;
		// Remote changed
		if (e.remote && hasRemoteChanged(e.remote, prev)) return true;
		return false;
	});

	return { entries: changed, temperature: "hot" };
}

async function collectWarm(deps: ChangeDetectorDeps, allRecords: SyncRecord[]): Promise<ChangeSet> {
	const { localFs, remoteFs } = deps;

	const [localFiles, remoteChangedPaths] = await Promise.all([
		localFs.list(),
		getRemoteChangedPaths(remoteFs),
	]);

	const recordMap = new Map(allRecords.map((r) => [r.path, r]));
	const changedPaths = new Set<string>();

	// Compare local listing against sync records
	for (const file of localFiles) {
		if (file.isDirectory) continue;
		const record = recordMap.get(file.path);
		if (!record || hasChanged(file, record)) {
			changedPaths.add(file.path);
		}
	}

	// Include paths that existed in records but are no longer in local listing (local deletions)
	const localPathSet = new Set(localFiles.filter((f) => !f.isDirectory).map((f) => f.path));
	for (const record of allRecords) {
		if (!localPathSet.has(record.path)) {
			changedPaths.add(record.path);
		}
	}

	// Add remote changed paths
	for (const p of remoteChangedPaths) {
		changedPaths.add(p);
	}

	const pathArray = Array.from(changedPaths);
	const remoteStats = await Promise.all(pathArray.map((p) => remoteFs.stat(p)));

	const localFileMap = new Map(localFiles.filter((f) => !f.isDirectory).map((f) => [f.path, f]));

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const remote = remoteStats[i] ?? undefined;
		return {
			path,
			local: localFileMap.get(path),
			remote: remote?.isDirectory ? undefined : remote,
			prevSync: recordMap.get(path),
		};
	});

	return { entries, temperature: "warm" };
}

async function collectCold(deps: ChangeDetectorDeps, allRecords: SyncRecord[]): Promise<ChangeSet> {
	const { localFs, remoteFs } = deps;

	const [localFiles, remoteFiles] = await Promise.all([
		localFs.list(),
		remoteFs.list(),
	]);
	const syncRecords = allRecords;

	const pathMap = new Map<string, MixedEntity>();

	const getOrCreate = (path: string): MixedEntity => {
		let entity = pathMap.get(path);
		if (!entity) {
			entity = { path };
			pathMap.set(path, entity);
		}
		return entity;
	};

	for (const file of localFiles) {
		if (file.isDirectory) continue;
		getOrCreate(file.path).local = file;
	}

	for (const file of remoteFiles) {
		if (file.isDirectory) continue;
		getOrCreate(file.path).remote = file;
	}

	for (const record of syncRecords) {
		getOrCreate(record.path).prevSync = record;
	}

	// Resolve empty hashes for cold start: compare local MD5 with remote's
	// backend-provided contentChecksum to detect identical files without downloading.
	// Only checks same-size files (different sizes are guaranteed different content).
	for (const entry of pathMap.values()) {
		if (!entry.local || !entry.remote || entry.prevSync) continue;
		if (entry.local.hash || entry.remote.hash) continue;
		if (entry.local.size !== entry.remote.size) continue;

		const remoteMd5 = entry.remote.backendMeta?.contentChecksum;
		if (typeof remoteMd5 !== "string") continue;

		const content = await localFs.read(entry.path);
		const localMd5 = md5(content);

		if (localMd5 === remoteMd5) {
			entry.local = { ...entry.local, hash: `md5:${localMd5}` };
			entry.remote = { ...entry.remote, hash: `md5:${localMd5}` };
		}
	}

	return { entries: Array.from(pathMap.values()), temperature: "cold" };
}

async function getRemoteChangedPaths(remoteFs: IFileSystem): Promise<string[]> {
	if (!remoteFs.getChangedPaths) return [];
	const result = await remoteFs.getChangedPaths();
	if (!result) return [];
	return [...result.modified, ...result.deleted];
}
