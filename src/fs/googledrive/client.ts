import { requestUrl } from "obsidian";
import type { GoogleAuth } from "./auth";
import type { DriveFile, DriveFileList, DriveChangeList } from "./types";
import {
	assertDriveFile,
	assertDriveFileList,
	assertStartPageTokenResponse,
	assertDriveChangeList,
} from "./types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024; // 5MB
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB, 256KB-aligned (required by Drive API)
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,md5Checksum";

/**
 * Low-level Google Drive REST API v3 client.
 * Uses Obsidian's requestUrl for CORS-free requests.
 */
export class DriveClient {
	private auth: GoogleAuth;

	constructor(auth: GoogleAuth) {
		this.auth = auth;
	}

	/** Wrap requestUrl with operation-name context and preserve status/headers for retry logic */
	private async request(
		operation: string,
		opts: Parameters<typeof requestUrl>[0]
	): Promise<ReturnType<typeof requestUrl>> {
		try {
			return await requestUrl(opts);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const wrapped = new Error(`Drive API ${operation} failed: ${msg}`);
			if (err && typeof err === "object" && "status" in err) {
				(wrapped as unknown as Record<string, unknown>).status = (err as Record<string, unknown>).status;
			}
			if (err && typeof err === "object" && "headers" in err) {
				(wrapped as unknown as Record<string, unknown>).headers = (err as Record<string, unknown>).headers;
			}
			if (err && typeof err === "object" && "json" in err) {
				(wrapped as unknown as Record<string, unknown>).json = (err as Record<string, unknown>).json;
			}
			throw wrapped;
		}
	}

	/** List all files in a folder (paginated) */
	async listFiles(
		folderId: string,
		pageToken?: string
	): Promise<DriveFileList> {
		const token = await this.auth.getAccessToken();
		const escapedId = folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
		const params = new URLSearchParams({
			q: `'${escapedId}' in parents and trashed = false`,
			fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,md5Checksum)",
			pageSize: "1000",
		});
		if (pageToken) {
			params.set("pageToken", pageToken);
		}

