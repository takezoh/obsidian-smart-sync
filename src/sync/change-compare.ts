import type { FileEntity } from "../fs/types";
import type { SyncRecord } from "./types";

/**
 * Check if a local file has changed since the last sync.
 * Priority: mtime+size (fast, no I/O) → content hash → conservative.
 */
export function hasChanged(file: FileEntity, record: SyncRecord): boolean {
	// Prefer mtime+size comparison (avoids content read)
	if (file.mtime > 0 && record.localMtime > 0) {
		if (file.mtime !== record.localMtime || file.size !== record.localSize) {
			// mtime/size differ — verify hash before concluding changed
			if (file.hash && record.hash) {
				return file.hash !== record.hash;
			}
			return true;
		}
		// mtime+size match — verify hash if both available (catches same-size edits)
		if (file.hash && record.hash) {
			return file.hash !== record.hash;
		}
		return false;
	}
	// Fall back to hash comparison if available
	if (file.hash && record.hash) {
		return file.hash !== record.hash;
	}
	// Conservative: treat as changed if we can't determine
	return true;
}

/**
 * Check if a remote file has changed since the last sync.
 * Priority: mtime+size (fast) → backendMeta.contentChecksum (backend-provided
 * checksum, reliable when mtime is missing or unreliable) → content hash → conservative.
 */
export function hasRemoteChanged(file: FileEntity, record: SyncRecord): boolean {
	const rawFileMd5 = file.backendMeta?.contentChecksum;
	const rawRecordMd5 = record.backendMeta?.contentChecksum;
	const fileMd5 = typeof rawFileMd5 === "string" ? rawFileMd5 : undefined;
	const recordMd5 = typeof rawRecordMd5 === "string" ? rawRecordMd5 : undefined;

	if (file.mtime > 0 && record.remoteMtime > 0) {
		if (file.mtime === record.remoteMtime && file.size === record.remoteSize) {
			// mtime+size match — verify hash if both available (catches same-size edits)
			if (file.hash && record.hash) {
				return file.hash !== record.hash;
			}
			return false;
		}
		// mtime/size differ — check md5 before concluding changed
		if (fileMd5 && recordMd5) {
			return fileMd5 !== recordMd5;
		}
		return true;
	}
	// Use backend-provided contentChecksum when available (e.g. Drive md5, Dropbox content_hash)
	if (fileMd5 && recordMd5) {
		return fileMd5 !== recordMd5;
	}
	if (file.hash && record.hash) {
		return file.hash !== record.hash;
	}
	return true;
}
