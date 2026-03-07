import { requestUrl } from "obsidian";
import type { GoogleAuth } from "./auth";
import type { Logger } from "../../logging/logger";
import type { DriveFile, DriveFileList, DriveChangeList } from "./types";
import {
	FOLDER_MIME,
	assertDriveFile,
	assertDriveFileList,
	assertStartPageTokenResponse,
	assertDriveChangeList,
	buildUploadMetadata,
} from "./types";
import { AsyncPool } from "../../queue/async-queue";
import { ResumableUploader, RESUMABLE_THRESHOLD } from "./resumable-upload";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,md5Checksum";

/**
 * Low-level Google Drive REST API v3 client.
 * Uses Obsidian's requestUrl for CORS-free requests.
 */
export class DriveClient {
	private auth: GoogleAuth;
	private logger?: Logger;
	private resumableUploader: ResumableUploader;

	constructor(auth: GoogleAuth, logger?: Logger) {
		this.auth = auth;
		this.logger = logger;
		this.resumableUploader = new ResumableUploader({
			auth,
			request: (operation, opts) => this.request(operation, opts),
			logger,
		});
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

	/** Find a child file/folder by name under a parent */
	async findChildByName(
		parentId: string,
		name: string,
		mimeType?: string
	): Promise<DriveFile | null> {
		const token = await this.auth.getAccessToken();
		const escapedParent = parentId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
		const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
		let q = `'${escapedParent}' in parents and name = '${escapedName}' and trashed = false`;
		if (mimeType) {
			q += ` and mimeType = '${mimeType}'`;
		}
		const params = new URLSearchParams({
			q,
			fields: `files(${FILE_FIELDS})`,
			pageSize: "1",
		});
		const response = await this.request("findChildByName", {
			url: `${DRIVE_API}/files?${params.toString()}`,
			headers: { Authorization: `Bearer ${token}` },
		});
		const result: unknown = response.json;
		assertDriveFileList(result);
		return result.files[0] ?? null;
	}

	/** Get a file's metadata by ID */
	async getFile(fileId: string): Promise<DriveFile> {
		const token = await this.auth.getAccessToken();
		const params = new URLSearchParams({ fields: FILE_FIELDS });
		const response = await this.request("getFile", {
			url: `${DRIVE_API}/files/${fileId}?${params.toString()}`,
			headers: { Authorization: `Bearer ${token}` },
		});
		const result: unknown = response.json;
		assertDriveFile(result);
		return result;
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

	/** Recursively list all files under a folder with bounded concurrency */
	async listAllFiles(rootFolderId: string): Promise<DriveFile[]> {
		const allFiles: DriveFile[] = [];
		const pool = new AsyncPool(3);
		const tasks: Promise<void>[] = [];

		const enqueueFolder = (folderId: string): void => {
			const task = pool.run(async () => {
				let pageToken: string | undefined;
				do {
					const result = await this.listFiles(folderId, pageToken);
					for (const file of result.files) {
						allFiles.push(file);
						if (file.mimeType === FOLDER_MIME) {
							enqueueFolder(file.id);
						}
					}
					pageToken = result.nextPageToken;
				} while (pageToken);
			});
			tasks.push(task);
		};

		enqueueFolder(rootFolderId);

		// Drain: await tasks as they are added (tasks array grows dynamically)
		for (let i = 0; i < tasks.length; i++) {
			await tasks[i];
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

	/** Upload a file (simple multipart for small files, resumable for >5MB) */
	async uploadFile(
		name: string,
		parentId: string,
		content: ArrayBuffer,
		mimeType = "application/octet-stream",
		existingFileId?: string,
		modifiedTime: number = Date.now()
	): Promise<DriveFile> {
		if (content.byteLength > RESUMABLE_THRESHOLD) {
			return this.resumableUploader.upload(
				name,
				parentId,
				content,
				mimeType,
				existingFileId,
				modifiedTime
			);
		}

		const token = await this.auth.getAccessToken();
		const metadata = buildUploadMetadata(name, parentId, modifiedTime, existingFileId);

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

	/** Clear cached resume URLs (call on plugin unload) */
	clearResumeCache(): void {
		this.resumableUploader.clearResumeCache();
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
