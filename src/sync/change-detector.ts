import type { IFileSystem } from "../fs/interface";
import type { MixedEntity, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { LocalChangeTracker } from "./local-tracker";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import { md5 } from "../utils/md5";
import { AsyncPool } from "../queue/async-queue";

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

	let changeSet: ChangeSet;

	// Determine temperature
	if (localTracker.isInitialized() && localTracker.getDirtyPaths().size > 0) {
		changeSet = await collectHot(deps);
	} else {
		const allRecords = await stateStore.getAll();
		changeSet = allRecords.length === 0
			? await collectCold(deps, allRecords)
			: await collectWarm(deps, allRecords);
	}

	// Enrich empty hashes for entries without baseline (all temperature modes)
	await enrichHashesForInitialMatch(changeSet.entries, deps.localFs);

	return changeSet;
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

	return { entries: Array.from(pathMap.values()), temperature: "cold" };
}

/**
 * Enrich empty hashes for entries without baseline by comparing local MD5
 * with remote's backend-provided contentChecksum. Runs for all temperature
 * modes to handle partial initial syncs and simultaneous file creation.
 */
async function enrichHashesForInitialMatch(
	entries: MixedEntity[],
	localFs: IFileSystem,
): Promise<void> {
	const candidates = entries.filter(
		(e) => e.local && e.remote && !e.prevSync &&
			!e.local.hash && !e.remote.hash &&
			e.local.size === e.remote.size &&
			typeof e.remote.backendMeta?.contentChecksum === "string"
	);
	if (candidates.length === 0) return;

	const pool = new AsyncPool(10);
	await Promise.all(
		candidates.map((entry) =>
			pool.run(async () => {
				try {
					const content = await localFs.read(entry.path);
					const localMd5 = md5(content);
					const remoteMd5 = entry.remote!.backendMeta!.contentChecksum as string;
					if (localMd5 === remoteMd5) {
						entry.local = { ...entry.local!, hash: `md5:${localMd5}` };
						entry.remote = { ...entry.remote!, hash: `md5:${localMd5}` };
					}
				} catch {
					// Skip failed reads — entry stays unenriched (conflict, safe side)
				}
			})
		)
	);
}

async function getRemoteChangedPaths(remoteFs: IFileSystem): Promise<string[]> {
	if (!remoteFs.getChangedPaths) return [];
	const result = await remoteFs.getChangedPaths();
	if (!result) return [];
	return [...result.modified, ...result.deleted];
}
