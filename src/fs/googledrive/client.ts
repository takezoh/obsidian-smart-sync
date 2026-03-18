import { requestUrl } from "obsidian";
import type { RequestUrlParam } from "obsidian";
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
	private getToken: (forceRefresh?: boolean) => Promise<string>;
	private logger?: Logger;
	private resumableUploader: ResumableUploader;

	constructor(getToken: (forceRefresh?: boolean) => Promise<string>, logger?: Logger) {
		this.getToken = getToken;
		this.logger = logger;
		this.resumableUploader = new ResumableUploader({
			getToken,
			request: (operation, opts) => this.request(operation, opts),
			logger,
		});
	}

	/** Wrap requestUrl with operation-name context, inject auth header, and preserve status/headers for retry logic */
	private async request(
		operation: string,
		opts: RequestUrlParam,
		retried = false
	): Promise<Awaited<ReturnType<typeof requestUrl>>> {
		const token = await this.getToken(retried);
		try {
			return await requestUrl({
				...opts,
				headers: { ...opts.headers, Authorization: `Bearer ${token}` },
			});
		} catch (err) {
			const status = err && typeof err === "object" && "status" in err
				? (err as Record<string, unknown>).status
				: undefined;

			if (status === 401 && !retried) {
				this.logger?.info("Drive API returned 401, refreshing token and retrying", { operation });
				return this.request(operation, opts, true);
			}

			const msg = err instanceof Error ? err.message : String(err);
			const wrapped = new Error(`Drive API ${operation} failed: ${msg}`);
			if (err && typeof err === "object") {
				const src = err as Record<string, unknown>;
				this.logger?.error("Drive API request failed", { operation, status: src.status, error: msg });
				for (const key of ["status", "headers", "json"] as const) {
					if (key in src) {
						(wrapped as unknown as Record<string, unknown>)[key] = src[key];
					}
				}
			} else {
				this.logger?.error("Drive API request failed", { operation, error: msg });
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
		});
		const result: unknown = response.json;
		assertDriveFileList(result);
		return result.files[0] ?? null;
	}

	/** Get a file's metadata by ID */
	async getFile(fileId: string): Promise<DriveFile> {
		const params = new URLSearchParams({ fields: FILE_FIELDS });
		const response = await this.request("getFile", {
			url: `${DRIVE_API}/files/${fileId}?${params.toString()}`,
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
		const response = await this.request("downloadFile", {
			url: `${DRIVE_API}/files/${fileId}?alt=media`,
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

		const metadata = buildUploadMetadata(name, parentId, modifiedTime, existingFileId);

		// Use multipart upload
		const boundary = "air_sync_boundary_" + Date.now();
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
		const response = await this.request("createFolder", {
			url: `${DRIVE_API}/files?fields=${FILE_FIELDS}`,
			method: "POST",
			headers: {
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
		const params = new URLSearchParams({ fields: FILE_FIELDS });
		if (addParents) params.set("addParents", addParents);
		if (removeParents) params.set("removeParents", removeParents);

		const response = await this.request("updateFileMetadata", {
			url: `${DRIVE_API}/files/${fileId}?${params.toString()}`,
			method: "PATCH",
			headers: {
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
		if (permanent) {
			await this.request("deleteFile", {
				url: `${DRIVE_API}/files/${fileId}`,
				method: "DELETE",
			});
		} else {
			await this.request("trashFile", {
				url: `${DRIVE_API}/files/${fileId}`,
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ trashed: true }),
			});
		}
	}

	/** Get the start page token for changes.list */
	async getChangesStartToken(): Promise<string> {
		const response = await this.request("getChangesStartToken", {
			url: `${DRIVE_API}/changes/startPageToken`,
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
		const params = new URLSearchParams({
			pageToken: pageToken ?? startPageToken,
			fields:
				"nextPageToken,newStartPageToken,changes(type,fileId,removed,file(id,name,mimeType,size,modifiedTime,parents,md5Checksum,trashed))",
			pageSize: "1000",
		});

		const response = await this.request("listChanges", {
			url: `${DRIVE_API}/changes?${params.toString()}`,
		});
		const result: unknown = response.json;
		assertDriveChangeList(result);
		return result;
	}
}
