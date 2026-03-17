import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { Logger } from "../../logging/logger";
import type { DriveFile } from "./types";
import { assertDriveFile, buildUploadMetadata } from "./types";

const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,md5Checksum";
export const RESUMABLE_THRESHOLD = 5 * 1024 * 1024; // 5MB
const RESUME_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

interface ResumeCacheEntry {
	uploadUrl: string;
	totalSize: number;
	createdAt: number;
}

/** Dependencies injected by DriveClient */
export interface ResumableUploadDeps {
	getToken: (forceRefresh?: boolean) => Promise<string>;
	request: (
		operation: string,
		opts: RequestUrlParam
	) => Promise<RequestUrlResponse>;
	logger?: Logger;
}

/**
 * Handles resumable uploads (>5MB) to Google Drive.
 * Caches upload session URLs so failed uploads can be resumed on retry.
 */
export class ResumableUploader {
	private deps: ResumableUploadDeps;
	private resumeCache = new Map<string, ResumeCacheEntry>();

	constructor(deps: ResumableUploadDeps) {
		this.deps = deps;
	}

	/** Resumable upload for large files (>5MB) */
	async upload(
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

		const token = await this.deps.getToken();
		const metadata = buildUploadMetadata(name, parentId, modifiedTime, existingFileId);

		// Initiate resumable upload
		const initUrl = existingFileId
			? `${UPLOAD_API}/files/${existingFileId}?uploadType=resumable&fields=${FILE_FIELDS}`
			: `${UPLOAD_API}/files?uploadType=resumable&fields=${FILE_FIELDS}`;
		const method = existingFileId ? "PATCH" : "POST";

		const initResponse = await this.deps.request("uploadFileResumable:init", {
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
			const uploadResponse = await this.deps.request(
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
			const response = await this.deps.request("uploadFileResumable:resume", {
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
			const response = await this.deps.request(
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
}
