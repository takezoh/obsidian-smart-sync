import { requestUrl } from "obsidian";
import type { GoogleAuth } from "./auth";
import type { Logger } from "../../logging/logger";
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
const RESUME_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,md5Checksum";

interface ResumeCacheEntry {
	uploadUrl: string;
	totalSize: number;
	createdAt: number;
}

/**
 * Low-level Google Drive REST API v3 client.
 * Uses Obsidian's requestUrl for CORS-free requests.
 */
export class DriveClient {
	private auth: GoogleAuth;
	private logger?: Logger;
	private resumeCache = new Map<string, ResumeCacheEntry>();

	constructor(auth: GoogleAuth, logger?: Logger) {
		this.auth = auth;
		this.logger = logger;
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
			const status = err && typeof err === "object" && "status" in err ? (err as Record<string, unknown>).status : undefined;
			this.logger?.error("Drive API request failed", { operation, status, error: msg });
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
		const result: unknown = response.json;
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

		const driveFile: unknown = response.json;
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
		const cacheKey = existingFileId ?? `${parentId}/${name}`;

		// Check resume cache for a previous failed upload
		const cached = this.resumeCache.get(cacheKey);
		if (
			cached &&
			cached.totalSize === content.byteLength &&
			Date.now() - cached.createdAt < RESUME_CACHE_TTL
		) {
			this.resumeCache.delete(cacheKey);
			const resumed = await this.tryResumeUpload(
				cached.uploadUrl,
				content,
				cached.totalSize,
				mimeType
			);
			if (resumed) return resumed;
			// Fall through to fresh upload if resume failed
		}

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

		// Upload entire content in a single PUT.
		// Chunked upload is avoided because Obsidian's requestUrl (Electron net module)
		// cannot reliably handle 308 Resume Incomplete responses (empty body triggers
		// JSON parse errors, and manual Content-Length headers cause ERR_INVALID_ARGUMENT).
		try {
			const uploadResponse = await this.request(
				"uploadFileResumable:upload",
				{
					url: uploadUrl,
					method: "PUT",
					headers: {
						"Content-Type": mimeType,
					},
					body: content.byteLength > 0 ? content : new ArrayBuffer(0),
				}
			);
			const driveFile: unknown = uploadResponse.json;
			assertDriveFile(driveFile);
			return driveFile;
		} catch (err) {
			// Cache the resume URL so the next retry can continue from where we left off
			this.resumeCache.set(cacheKey, {
				uploadUrl,
				totalSize: content.byteLength,
				createdAt: Date.now(),
			});
			throw err;
		}
	}

	/**
	 * Attempt to resume a previously failed upload.
	 * Returns DriveFile on success, or null if resume is not possible (caller should do fresh upload).
	 */
	private async tryResumeUpload(
		uploadUrl: string,
		content: ArrayBuffer,
		totalSize: number,
		mimeType: string
	): Promise<DriveFile | null> {
		const status = await this.queryUploadStatus(uploadUrl, totalSize);
		if (!status) return null;

		if ("file" in status) {
			// Upload was already complete
			return status.file;
		}

		// Resume from where Google left off
		const bytesReceived = status.bytesReceived;
		const remaining = content.slice(bytesReceived);
		const end = totalSize - 1;

		try {
			const response = await this.request("uploadFileResumable:resume", {
				url: uploadUrl,
				method: "PUT",
				headers: {
					"Content-Type": mimeType,
					"Content-Range": `bytes ${bytesReceived}-${end}/${totalSize}`,
				},
				body: remaining,
			});
			const driveFile: unknown = response.json;
			assertDriveFile(driveFile);
			return driveFile;
		} catch {
			// Resume PUT failed — fall back to fresh upload
			return null;
		}
	}

	/**
	 * Query Google for how many bytes have been received for a resumable upload.
	 * Returns { bytesReceived } on 308, { file } on 200/201, or null on error.
	 */
	private async queryUploadStatus(
		uploadUrl: string,
		totalSize: number
	): Promise<{ bytesReceived: number } | { file: DriveFile } | null> {
		try {
			// A successful response means the upload is already complete
			const response = await this.request(
				"uploadFileResumable:status",
				{
					url: uploadUrl,
					method: "PUT",
					headers: {
						"Content-Range": `bytes */${totalSize}`,
					},
					body: new ArrayBuffer(0),
				}
			);
			const driveFile: unknown = response.json;
			assertDriveFile(driveFile);
			return { file: driveFile };
		} catch (err) {
			// 308 Resume Incomplete — parse Range header for bytes received
			if (
				err &&
				typeof err === "object" &&
				"status" in err &&
				(err as Record<string, unknown>).status === 308
			) {
				const headers = (err as Record<string, unknown>).headers;
				if (headers && typeof headers === "object") {
					const range = (headers as Record<string, string>)["range"];
					if (range) {
						// Range header format: "bytes=0-N"
						const match = /bytes=0-(\d+)/.exec(range);
						if (match) {
							return { bytesReceived: parseInt(match[1]!, 10) + 1 };
						}
					}
				}
				// 308 but no parseable Range — Google received 0 bytes
				return { bytesReceived: 0 };
			}
			// Any other error — can't determine status
			return null;
		}
	}

	/** Clear cached resume URLs (call on plugin unload) */
	clearResumeCache(): void {
		this.resumeCache.clear();
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
		const folder: unknown = response.json;
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
		const updated: unknown = response.json;
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
		const result: unknown = response.json;
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
		const result: unknown = response.json;
		assertDriveChangeList(result);
		return result;
	}
}