		const response = await this.request("listFiles", {
			url: `${DRIVE_API}/files?${params.toString()}`,
			headers: { Authorization: `Bearer ${token}` },
		});
		const result = response.json;
		assertDriveFileList(result);
		return result;
	}

	/** Recursively list all files under a folder */
	async listAllFiles(rootFolderId: string): Promise<DriveFile[]> {
		const allFiles: DriveFile[] = [];
		const folderQueue: string[] = [rootFolderId];

		while (folderQueue.length > 0) {
			const folderId = folderQueue.shift()!;
			let pageToken: string | undefined;

			do {
				const result = await this.listFiles(folderId, pageToken);
				for (const file of result.files) {
					allFiles.push(file);
					if (file.mimeType === FOLDER_MIME) {
						folderQueue.push(file.id);
					}
				}
				pageToken = result.nextPageToken;
			} while (pageToken);
		}

		return allFiles;
	}

	/** Download file content */
	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const token = await this.auth.getAccessToken();
		const response = await this.request("downloadFile", {
			url: `${DRIVE_API}/files/${fileId}?alt=media`,
			headers: { Authorization: `Bearer ${token}` },
		});
		return response.arrayBuffer;
	}

	/** Upload a file (simple upload for small files) */
	async uploadFile(
		name: string,
		parentId: string,
		content: ArrayBuffer,
		mimeType = "application/octet-stream",
		existingFileId?: string,
		modifiedTime: number = Date.now()
	): Promise<DriveFile> {
		if (content.byteLength > RESUMABLE_THRESHOLD) {
			return this.uploadFileResumable(
				name,
				parentId,
				content,
				mimeType,
				existingFileId,
				modifiedTime
			);
		}

		const token = await this.auth.getAccessToken();
		const metadata: Record<string, unknown> = { name };
		if (!existingFileId) {
			metadata.parents = [parentId];
		}
		metadata.modifiedTime = new Date(modifiedTime).toISOString();

		// Use multipart upload
		const boundary = "smart_sync_boundary_" + Date.now();
		const metaJson = JSON.stringify(metadata);

		const encoder = new TextEncoder();
		const preamble = encoder.encode(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
		);
		const postamble = encoder.encode(`\r\n--${boundary}--`);

		const body = new Uint8Array(
			preamble.length + content.byteLength + postamble.length
		);
		body.set(preamble, 0);
		body.set(new Uint8Array(content), preamble.length);
		body.set(postamble, preamble.length + content.byteLength);

		const url = existingFileId
			? `${UPLOAD_API}/files/${existingFileId}?uploadType=multipart&fields=${FILE_FIELDS}`
			: `${UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`;
		const method = existingFileId ? "PATCH" : "POST";

		const response = await this.request("uploadFile", {
			url,
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": `multipart/related; boundary=${boundary}`,
			},
			body: body.buffer,
		});

		const driveFile = response.json;
		assertDriveFile(driveFile);
		return driveFile;
	}

	/** Resumable upload for large files (>5MB) */
	async uploadFileResumable(
		name: string,
		parentId: string,
		content: ArrayBuffer,
		mimeType = "application/octet-stream",
		existingFileId?: string,
		modifiedTime: number = Date.now()
	): Promise<DriveFile> {
		const token = await this.auth.getAccessToken();
		const metadata: Record<string, unknown> = { name };
		if (!existingFileId) {
			metadata.parents = [parentId];
		}
		metadata.modifiedTime = new Date(modifiedTime).toISOString();

		// Initiate resumable upload
		const initUrl = existingFileId
			? `${UPLOAD_API}/files/${existingFileId}?uploadType=resumable&fields=${FILE_FIELDS}`
			: `${UPLOAD_API}/files?uploadType=resumable&fields=${FILE_FIELDS}`;
		const method = existingFileId ? "PATCH" : "POST";

		const initResponse = await this.request("uploadFileResumable:init", {
			url: initUrl,
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=UTF-8",
				"X-Upload-Content-Type": mimeType,
				"X-Upload-Content-Length": String(content.byteLength),
			},
			body: JSON.stringify(metadata),
		});

		const uploadUrl = initResponse.headers["location"];
		if (!uploadUrl) {
			throw new Error("Resumable upload: no upload URL in response");
		}

		// Upload content in chunks
		const totalSize = content.byteLength;
		let offset = 0;

		while (offset < totalSize) {
			const end = Math.min(offset + CHUNK_SIZE, totalSize);
			const chunk = content.slice(offset, end);
			const isLastChunk = end === totalSize;

			try {
				const uploadResponse = await this.request(
					"uploadFileResumable:upload",
					{
						url: uploadUrl,
						method: "PUT",
						headers: {
							"Content-Type": mimeType,
							"Content-Length": String(chunk.byteLength),
							"Content-Range": `bytes ${offset}-${end - 1}/${totalSize}`,
						},
						body: chunk,
					}
				);

				// Final chunk — 200/201 response
				if (isLastChunk) {
					const driveFile = uploadResponse.json;
					assertDriveFile(driveFile);
					return driveFile;
				}

				// Non-last chunk succeeded with 200/201 (unexpected but valid)
				const driveFile = uploadResponse.json;
				assertDriveFile(driveFile);
				return driveFile;
			} catch (err) {
				if (isResumeIncomplete(err)) {
					// 308 Resume Incomplete — parse Range header for next offset
					offset = parseResumedOffset(err);
					continue;
				}
				throw err;
			}
		}

		// Edge case: empty file (totalSize === 0)
		const uploadResponse = await this.request(
			"uploadFileResumable:upload",
			{
				url: uploadUrl,
				method: "PUT",
				headers: {
					"Content-Type": mimeType,
					"Content-Length": "0",
				},
				body: new ArrayBuffer(0),
			}
		);
		const driveFile = uploadResponse.json;
		assertDriveFile(driveFile);
		return driveFile;
	}

	/** Create a folder */
	async createFolder(name: string, parentId: string): Promise<DriveFile> {
		const token = await this.auth.getAccessToken();
		const response = await this.request("createFolder", {
			url: `${DRIVE_API}/files?fields=${FILE_FIELDS}`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name,
				mimeType: FOLDER_MIME,
				parents: [parentId],
			}),
		});
		const folder = response.json;
		assertDriveFile(folder);
		return folder;
	}

	/** Update file metadata (rename, move) via PATCH */
	async updateFileMetadata(
		fileId: string,
		metadata: { name?: string },
		addParents?: string,
		removeParents?: string
	): Promise<DriveFile> {
		const token = await this.auth.getAccessToken();
		const params = new URLSearchParams({ fields: FILE_FIELDS });
		if (addParents) params.set("addParents", addParents);
		if (removeParents) params.set("removeParents", removeParents);

		const response = await this.request("updateFileMetadata", {
			url: `${DRIVE_API}/files/${fileId}?${params.toString()}`,
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(metadata),
		});
		const updated = response.json;
		assertDriveFile(updated);
		return updated;
	}

	/** Delete a file or folder (trash or permanent) */
	async deleteFile(fileId: string, permanent = false): Promise<void> {
		const token = await this.auth.getAccessToken();
		if (permanent) {
			await this.request("deleteFile", {
				url: `${DRIVE_API}/files/${fileId}`,
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			});
		} else {
			await this.request("trashFile", {
				url: `${DRIVE_API}/files/${fileId}`,
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ trashed: true }),
			});
		}
	}

	/** Get the start page token for changes.list */
	async getChangesStartToken(): Promise<string> {
		const token = await this.auth.getAccessToken();
		const response = await this.request("getChangesStartToken", {
			url: `${DRIVE_API}/changes/startPageToken`,
			headers: { Authorization: `Bearer ${token}` },
		});
		const result = response.json;
		assertStartPageTokenResponse(result);
		return result.startPageToken;
	}

	/** List changes since a given page token */
	async listChanges(
		startPageToken: string,
		pageToken?: string
	): Promise<DriveChangeList> {
		const token = await this.auth.getAccessToken();
		const params = new URLSearchParams({
			pageToken: pageToken ?? startPageToken,
			fields:
				"nextPageToken,newStartPageToken,changes(type,fileId,removed,file(id,name,mimeType,size,modifiedTime,parents,md5Checksum,trashed))",
			pageSize: "1000",
		});

		const response = await this.request("listChanges", {
			url: `${DRIVE_API}/changes?${params.toString()}`,
			headers: { Authorization: `Bearer ${token}` },
		});
		const result = response.json;
		assertDriveChangeList(result);
		return result;
	}
}

/** Check if an error is a 308 Resume Incomplete response from Drive */
function isResumeIncomplete(err: unknown): boolean {
	return (
		err != null &&
		typeof err === "object" &&
		"status" in err &&
		(err as { status: unknown }).status === 308
	);
}

/** Parse the next upload offset from a 308 response's Range header */
function parseResumedOffset(err: unknown): number {
	const headers =
		err != null && typeof err === "object" && "headers" in err
			? (err as { headers: Record<string, string> }).headers
			: undefined;
	const range = headers?.["range"] ?? headers?.["Range"];
	if (range) {
		// Range header format: "bytes=0-12345"
		const match = range.match(/bytes=\d+-(\d+)/);
		if (match) {
			return parseInt(match[1]!, 10) + 1;
		}
	}
	// No Range header means no bytes were received; restart from 0
	return 0;
}
