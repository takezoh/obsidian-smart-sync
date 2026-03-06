import type { FileRecord } from "../../store/metadata-store";

/** Drive-specific file record type alias */
export type DriveFileRecord = FileRecord<DriveFile>;

/** Google Drive file metadata from API response */
export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	size?: string;
	modifiedTime?: string;
	parents?: string[];
	trashed?: boolean;
	md5Checksum?: string;
}

/** Response from files.list API */
export interface DriveFileList {
	files: DriveFile[];
	nextPageToken?: string;
}

/** A single change from changes.list */
export interface DriveChange {
	type: string;
	fileId: string;
	removed: boolean;
	file?: DriveFile;
}

/** Response from changes.list API */
export interface DriveChangeList {
	changes: DriveChange[];
	nextPageToken?: string;
	newStartPageToken?: string;
}

/** OAuth token response */
export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
}

/** Response from changes.getStartPageToken */
export interface StartPageTokenResponse {
	startPageToken: string;
}

/** Assert that obj is a valid TokenResponse (has required fields) */
export function assertTokenResponse(
	obj: unknown
): asserts obj is TokenResponse {
	if (
		!obj ||
		typeof obj !== "object" ||
		!("access_token" in obj) ||
		typeof (obj as Record<string, unknown>).access_token !== "string" ||
		!("expires_in" in obj) ||
		typeof (obj as Record<string, unknown>).expires_in !== "number"
	) {
		throw new Error("Invalid token response from server");
	}
}

/** Assert that obj is a valid DriveFile (has required id and name) */
export function assertDriveFile(obj: unknown): asserts obj is DriveFile {
	if (
		!obj ||
		typeof obj !== "object" ||
		!("id" in obj) ||
		typeof (obj as Record<string, unknown>).id !== "string" ||
		!("name" in obj) ||
		typeof (obj as Record<string, unknown>).name !== "string" ||
		!("mimeType" in obj) ||
		typeof (obj as Record<string, unknown>).mimeType !== "string"
	) {
		throw new Error("Invalid file metadata from Drive API");
	}
}

/** Assert that obj has a files array (DriveFileList response) */
export function assertDriveFileList(
	obj: unknown
): asserts obj is DriveFileList {
	if (
		!obj ||
		typeof obj !== "object" ||
		!("files" in obj) ||
		!Array.isArray((obj as Record<string, unknown>).files)
	) {
		throw new Error("Invalid file list response from Drive API");
	}
	for (const item of (obj as DriveFileList).files) {
		assertDriveFile(item);
	}
}

/** Assert that obj is a valid StartPageTokenResponse */
export function assertStartPageTokenResponse(
	obj: unknown
): asserts obj is StartPageTokenResponse {
	if (
		!obj ||
		typeof obj !== "object" ||
		!("startPageToken" in obj) ||
		typeof (obj as Record<string, unknown>).startPageToken !== "string"
	) {
		throw new Error("Invalid start page token response from Drive API");
	}
}

/** Assert that obj has a changes array (DriveChangeList response) */
export function assertDriveChangeList(
	obj: unknown
): asserts obj is DriveChangeList {
	if (
		!obj ||
		typeof obj !== "object" ||
		!("changes" in obj) ||
		!Array.isArray((obj as Record<string, unknown>).changes)
	) {
		throw new Error("Invalid change list response from Drive API");
	}
	for (const item of (obj as DriveChangeList).changes) {
		if (
			!item ||
			typeof item !== "object" ||
			typeof item.fileId !== "string" ||
			typeof item.removed !== "boolean" ||
			typeof item.type !== "string"
		) {
			throw new Error("Invalid change entry in Drive API response");
		}
		if (item.file) {
			assertDriveFile(item.file);
		}
	}
}
