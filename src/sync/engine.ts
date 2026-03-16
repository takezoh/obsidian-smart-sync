import type { IFileSystem } from "../fs/interface";
import type { MixedEntity, SyncDecision } from "./types";
import type { SyncStateStore } from "./state";
import { hasChanged, hasRemoteChanged } from "./change-compare";
export { hasChanged, hasRemoteChanged } from "./change-compare";

/**
 * Build a combined view of all paths from local, remote, and previous sync state.
 */
export async function buildMixedEntities(
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	stateStore: SyncStateStore
): Promise<MixedEntity[]> {
	const [localFiles, remoteFiles, syncRecords] = await Promise.all([
		localFs.list(),
		remoteFs.list(),
		stateStore.getAll(),
	]);

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

	return Array.from(pathMap.values());
}

/**
 * 3-state decision table: compare local, remote, and previous sync state
 * to determine the required action for each file path.
 */
export function computeDecisions(entities: MixedEntity[]): SyncDecision[] {
	return entities.map((entity) => computeDecision(entity));
}

function computeDecision(entity: MixedEntity): SyncDecision {
	const { path, local, remote, prevSync } = entity;
	const base: Omit<SyncDecision, "decision"> = {
		path,
		local,
		remote,
		prevSync,
	};

	const localExists = !!local;
	const remoteExists = !!remote;
	const prevExists = !!prevSync;

	// Both exist, previous sync exists — compare changes
	if (local && remote && prevSync) {
		const localChanged = hasChanged(local, prevSync);
		const remoteChanged = hasRemoteChanged(remote, prevSync);

		if (localChanged && remoteChanged) {
			return { ...base, decision: "conflict_both_modified" };
		}
		if (localChanged) {
			return { ...base, decision: "local_modified_push" };
		}
		if (remoteChanged) {
			return { ...base, decision: "remote_modified_pull" };
		}
		return { ...base, decision: "no_action" };
	}

	// Both exist, no previous sync — both created independently
	if (localExists && remoteExists && !prevExists) {
		// Skip conflict if content is identical (both hashes present and match)
		if (local?.hash && remote?.hash &&
			local.hash === remote.hash &&
			local.size === remote.size) {
			return { ...base, decision: "initial_match" };
		}
		return { ...base, decision: "conflict_both_created" };
	}

	// Only local exists
	if (local && !remoteExists) {
		if (prevSync) {
			// Remote was deleted. Check if local was modified.
			const localChanged = hasChanged(local, prevSync);
			if (localChanged) {
				return { ...base, decision: "conflict_delete_vs_modify" };
			}
			return { ...base, decision: "remote_deleted_propagate" };
		}
		// New local file, never synced
		return { ...base, decision: "local_created_push" };
	}

	// Only remote exists
	if (!localExists && remote) {
		if (prevSync) {
			// Local was deleted. Check if remote was modified.
			const remoteChanged = hasRemoteChanged(remote, prevSync);
			if (remoteChanged) {
				return { ...base, decision: "conflict_delete_vs_modify" };
			}
			return { ...base, decision: "local_deleted_propagate" };
		}
		// New remote file, never synced
		return { ...base, decision: "remote_created_pull" };
	}

	// Neither exists but prevSync exists — both deleted (clean up stale record)
	if (!localExists && !remoteExists && prevExists) {
		return { ...base, decision: "both_deleted_cleanup" };
	}

	return { ...base, decision: "no_action" };
}

