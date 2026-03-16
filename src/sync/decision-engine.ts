import type { MixedEntity, SyncAction, SyncPlan } from "./types";
import { checkSafety } from "./safety-check";

export function planSync(entries: MixedEntity[]): SyncPlan {
	const actions: SyncAction[] = [];

	for (const entry of entries) {
		const action = decideAction(entry);
		if (action !== null) {
			actions.push(action);
		}
	}

	return { actions, safetyCheck: checkSafety(actions) };
}

function decideAction(entry: MixedEntity): SyncAction | null {
	const { path, local, remote, prevSync } = entry;
	const base = { path, local, remote, baseline: prevSync };

	if (prevSync) {
		if (local && remote) {
			const localChanged = hasLocalChanged(local, prevSync);
			const remoteChanged = hasRemoteChanged(remote, prevSync);

			if (localChanged && remoteChanged) {
				return { ...base, action: "conflict" };
			}
			if (localChanged) {
				return { ...base, action: "push" };
			}
			if (remoteChanged) {
				return { ...base, action: "pull" };
			}
			return null;
		}

		if (local && !remote) {
			const localChanged = hasLocalChanged(local, prevSync);
			if (localChanged) {
				return { ...base, action: "conflict" };
			}
			return { ...base, action: "delete_local" };
		}

		if (!local && remote) {
			const remoteChanged = hasRemoteChanged(remote, prevSync);
			if (remoteChanged) {
				return { ...base, action: "conflict" };
			}
			return { ...base, action: "delete_remote" };
		}

		// Neither exists but baseline exists → both deleted
		return { ...base, action: "cleanup" };
	}

	// No baseline
	if (local && !remote) {
		return { ...base, action: "push" };
	}

	if (!local && remote) {
		return { ...base, action: "pull" };
	}

	if (local && remote) {
		if (
			local.hash &&
			remote.hash &&
			local.hash === remote.hash &&
			local.size === remote.size
		) {
			return { ...base, action: "match" };
		}
		return { ...base, action: "conflict" };
	}

	return null;
}

function hasLocalChanged(
	file: { mtime: number; size: number; hash?: string },
	record: { localMtime: number; localSize: number; hash: string }
): boolean {
	if (file.mtime > 0 && record.localMtime > 0) {
		if (file.mtime !== record.localMtime || file.size !== record.localSize) {
			if (file.hash && record.hash) {
				return file.hash !== record.hash;
			}
			return true;
		}
		if (file.hash && record.hash) {
			return file.hash !== record.hash;
		}
		return false;
	}
	if (file.hash && record.hash) {
		return file.hash !== record.hash;
	}
	return true;
}

function hasRemoteChanged(
	file: { mtime: number; size: number; hash?: string; backendMeta?: Record<string, unknown> },
	record: {
		remoteMtime: number;
		remoteSize: number;
		hash: string;
		backendMeta?: Record<string, unknown>;
	}
): boolean {
	const rawFileMd5 = file.backendMeta?.contentChecksum;
	const rawRecordMd5 = record.backendMeta?.contentChecksum;
	const fileMd5 = typeof rawFileMd5 === "string" ? rawFileMd5 : undefined;
	const recordMd5 = typeof rawRecordMd5 === "string" ? rawRecordMd5 : undefined;

	if (file.mtime > 0 && record.remoteMtime > 0) {
		if (file.mtime === record.remoteMtime && file.size === record.remoteSize) {
			if (file.hash && record.hash) {
				return file.hash !== record.hash;
			}
			return false;
		}
		if (fileMd5 && recordMd5) {
			return fileMd5 !== recordMd5;
		}
		return true;
	}
	if (fileMd5 && recordMd5) {
		return fileMd5 !== recordMd5;
	}
	if (file.hash && record.hash) {
		return file.hash !== record.hash;
	}
	return true;
}
