# Google Drive Backend

## GoogleDriveFs

`GoogleDriveFs` (`fs/googledrive/index.ts`) implements `IFileSystem` for Google Drive. It avoids downloading file content during `list()` and `stat()` by maintaining an in-memory metadata cache. Content is only downloaded when `read()` is called.

### Initialization lifecycle

1. On first `list()`, `stat()`, `read()`, or `write()`, `ensureInitialized()` is called
2. Try to restore cache from IndexedDB (`MetadataStore`) -- checks `rootFolderId` match and presence of a stored `changesStartPageToken`
3. If IndexedDB restore fails, perform a full scan: get a changes start token, then `listAllFiles()` recursively with `AsyncPool(3)` concurrency
4. Build the `DriveMetadataCache` from the flat file list

### Cache invalidation

- `invalidateCache()`: sets `initialized = false` and clears the IndexedDB store. Next operation triggers a full scan.
- `getChangedPaths()`: applies incremental changes before the sync cycle. If the changes token is expired (410), triggers a full scan.

### Mutex protection

All cache reads and writes are protected by `cacheMutex` (an `AsyncMutex`). Write operations use `withCacheMutex()` which:
1. Resolves IDs/paths under the mutex
2. Executes network I/O outside the mutex
3. Re-acquires the mutex with a stale-guard check (verifies the file ID hasn't changed during I/O)

### stat() and hash

`stat()` always returns `hash: ""`. The sync engine uses `backendMeta.contentChecksum` (Drive's `md5Checksum`) for remote change detection via `hasRemoteChanged()`. This avoids downloading file content just to compute a hash.

## DriveMetadataCache

`DriveMetadataCache` (`metadata-cache.ts`) maintains 4 indexes:

| Index | Type | Purpose |
|-------|------|---------|
| `pathToFile` | `Map<string, DriveFile>` | Primary lookup by relative path |
| `idToPath` | `Map<string, string>` | Reverse lookup for changes.list processing |
| `folders` | `Set<string>` | Track which paths are folders |
| `children` | `Map<string, Set<string>>` | Parent-to-children index for O(k) child lookups |

Key operations:
- `buildFromFiles(files)`: builds the cache from a flat `DriveFile[]` list. Uses memoized path resolution (`resolveFilePathCached()`) to compute relative paths from parent chains in O(n) total.
- `applyFileChange(file)`: handles a single incremental change -- resolves path from cache, handles renames/moves, maintains all indexes.
- `removeTree(path)`: removes a path and all descendants (via `collectDescendants()`).
- `rewriteChildPaths(old, new)`: rewrites descendant paths when a folder is renamed.
- `driveFileToEntity(path, driveFile)`: converts cached metadata to `FileEntity` without downloading content.

## Incremental sync

`applyIncrementalChanges()` (`incremental-sync.ts`) integrates with Drive's changes.list API:

1. Fetch changes pages using the stored `changesPageToken`
2. Sort each page: folders first (shallow before deep) so parent paths resolve correctly before children
3. For each change:
   - **Removed/trashed**: collect descendants, call `cache.removeTree()`, add all paths to `changedPaths`
   - **Modified/created**: call `cache.applyFileChange()`, add resolved path to `changedPaths`
4. Persist incremental updates to IndexedDB (parallel with main flow via fire-and-forget)
5. Return `{ newToken, changedPaths }` or `{ needsFullScan: true }` on 410

The 410 fallback resets `initialized = false` and triggers a full scan on the next cache access.

## DriveClient

`DriveClient` (`client.ts`) wraps the Google Drive REST API v3 using Obsidian's `requestUrl` (CORS-free via Electron's net module).

**Requested fields** (`FILE_FIELDS`): `id, name, mimeType, size, modifiedTime, parents, md5Checksum`

Key methods:

| Method | Description |
|--------|-------------|
| `listAllFiles(rootId)` | Recursive listing with `AsyncPool(3)` concurrency |
| `uploadFile(...)` | Multipart upload for files <= 5 MB, delegates to `ResumableUploader` for larger files |
| `downloadFile(fileId)` | `GET /files/{id}?alt=media` |
| `getChangesStartToken()` | `GET /changes/startPageToken` |
| `listChanges(token)` | `GET /changes?pageToken=...` with full file metadata |
| `deleteFile(fileId)` | Soft delete (trash) by default, permanent delete optional |
| `findChildByName(parentId, name)` | Query for deduplication before folder creation |
| `updateFileMetadata(...)` | PATCH for rename/move with `addParents`/`removeParents` |

All methods inject an `Authorization: Bearer` header via `getToken()` and wrap errors with operation context and preserved `status`/`headers`/`json` for retry logic.

## Authentication

Two OAuth implementations share a common base class (`GoogleAuthBase`):

### GoogleAuth (server-side, built-in)

- Redirects to Google OAuth with `redirect_uri` pointing to `auth-smartsync.takezo.dev`
- Auth server exchanges the code for tokens (confidential client with `client_secret`)
- Plugin receives tokens via `obsidian://smart-sync-auth?access_token=...&refresh_token=...`
- Token refresh: POST to `auth-smartsync.takezo.dev/google/token/refresh`
- Scope: `drive.file` (app-created files only)

### GoogleAuthDirect (PKCE, custom credentials)

- User provides their own `client_id` and `client_secret`
- Uses PKCE (S256 code challenge) for the authorization flow
- Auth server relays the code back without exchanging it
- Plugin exchanges code and refreshes tokens directly with Google's token endpoint
- Configurable scope and redirect URI

### Shared behavior (GoogleAuthBase)

- Refresh deduplication: concurrent `getAccessToken()` calls share one in-flight refresh promise
- Proactive refresh: refreshes 60 seconds before expiry
- CSRF protection: random state parameter verified on callback
- Auth failure flag: on 400/401 refresh failure, sets `authFailed = true` -- subsequent calls throw `AuthError` immediately without retrying
- Token revocation: POST to `oauth2.googleapis.com/revoke`

### Token storage

Tokens (`refreshToken`, `accessToken`) are stored in Obsidian's `SecretStorage` via `token-store.ts`, not in `settings.backendData`. Only `accessTokenExpiry` and `changesStartPageToken` are persisted in settings.

## Resumable upload

`ResumableUploader` (`resumable-upload.ts`) handles files > 5 MB (`RESUMABLE_THRESHOLD`):

1. Initiate a resumable upload session (POST/PATCH with `uploadType=resumable`)
2. Upload the entire content in a single PUT (chunked upload is avoided due to Obsidian's `requestUrl` limitations with 308 responses)
3. On failure, cache the upload URL (6-hour TTL) so the next retry can resume:
   - Query Google for bytes received (`Content-Range: bytes */total`)
   - Send only the remaining bytes

## Provider model

### GoogleDriveProvider (built-in)

- Type: `"googledrive"`
- Uses `GoogleAuth` (server-side OAuth)
- `resolveRemoteVault()`: finds or creates a vault folder under `obsidian-smart-sync/` in Drive

### GoogleDriveCustomProvider (user credentials)

- Type: `"googledrive-custom"`
- Uses `GoogleAuthDirect` (PKCE with user-provided `client_id` / `client_secret`)
- Requires `remoteVaultFolderId` to be set manually in settings
- On disconnect, preserves custom credential references and folder ID

Both extend `GoogleDriveProviderBase` which handles `createFs()`, `readBackendState()`, `resetTargetState()`, and `disconnect()`.
