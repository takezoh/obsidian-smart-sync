# Smart Sync — Architecture

This document describes the technical design of the Smart Sync plugin, based on the implemented code.

## Overview

A plugin for bidirectional sync between an Obsidian vault and Google Drive. Uses 3-state comparison (local / remote / last sync record) for accurate change detection, with 3-way merge support for text files.

Backends are swappable via `IFileSystem` + `IBackendProvider` abstraction. The initial implementation covers Google Drive only, but the same interface allows adding Dropbox, S3, etc.

## File structure

```
src/
├── main.ts                         # Plugin entry point (lifecycle management)
├── settings.ts                     # SmartSyncSettings type & defaults
├── fs/
│   ├── types.ts                    # FileEntity
│   ├── interface.ts                # IFileSystem interface
│   ├── auth.ts                     # IAuthProvider interface
│   ├── backend.ts                  # IBackendProvider interface
│   ├── registry.ts                 # Backend registry (getBackendProvider, getAllBackendProviders)
│   ├── backend-manager.ts          # BackendManager — backend initialization, auth flow, lifecycle
│   ├── local/
│   │   ├── index.ts                # LocalFs — Obsidian Vault API wrapper
│   │   └── dot-path-adapter.ts     # DotPathAdapter — .smartsync/ adapter (raw Vault adapter API)
│   ├── googledrive/
│   │   ├── index.ts                # GoogleDriveFs — IFileSystem implementation (cache + incremental fetch)
│   │   ├── client.ts               # DriveClient — Drive REST API v3 client
│   │   ├── auth.ts                 # GoogleAuth — OAuth 2.0 + PKCE
│   │   ├── provider.ts             # GoogleDriveProvider — IBackendProvider implementation
│   │   ├── types.ts                # Drive API response types, validation functions + DriveFileRecord alias
│   │   ├── metadata-cache.ts       # DriveMetadataCache — in-memory path↔ID, folder, children index
│   │   ├── incremental-sync.ts     # applyIncrementalChanges() — changes.list delta sync
│   │   ├── remote-vault.ts         # resolveGDriveRemoteVault() — Drive-specific remote vault resolution
│   │   └── resumable-upload.ts     # ResumableUploader — resumable upload (>5 MB) with resume-on-retry
│   └── mock/
│       └── index.ts                # MockFs — in-memory IFileSystem for testing
├── sync/
│   ├── remote-vault.ts             # RemoteVaultStore (IndexedDB), shared types & constants
│   ├── types.ts                   # SyncRecord, MixedEntity, DecisionType, ConflictStrategy, SyncDecision
│   ├── engine.ts                   # buildMixedEntities() + computeDecisions() — 3-state decision table
│   ├── executor.ts                 # SyncExecutor — executes IFileSystem operations based on decisions
│   ├── executor-ops.ts             # executePush/Pull/Delete/Conflict — per-phase operation functions
│   ├── service.ts                  # SyncService — sync orchestration (retry, exclusion, UI integration)
│   ├── error.ts                    # getErrorInfo() — HTTP status & Retry-After extraction
│   ├── state.ts                    # SyncStateStore — IndexedDB-based sync state persistence
│   ├── conflict.ts                 # resolveConflict() — conflict resolution strategy execution
│   └── merge.ts                    # threeWayMerge() + isMergeEligible() — 3-way merge via node-diff3
├── store/
│   ├── idb-helper.ts               # IDBHelper — shared IndexedDB lifecycle & transaction helper
│   └── metadata-store.ts           # MetadataStore<T> — generic IndexedDB metadata cache for backends
├── logging/
│   └── logger.ts                   # Logger — structured logging to vault files
├── queue/
│   └── async-queue.ts              # AsyncMutex + AsyncPool — concurrency primitives
├── utils/
│   ├── hash.ts                     # sha256() — Web Crypto API
│   ├── glob.ts                     # matchGlob() — glob pattern matching (regex conversion + cache)
│   └── path.ts                     # Path utilities
├── ui/
│   ├── settings.ts                 # SmartSyncSettingTab — settings tab UI
│   ├── backend-settings.ts         # IBackendSettingsRenderer interface + renderer registry
│   ├── googledrive-settings.ts     # GoogleDriveSettingsRenderer — Google Drive settings UI
│   ├── conflict-modal.ts           # ConflictModal — individual conflict resolution modal
│   └── conflict-summary-modal.ts   # ConflictSummaryModal — bulk conflict resolution modal
└── __mocks__/
    ├── obsidian.ts                 # Obsidian API mock (for vitest)
    └── sync-test-helpers.ts        # Test helpers (MockFs creation, file utilities, etc.)
```

## Layer architecture

```
┌─────────────────────────────────────────────────────┐
│  main.ts (SmartSyncPlugin)                          │
│  - Lifecycle management                             │
│  - Command, ribbon, status bar registration         │
│  - Auto-sync timer, event-driven & foreground sync  │
│  - Logger initialization (passed to service layer)  │
├─────────────────────────────────────────────────────┤
│  fs/backend-manager.ts (BackendManager)             │
│  - Backend initialization & connection flow         │
│  - Remote vault resolution (before FS creation)     │
│  - Auth lifecycle (start, complete, disconnect)     │
│  - Manages IBackendProvider + IFileSystem instances  │
├─────────────────────────────────────────────────────┤
│  sync/service.ts (SyncService)                      │
│  - Sync orchestration                               │
│  - Retry (exponential backoff + jitter, max 3)      │
│  - Mutual exclusion (syncMutex)                     │
│  - Conflict UI dispatch                             │
│  - Progress & result notification                   │
├─────────────────────────────────────────────────────┤
│  sync/engine.ts        sync/executor.ts             │
│  - 3-state decision    - Translates decisions into  │
│    table                 IFileSystem operations      │
│  - MixedEntity build   - Updates SyncRecords        │
│                        - Delegates conflict resolve  │
├─────────────────────────────────────────────────────┤
│  sync/state.ts         sync/conflict.ts             │
│  - IndexedDB CRUD      - resolveConflict()          │
│  - sync-records store  - 6 strategy implementations │
│  - sync-content store  sync/merge.ts                │
│    (for 3-way merge)   - node-diff3 wrapper         │
├─────────────────────────────────────────────────────┤
│  fs/interface.ts (IFileSystem)                      │
│  - list, stat, read, write, mkdir, listDir,         │
│    delete, rename, close                             │
├──────────────────┬──────────────────────────────────┤
│  fs/local/       │  fs/googledrive/                 │
│  LocalFs         │  GoogleDriveFs                   │
│  (Vault API)     │  (Drive REST API v3)             │
│                  │  + DriveClient + GoogleAuth      │
│                  │  + GoogleDriveAuthProvider       │
└──────────────────┴──────────────────────────────────┘
```

**Dependency direction**: `main.ts` → `BackendManager` → `IBackendProvider` → `IFileSystem`; `main.ts` → `SyncService` → `engine/executor` → `IFileSystem`. The sync engine is unaware of which backend is in use.

---

## Core data models

### FileEntity (`fs/types.ts`)

Unified data model representing a single file/folder on the file system.

```typescript
interface FileEntity {
  path: string;                        // Vault-relative path (common key)
  isDirectory: boolean;
  size: number;                        // Bytes
  mtime: number;                       // Last modified (Unix ms)
  hash: string;                        // SHA-256 (empty string = not computed)
  backendMeta?: Record<string, unknown>; // Backend-specific data
}
```

`backendMeta` stores backend-specific data (e.g., Drive `fileId`, `headRevisionId`). The sync engine only uses `path`, `mtime`, `size`, and `hash`; it transparently persists `backendMeta` in `SyncRecord` without interpreting its contents.

### SyncRecord (`sync/types.ts`)

Records the state at the time of the last successful sync. Persisted in IndexedDB.

```typescript
interface SyncRecord {
  path: string;                        // keyPath
  hash: string;                        // Content SHA-256 at sync time
  localMtime: number;
  remoteMtime: number;
  localSize: number;
  remoteSize: number;
  backendMeta?: Record<string, unknown>;
  syncedAt: number;                    // Sync completion time (Unix ms)
}
```

### MixedEntity (`sync/types.ts`)

Input for 3-state comparison. Bundles the local, remote, and last sync states for a single file.

```typescript
interface MixedEntity {
  path: string;
  local?: FileEntity;
  remote?: FileEntity;
  prevSync?: SyncRecord;
}
```

### SyncDecision (`sync/types.ts`)

Output of `computeDecisions()`. The sync action for each file.

```typescript
interface SyncDecision {
  path: string;
  decision: DecisionType;
  local?: FileEntity;
  remote?: FileEntity;
  prevSync?: SyncRecord;
}
```

### DecisionType (`sync/types.ts`)

```typescript
type DecisionType =
  | "local_created_push"          // Local new → upload
  | "local_modified_push"         // Local modified → upload
  | "remote_created_pull"         // Remote new → download
  | "remote_modified_pull"        // Remote modified → download
  | "local_deleted_propagate"     // Local deleted → delete remote too
  | "remote_deleted_propagate"    // Remote deleted → delete local too
  | "initial_match"               // Both exist, identical content → seed SyncRecord
  | "conflict_both_modified"      // Both modified → conflict resolution
  | "conflict_both_created"       // Both new → conflict resolution
  | "conflict_delete_vs_modify"   // Delete vs modify → conflict resolution
  | "both_deleted_cleanup"        // Both deleted → clean up record
  | "no_action";                  // No change
```

### ConflictStrategy (`sync/types.ts`)

```typescript
type ConflictStrategy =
  | "keep_newer"       // Timestamp comparison
  | "keep_local"       // Local wins
  | "keep_remote"      // Remote wins
  | "duplicate"        // Create .conflict file
  | "three_way_merge"  // Auto-merge via node-diff3
  | "ask";             // Prompt user via modal
```

---

## IFileSystem interface (`fs/interface.ts`)

Common interface implemented by all file system backends.

```typescript
interface IFileSystem {
  readonly name: string;  // "local" | "googledrive" | "mock" etc.
  list(): Promise<FileEntity[]>;
  stat(path: string): Promise<FileEntity | null>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity>;
  mkdir(path: string): Promise<FileEntity>;
  listDir(path: string): Promise<FileEntity[]>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  close?(): Promise<void>;  // Release resources (optional)
}
```

**Path convention**: Vault-relative paths. No leading/trailing slashes. `/` as separator.

### Implementations

| Implementation | name | Purpose |
|---------------|------|---------|
| `LocalFs` | `"local"` | Obsidian Vault API (`vault.getAllLoadedFiles()`, `vault.readBinary()`, etc.) |
| `GoogleDriveFs` | `"googledrive"` | Google Drive REST API v3 |
| `MockFs` | `"mock"` | In-memory Map-based (for testing) |

---

## IAuthProvider interface (`fs/auth.ts`)

Authentication provider interface — abstracts OAuth/credential lifecycle separately from FS creation. This separation allows the UI to distinguish "authenticated" (tokens present) from "connected" (authenticated + fully configured, e.g. folder ID set).

```typescript
interface IAuthProvider {
  isAuthenticated(backendData: Record<string, unknown>): boolean;
  startAuth(): Promise<Record<string, unknown>>;
  completeAuth(input: string, backendData: Record<string, unknown>): Promise<Record<string, unknown>>;
}
```

Auth methods receive/return opaque `Record<string, unknown>` scoped to the backend's own data namespace (`settings.backendData[type]`). `disconnect()` is on `IBackendProvider` instead, since it must reset both auth and FS state.

## IBackendProvider interface (`fs/backend.ts`)

Provider interface for backend FS creation and state management. Authentication is delegated to `IAuthProvider` via the `auth` property. Settings UI is **not** part of this interface — it is handled by `IBackendSettingsRenderer` in `ui/backend-settings.ts`.

```typescript
interface IBackendProvider {
  readonly type: string;
  readonly displayName: string;
  readonly auth: IAuthProvider;
  createFs(app: App, settings: SmartSyncSettings, logger?: Logger): IFileSystem | null;
  isConnected(settings: SmartSyncSettings): boolean;
  readBackendState?(fs: IFileSystem): Record<string, unknown>;
  resolveRemoteVault?(app: App, settings: SmartSyncSettings, vaultName: string, cachedRemoteVaultId: string | undefined, logger?: Logger): Promise<RemoteVaultResolution>;
  disconnect(settings: SmartSyncSettings): Promise<Record<string, unknown>>;
}
```

`readBackendState` is optional because not all backends need to persist internal state (e.g., cursors, page tokens). `SyncService` checks existence before calling (`provider?.readBackendState && ...`). The returned opaque record is stored in `settings.backendData[provider.type]` — the sync layer never inspects its contents.

`resolveRemoteVault` is optional. When implemented, `BackendManager` calls it after auth and before `createFs()` to discover or create a remote vault folder. The result provides `remoteVaultId` (persisted in IndexedDB) and `backendUpdates` (merged into `settings.backendData`). Resolution is skipped when the cached ID exists and vault name hasn't changed.

`disconnect()` revokes auth and resets all backend state, returning the reset data to persist.

## IBackendSettingsRenderer interface (`ui/backend-settings.ts`)

Renders backend-specific settings UI (configuration fields + connection flow). Separated from `IBackendProvider` so that `fs/` has no Obsidian UI dependencies.

```typescript
interface IBackendSettingsRenderer {
  readonly backendType: string;  // Must match IBackendProvider.type
  render(containerEl: HTMLElement, settings: SmartSyncSettings, onSave: (updates: Record<string, unknown>) => Promise<void>, actions: BackendConnectionActions): void;
}
```

`BackendConnectionActions` provides `startAuth()`, `completeAuth()`, `disconnect()`, and `refreshDisplay()` — injected by `SmartSyncSettingTab` to bridge UI actions to the plugin's auth lifecycle.

Renderers are registered in `ui/backend-settings.ts` (same pattern as `fs/registry.ts`). `SmartSyncSettingTab` looks up the renderer via `getBackendSettingsRenderer(type)`.

To add a backend: implement `IAuthProvider` + `IBackendProvider` in `fs/<backend>/provider.ts`, implement `IBackendSettingsRenderer` in `ui/<backend>-settings.ts`, and register both in their respective registries.

---

## Sync engine

### 3-state decision table (`sync/engine.ts`)

`buildMixedEntities()` combines local, remote, and last sync states. `computeDecisions()` determines sync actions based on the following table:

| Local | Remote | Last sync | → Decision |
|-------|--------|-----------|-----------|
| Modified | Unchanged | Exists | `local_modified_push` |
| Unchanged | Modified | Exists | `remote_modified_pull` |
| Modified | Modified | Exists | `conflict_both_modified` |
| Exists | Missing | Exists (local unchanged) | `remote_deleted_propagate` |
| Exists | Missing | Exists (local modified) | `conflict_delete_vs_modify` |
| Missing | Exists | Exists (remote unchanged) | `local_deleted_propagate` |
| Missing | Exists | Exists (remote modified) | `conflict_delete_vs_modify` |
| Exists | Missing | None | `local_created_push` |
| Missing | Exists | None | `remote_created_pull` |
| Exists | Exists | None (different content) | `conflict_both_created` |
| Exists | Exists | None (identical hash+size) | `initial_match` |
| Missing | Missing | Exists | `both_deleted_cleanup` |

### Change detection strategy (`sync/engine.ts`)

`hasChanged()` (local) and `hasRemoteChanged()` (remote) determine whether a file has been modified since the last sync. The goal is to minimize false positives (unnecessary syncs) while avoiding false negatives (missed changes).

**Priority chain**:

1. **mtime + size** (fast, no I/O) — if both match the `SyncRecord`, the file is likely unchanged
2. **Content hash** — if mtime/size match but hashes differ, the file was edited without changing size (e.g., replacing characters). If mtime/size differ but hashes match, the file was not actually modified (metadata-only change)
3. **Conservative fallback** — if neither hash nor mtime/size is available, treat as "modified"

```
hasChanged(file, record):
  if mtime+size available:
    if mtime/size differ:
      if hash available → compare hash (catches metadata-only changes)
      else → true (conservative)
    if mtime/size match:
      if hash available → compare hash (catches same-size edits)
      else → false (trust mtime+size)
  if hash available → compare hash
  else → true (conservative)

hasRemoteChanged(file, record):
  if mtime+size available:
    if mtime/size match:
      if hash available → compare hash
      else → false
    if mtime/size differ:
      if contentChecksum available → compare checksum (catches mtime jitter)
      else → true (conservative)
  if contentChecksum available → compare checksum
  if hash available → compare hash
  else → true (conservative)
```

**Why contentChecksum is checked on mtime/size mismatch (remote only)**:

Google Drive's `modifiedTime` can drift between the upload response and subsequent `changes.list` responses. A 1ms difference causes a false positive in mtime comparison. Without the checksum check, this triggers `conflict_delete_vs_modify` instead of `local_deleted_propagate` when a locally deleted file has an unchanged remote with drifted mtime — the `keepNewer` strategy then restores the deleted file.

`hasRemoteChanged()` checks `backendMeta.contentChecksum` (a backend-agnostic key mapped from e.g. Drive's `md5Checksum`, Dropbox's `content_hash`, or S3's `ETag`) before concluding the remote file changed. `hasChanged()` uses content `hash` (SHA-256) for the same purpose on the local side, where mtime is generally reliable but size changes without content changes are possible (e.g., filesystem metadata updates).

**Asymmetry**: `hasChanged()` uses SHA-256 `hash` for the mtime/size mismatch check, while `hasRemoteChanged()` uses `contentChecksum` from `backendMeta`. This is because the SHA-256 hash requires reading file content (expensive for remote), whereas backend checksums (e.g. Drive's md5) are returned by the API at no extra cost. The `hash` fallback in `hasRemoteChanged()` is only reached when mtime is 0 and contentChecksum is unavailable.

### SyncExecutor (`sync/executor.ts`)

Receives a list of `SyncDecision`s and executes the corresponding IFileSystem operations.

- **Push**: `localFs.read()` → `remoteFs.write()` → `write()` returns `FileEntity` (remote metadata) → `localFs.stat()` for fresh local metadata → both saved to `SyncRecord`
- **Pull**: `remoteFs.read()` → `localFs.write()` → `write()` returns `FileEntity` (local metadata) → `remoteFs.stat()` for fresh remote metadata → both saved to `SyncRecord`
- **Delete propagation**: With TOCTOU guard — re-checks via `stat()` before deleting; skips if the other side has changed. After deleting on the remote side (`local_deleted_propagate`), `removeEmptyParents()` walks up the directory tree via `listDir()` and removes empty parent directories
- **Conflicts**: Delegates to `resolveConflict()`. Can invoke UI (ConflictModal) via `onConflict` callback

**3-phase execution**: Decisions are partitioned into three groups and executed in order:

| Phase | Decisions | Execution | Rationale |
|-------|-----------|-----------|-----------|
| A | push, pull, `initial_match`, `both_deleted_cleanup`, `remote_deleted_propagate` | `AsyncPool(3)` — up to 3 concurrent | Path-independent, side effects scoped to own path |
| B | `local_deleted_propagate` | Sequential | `removeEmptyParents()` walks shared parent directories — concurrent deletes in the same tree would race |
| C | `conflict_*` | Sequential | `onConflict` callback may show UI modals |

Each decision operates on a unique path (at most one decision per path per sync), so Phase A tasks never contend on the same file. `SyncResult` counter mutations (`result.pushed++`) are safe because JavaScript is single-threaded — only I/O is concurrent, not computation.

**Per-file errors**: `executeOne()` is wrapped in try/catch. On error, SyncRecord is **not** updated — the file remains in its pre-sync state and will be re-evaluated on the next sync cycle.

**Result tracking**: Counts for `pushed`, `pulled`, `conflicts` + `mergeConflictPaths` (files with inserted markers) + `errors` (failed paths)

### SyncService (`sync/service.ts`)

Orchestrates the entire sync flow.

1. Acquire `syncMutex.run()` for mutual exclusion
2. `buildMixedEntities()` + filter (exclude patterns + mobile include/size checks) + `resolveEmptyHashes()` + `computeDecisions()`
3. If 5+ conflicts with `ask` strategy → show `ConflictSummaryModal`
4. Execute `SyncExecutor.execute()`
5. Save backend state to `settings.backendData[type]` via `readBackendState()`
6. Send result notifications

**Retry**: Max 3 attempts for transport-level errors (network failures, 5xx). Exponential backoff (`2^n * 1000ms`) ± 50% jitter. Immediate abort for:
- 401/403: Auth error
- 400/404: Data error
- 429: Respects `Retry-After` header

Per-file errors (e.g., individual read/write failures) do not trigger retry. They are reported via notification and `partial_error` status.

**Sync deduplication**: If a new sync request arrives during an ongoing sync, it is coalesced into a single run (`pendingSync` flag).

---

## Google Drive backend

### GoogleAuth (`fs/googledrive/auth.ts`)

OAuth 2.0 + PKCE (S256) authentication.

OAuth client ID and secret are embedded as constants (no user configuration needed).

1. `getAuthorizationUrl()` generates a PKCE code challenge and redirects to Google's authorization endpoint via the OAuth relay (`smartsync.takezo.dev`)
2. The relay page redirects to `obsidian://smart-sync-auth?code=...&state=...`, which the plugin receives via `registerObsidianProtocolHandler`. Manual callback URL paste is available as a fallback
3. `exchangeCode()` obtains access/refresh tokens directly from Google's token endpoint
4. `getAccessToken()` retrieves tokens, auto-refreshing 60 seconds before expiry

PKCE `pendingCodeVerifier` and `pendingAuthState` are persisted in `backendData["googledrive"]` (allowing auth flow to survive plugin reloads).

**Why a relay is needed**: Google OAuth requires redirect URIs to use `http://` or `https://` — custom schemes like `obsidian://` are not allowed for Web application OAuth clients. The relay page hosted on GitHub Pages receives the authorization code via HTTPS redirect, then forwards it to `obsidian://smart-sync-auth?code=...&state=...` to hand control back to the plugin.

**Why the relay is safe**: The relay only forwards the authorization code — it cannot obtain tokens with it. PKCE (S256) ensures that the authorization code is useless without the `code_verifier`, which never leaves the user's device. The `state` parameter is verified against a locally stored value before processing, preventing CSRF attacks.

### DriveClient (`fs/googledrive/client.ts`)

Google Drive REST API v3 client. Uses Obsidian's `requestUrl()` to bypass CORS.

| Method | Description |
|--------|-------------|
| `listFiles(folderId, pageToken)` | List files in a folder (with pagination) |
| `listAllFiles(rootFolderId)` | Recursively enumerate all files with AsyncPool(3) concurrency |
| `downloadFile(fileId)` | Download file content |
| `uploadFile(...)` | Multipart upload (small files) |
| `uploadFileResumable(...)` | Delegates to `ResumableUploader` (files > 5 MB) with resume-on-retry |
| `createFolder(name, parentId)` | Create a folder |
| `updateFileMetadata(...)` | Update metadata (PATCH) |
| `deleteFile(fileId, permanent)` | Delete file (trash or permanent) |
| `getChangesStartToken()` | Get initial token for `changes.list` |
| `listChanges(startPageToken)` | Get incremental change list |

### GoogleDriveFs (`fs/googledrive/index.ts`)

`IFileSystem` implementation. Uses Drive's hierarchical folder structure as-is (not flat).

**Caching strategy**:
- `pathToFile: Map<string, DriveFile>` — path → Drive metadata
- `idToPath: Map<string, string>` — ID → path reverse lookup
- `folders: Set<string>` — set of folder paths
- `children: Map<string, Set<string>>` — parent path → direct child paths (O(k) child lookups for rename/delete/listDir)
- First `list()` call tries to load from IndexedDB (`MetadataStore<DriveFile>`); falls back to full scan via `listAllFiles()` if no cache or `rootFolderId` changed
- After full scan, the cache is persisted to IndexedDB for faster reload
- Subsequent calls use `changes.list` API for incremental updates (also persisted incrementally)
- Falls back to full scan on HTTP 410 (expired token)

**Mutex-protected cache**:
- `cacheMutex` protects cache reads and writes
- Network I/O (downloads/uploads) executes outside the mutex (prevents deadlocks)
- TOCTOU guard: `read()` resolves ID → releases lock → downloads → re-acquires lock for consistency check

### GoogleDriveProvider (`fs/googledrive/provider.ts`)

`IBackendProvider` implementation. Handles FS creation and state management. Authentication is delegated to `GoogleDriveAuthProvider` via composition (`this.auth`). Settings UI is handled separately by `GoogleDriveSettingsRenderer` in `ui/googledrive-settings.ts`.

- `createFs()`: Calls `this.auth.getOrCreateGoogleAuth(data)` to obtain a `GoogleAuth` instance, then creates `DriveClient` → `GoogleDriveFs`
- `readBackendState()`: Read `changesStartPageToken` + refreshed tokens from `GoogleDriveFs` and return as opaque record
- `resolveRemoteVault()`: Discover or create the remote vault folder in Google Drive (`obsidian-smart-sync/{uuid}/`)
- `disconnect()`: Revoke auth tokens and return reset backend data

All Google Drive-specific data is stored in `settings.backendData["googledrive"]` as `GoogleDriveBackendData` (defined in `provider.ts`). The sync layer never accesses these fields directly.

### GoogleDriveSettingsRenderer (`ui/googledrive-settings.ts`)

`IBackendSettingsRenderer` implementation. Renders Google Drive-specific settings: connection status indicator and auth code flow. The remote vault folder is automatically managed — no manual folder ID input required.

Connection state is derived from `settings.backendData["googledrive"]` (`!!refreshToken`) — no dependency on the provider instance. When connected, the remote vault folder ID is shown as read-only.

### GoogleDriveAuthProvider (`fs/googledrive/provider.ts`)

`IAuthProvider` implementation. Owns the `GoogleAuth` instance and manages the entire OAuth lifecycle.

- `startAuth()`: Generate auth URL → open in browser → return PKCE state for persistence
- `completeAuth()`: Accept URL or code → exchange tokens directly with Google → return token updates
- `isAuthenticated()`: Returns `true` when `refreshToken` is present (even without folder ID)
- `getOrCreateGoogleAuth()`: Returns the existing `GoogleAuth` instance, or creates a new one if the stored `refreshToken` has changed. Called by `GoogleDriveProvider.createFs()` to obtain the auth instance for `DriveClient`
- `revokeAuth()`: Revoke token via Google's revoke endpoint (best-effort). Called by `GoogleDriveProvider.disconnect()`. If revocation fails, local tokens are still cleared to ensure the user can always disconnect

Note: `disconnect()` is on `GoogleDriveProvider` (not on `GoogleDriveAuthProvider`), since it must reset both auth tokens and FS state (e.g., `changesStartPageToken`).

---

## Conflict resolution

### resolveConflict() (`sync/conflict.ts`)

Supports 6 strategies:

| Strategy | Behavior |
|----------|----------|
| `keep_local` | Overwrite remote with local content |
| `keep_remote` | Overwrite local with remote content |
| `keep_newer` | Keep the version with the newer mtime. Falls back to `duplicate` if same mtime but different hash |
| `duplicate` | Save remote as `<basename>.conflict.<ext>`. Appends a number if a `.conflict` file already exists |
| `three_way_merge` | Run `isMergeEligible()` → `threeWayMerge()`. For `.json`/`.canvas` files: validates merged output with `JSON.parse()` — falls back to `duplicate` if invalid JSON or if conflict markers are present. For other text files: falls back to `duplicate` on failure |
| `ask` | Show `ConflictModal` via `SyncExecutor`'s `onConflict` callback |

### Delete-vs-modify conflict handling

When one side deletes a file while the other modifies it (`conflict_delete_vs_modify`), each strategy handles the missing side as follows:

| Strategy | Behavior |
|----------|----------|
| `keep_local` / `keep_remote` | The `local` and `remote` parameters are optional (`FileEntity \| undefined`). If the chosen side is the deleted one (i.e., `undefined`), the file is deleted from the other side. If the chosen side exists, it overwrites the other side |
| `keep_newer` | When one side is `undefined` (deleted), the non-deleted side always wins — no mtime comparison is needed since the deleted side has no timestamp |
| `duplicate` | The non-deleted side's content is written to the deleted side, restoring the file. No `.conflict` copy is created (there is only one version of the content) |
| `three_way_merge` | Detects the missing side (`!local \|\| !remote`) and falls back to `keep_newer`, which then preserves the non-deleted side as described above |
| `ask` | Delegates to the user via `ConflictModal`. If no callback is provided, falls back to `keep_newer` |

### threeWayMerge() (`sync/merge.ts`)

Uses `node-diff3` (BSD license).

- **Eligibility** (`isMergeEligible`): Text extensions (`.md`, `.txt`, `.json`, `.canvas`, `.css`, `.js`, `.ts`, etc.) and ≤ 1 MB
- **Input**: base (last sync), local, and remote content
- **Output**: `MergeResult { content: string; conflict: boolean }`
- **Conflict markers**: `<<<<<<< LOCAL / ======= / >>>>>>> REMOTE`

---

## Sync state persistence

### SyncStateStore (`sync/state.ts`)

IndexedDB-based. Database name is `smart-sync-{vaultId}` (independent per vault).

**Object stores**:
1. `sync-records` — `SyncRecord` persistence (keyPath: `path`)
2. `sync-content` — File content storage for 3-way merge (keyPath: `path`). Only stores content for files passing `isMergeEligible()` — i.e., text extensions (`.md`, `.txt`, `.json`, `.canvas`, etc.) and ≤ 1 MB in size

**Methods**: `open()`, `close()`, `get(path)`, `getAll()`, `put(record)`, `delete(path)`, `clear()`, `putContent(path, content)`, `getContent(path)`

Both `SyncStateStore` and `MetadataStore<T>` delegate IndexedDB lifecycle (open/close idempotency, `onversionchange` recovery, transaction wrapping) to `IDBHelper` (`store/idb-helper.ts`) via composition. Each store passes its schema-specific `onUpgrade` callback and uses `helper.runTransaction()` for all reads and writes. `MetadataStore<T>` is backend-agnostic — Google Drive instantiates it as `MetadataStore<DriveFile>`, and future backends (Dropbox, S3, etc.) can reuse the same store with their own file metadata type.

DB version 3. The v2→v3 upgrade (`size` → `localSize`/`remoteSize` in `SyncRecord`) is a breaking schema change — `onupgradeneeded` drops and recreates all object stores, clearing existing sync state.

---

## Remote vault (`sync/remote-vault.ts`)

Each Obsidian vault maps to a dedicated folder in the backend storage, organized under a common root: `obsidian-smart-sync/{remoteVaultId}/`. The `remoteVaultId` is a UUID assigned on first connection and never changes.

### RemoteVaultStore

IndexedDB store (`smart-sync-rv-{vaultId}`) that persists `remoteVaultId` and `lastKnownVaultName`. Used by `BackendManager` to cache the link between a local vault and its remote folder, avoiding redundant resolution on every startup.

### Resolution flow (BackendManager.initBackend)

1. If `resolveRemoteVault` is not implemented by the provider, skip (backwards compatible)
2. Load `cachedRemoteVaultId` and `lastKnownVaultName` from `RemoteVaultStore`
3. If cached ID exists and vault name hasn't changed → skip (no network call)
4. Otherwise call `provider.resolveRemoteVault()` → persist `backendUpdates` in settings and save `remoteVaultId` + `vaultName` in IndexedDB

### Metadata

Each remote vault contains `.smartsync/metadata.json` with `{ vaultName }`. This is used by new devices to find a matching remote vault by `app.vault.getName()`. Already-linked devices use the cached `remoteVaultId` and only update `metadata.json` when the local vault name changes.

### Google Drive implementation (`fs/googledrive/remote-vault.ts`)

`resolveGDriveRemoteVault()` handles Drive-specific resolution:

- **Cached path** (linked device): Find `obsidian-smart-sync/{cachedId}` folder → verify it exists → update `metadata.json` if vault name changed
- **Uncached path** (new device): List all folders under `obsidian-smart-sync/` → read each `metadata.json` → match by `vaultName` → link if found, otherwise create new UUID folder with `.smartsync/metadata.json`

Uses `DriveClient.findChildByName()` for efficient single-folder lookups instead of full recursive scans.

---

## Mutual exclusion

### AsyncMutex (`queue/async-queue.ts`)

Lightweight promise-based mutex. Replaces error-prone boolean flag exclusion with a safe queue-based approach.

```typescript
class AsyncMutex {
  async run<T>(fn: () => Promise<T>): Promise<T>;  // Hold lock during fn execution
  get isLocked(): boolean;
}
```

**Usage**:
- `SyncService.syncMutex` — Prevents concurrent syncs
- `GoogleDriveFs.cacheMutex` — Protects Drive metadata cache

**Note**: Non-reentrant. Calling `run()` inside `run()` will deadlock.

### AsyncPool (`queue/async-queue.ts`)

Bounded concurrency pool. Allows up to N tasks to run simultaneously; additional tasks wait for a slot.

```typescript
class AsyncPool {
  constructor(concurrency: number);
  async run<T>(fn: () => Promise<T>): Promise<T>;
}
```

**Usage**:
- `SyncExecutor.execute()` — Runs parallel-safe decisions (push/pull) with concurrency 3

---

## UI components

### SmartSyncSettingTab (`ui/settings.ts`)

Settings tab displaying:
1. Backend selector (dropdown when multiple providers are registered)
2. Auto-sync interval
3. Conflict strategy
4. 3-way merge toggle
5. Exclude patterns (textarea, one pattern per line)
6. Mobile sync settings (include patterns + max file size)
7. Backend-specific settings (delegated to `IBackendSettingsRenderer` via renderer registry)

### ConflictModal (`ui/conflict-modal.ts`)

Individual conflict resolution modal. `waitForResolution()` returns `Promise<ConflictStrategy>`.

Displays:
- Conflict description text
- Local/remote file info (size, last modified)
- 4 choices: keep_local / keep_remote / duplicate / three_way_merge

### ConflictSummaryModal (`ui/conflict-summary-modal.ts`)

Bulk resolution modal shown when **both** conditions are met: (1) 5 or more conflicts are detected, and (2) `conflictStrategy` setting is `"ask"`. When `conflictStrategy` is not `"ask"` (e.g., `"keep_newer"`, `"three_way_merge"`), conflicts are resolved automatically without any modal. When `enableThreeWayMerge` is `true` and `prevSync` exists, the executor overrides the strategy to `"three_way_merge"` for `"keep_newer"` and `"ask"` strategies only. The strategies `"keep_local"`, `"keep_remote"`, and `"duplicate"` are **never** overridden — users who explicitly choose these strategies always get the behavior they selected.

Displays:
- Conflict file count and list (first 10)
- 3 choices: keep_all_local / keep_all_remote / resolve_individually

---

## Auto-sync, event-driven & foreground sync

### Auto-sync timer

Uses `this.registerInterval()` to run `runSync()` every N minutes. Interval is configurable (default 5 min, 0 to disable).

### Event-driven sync

Monitors vault events (`create`, `modify`, `delete`, `rename`). Triggers sync with a 5-second trailing-edge debounce — waits until 5 seconds of inactivity after the last change before firing.

```typescript
const debouncedSync = debounce(() => void this.runSync(), 5000, false);
this.registerEvent(this.app.vault.on("create", onVaultChange));
this.registerEvent(this.app.vault.on("modify", onVaultChange));
this.registerEvent(this.app.vault.on("delete", onVaultChange));
this.registerEvent(this.app.vault.on("rename", onVaultChange));
```

### Network reconnect sync

Listens for `window "online"` events. When the browser/app comes back online, triggers a sync if connected and not already syncing. Listener is cleaned up via `this.register()` on unload.

### Foreground resume sync

Listens for `document "visibilitychange"` events. When the app returns to foreground (`document.visibilityState === "visible"`), triggers a debounced sync via `shouldSync()` guard. Especially important on mobile where the app is frequently backgrounded and may miss vault changes or remote updates while suspended. Listener is cleaned up via `this.register()` on unload.

### Status bar

Displays real-time sync status via `this.addStatusBarItem()`:

| SyncStatus | Display |
|------------|---------|
| `idle` | Synced |
| `syncing` | Syncing... |
| `error` | Sync error |
| `partial_error` | Synced (with errors) |
| `not_connected` | Not connected |

Shows progress text during sync (e.g., "Syncing 3/15...").

---

## Error handling & retry

`SyncService` handles errors centrally:

| HTTP Status | Response |
|-------------|----------|
| 401 | Auth error → abort immediately, show reconnect Notice |
| 403 (non-rate-limit) | Auth error → abort immediately, show reconnect Notice |
| 403 (rate limit) | `isRateLimitError()` checks the response JSON for `reason ∈ {rateLimitExceeded, userRateLimitExceeded, dailyLimitExceeded}` → treated like 429, retries with backoff |
| 400 / 404 | Data error → abort immediately |
| 429 | Rate limit → wait per `Retry-After` header (supports both delay-seconds and HTTP-date formats) |
| Other | Exponential backoff (`2^n * 1000ms` ± 50% jitter), max 3 retries |

---

## Exclude patterns

Glob matching via `matchGlob()`. Pattern syntax:

| Pattern | Meaning |
|---------|---------|
| `*` | Any characters except slash |
| `?` | Any single character except slash |
| `**` | Any depth of path |
| `**/` | Prefix chain |

`excludePatterns` defaults to an empty array. Users add patterns (e.g., `*.zip`, `large-assets/**`) via the settings UI. Dot-prefixed files and directories (`.obsidian/`, `.trash/`, etc.) are already excluded by Obsidian's Vault API — `getAllLoadedFiles()` does not index them, so they never appear in `LocalFs.list()` and do not need exclude patterns.

Compiled regexes are cached in `globCache` to avoid recompilation.

### Mobile sync filtering

On mobile devices (`Platform.isMobile`), two additional filters restrict which files are synced:

1. **Include patterns** (`mobileIncludePatterns`): Only files matching at least one pattern are synced. Default: `["**/*.md", "**/*.canvas"]`. Checked in `isExcluded()` — files not matching any include pattern are excluded. Note: with the default settings, images, PDFs, and other attachments are **not** synced on mobile. This is a deliberate trade-off for bandwidth and storage savings. Users who need attachments on mobile should add the relevant patterns (e.g., `**/*.png`, `**/*.pdf`).
2. **Max file size** (`mobileMaxFileSizeMB`): Files exceeding this size (default: 10 MB) are skipped. Checked in `executeSyncOnce()` using `Math.max(e.local?.size ?? 0, e.remote?.size ?? 0)` — when one side is missing (e.g., `local_created_push`), the missing side defaults to 0.

These filters are applied **after** `excludePatterns` — a file excluded by `excludePatterns` is always excluded regardless of mobile include patterns. Both settings are configurable from the settings UI on any device (desktop or mobile).

`SyncServiceDeps.isMobile` is injected as `() => Platform.isMobile` for testability.

---

## Design details & rationale

### SyncExecutor execution model

`SyncExecutor` partitions decisions into 3 phases: parallel-safe (push/pull/cleanup), serial deletes (`local_deleted_propagate`), and serial conflicts. Phase A uses `AsyncPool(3)` for bounded concurrency — conservative enough to avoid Drive API rate limits while improving throughput for multi-file syncs. Phases B and C remain sequential: B because `removeEmptyParents()` races on shared directory trees, C because conflict resolution may show UI modals.

### Empty hash handling

When `hash` is empty (e.g., backend doesn't compute hashes, or first encounter), the engine conservatively treats the file as "modified". This is intentional — false positives (unnecessary sync) are preferred over false negatives (missed changes).

### Sync deduplication

`SyncService.runSync()` uses a `do-while` loop with a `syncPending` flag. If a new sync request arrives during an ongoing sync, `syncPending` is set to `true`, and after the current sync completes, it re-runs. This ensures changes made during sync are captured without spawning concurrent syncs.

### TOCTOU guards

Delete propagation in `SyncExecutor` re-checks via `stat()` before deleting. If the file has been re-created or modified on the other side since the decision was computed, the delete is skipped. In `GoogleDriveFs`, the `read()` method resolves file ID under mutex, releases the lock for network I/O, then re-acquires the lock and validates the ID still exists in cache — throwing `FileNotFoundError` if it was deleted during download.

### Vault ID generation

`vaultId` is generated via `crypto.randomUUID()` on first plugin load and persisted in settings. It serves as the IndexedDB database namespace (`smart-sync-{vaultId}`), ensuring each vault has independent sync state.

### Rename handling

Vault `rename` events trigger a debounced sync like any other change. The sync engine sees the result as "old path deleted + new path created" and generates two separate decisions (`local_deleted_propagate` + `local_created_push`). `IFileSystem.rename()` exists for direct filesystem operations but is **not used by SyncExecutor** — this simplifies the decision table and avoids edge cases with cross-directory renames. Trade-off: renamed files are re-uploaded rather than using Drive's `updateFileMetadata` for a lightweight rename. For vaults with frequent renames, this adds network overhead but maintains implementation simplicity.

### Large file handling

`IFileSystem.read()` / `write()` operate on `ArrayBuffer` (no streaming). Files exceeding available memory will cause issues. Mitigation: use exclude patterns (e.g., `*.zip`, `*.pdf`) to skip large binary files. Files > 5 MB use resumable upload on Drive.

### Upload resume-on-retry

`DriveClient` caches the resumable upload session URL in a `Map<cacheKey, { uploadUrl, totalSize, createdAt }>` when a PUT fails midway. On the next `SyncService` retry (which re-runs the full sync cycle), `uploadFileResumable()` finds the cached URL, queries Google for how many bytes were received (`Content-Range: bytes */{total}` → 308 with `Range` header), and sends only the remaining bytes. Cache entries expire after 6 hours (Google allows up to 7 days). If the status query fails or returns an unparseable response, the cache entry is discarded and a fresh upload begins (graceful degradation).

Cache key: `existingFileId` when updating an existing file, or `${parentId}/${name}` for new files.

### Download resume — not feasible

Resumable download cannot be implemented due to two Obsidian API limitations:

1. **`requestUrl()` does not expose partial data on failure** — the `ArrayBuffer` is only available on success. When a download fails midway, there is no way to know how many bytes were received, so a `Range` request cannot be constructed for the remainder
2. **`DataAdapter` has no binary append API** — `writeBinary()` overwrites the entire file and `append()` is text-only. Even if chunked downloads via `Range` headers were used (each chunk as an independent successful request), there is no way to incrementally write binary chunks to disk. Chunks must be accumulated in memory, which defeats the purpose of resumable download since a failure loses all accumulated data

`FileSystemAdapter` (desktop-only) adds `getBasePath()` but no low-level file I/O (no `fs.open`/`fs.write` with offset). Using Node.js `fs` directly would break mobile compatibility (`isDesktopOnly: false`).

### Initial sync flow

When no `SyncRecord` exists for a file:
- Present on both sides with identical hash+size → `initial_match` (seeds a `SyncRecord` without file I/O, so that subsequent deletions on either side are correctly detected as `remote_deleted_propagate` or `local_deleted_propagate`)
- Present on both sides with different content → `conflict_both_created`
- Present only locally → `local_created_push`
- Present only remotely → `remote_created_pull`

**Hash resolution for initial sync**: `list()` returns empty hashes (computing hashes for every file during listing would be expensive). When both sides exist with no `prevSync`, `SyncService.resolveEmptyHashes()` reads content and computes SHA-256 for entities where sizes match (different sizes are obviously different content). This runs in `executeSyncOnce()` before `computeDecisions()`, keeping `engine.ts` as pure logic with no I/O.

---

## Testing

### Configuration

**vitest** with `vitest.config.ts`. Uses `fake-indexeddb/auto` for IndexedDB simulation. Obsidian API is mocked via `src/__mocks__/obsidian.ts`.

### Test helpers (`src/__mocks__/sync-test-helpers.ts`)

- `createMockFs(name)` — creates an in-memory `MockFs` instance
- `addFile(fs, path, content, mtime)` — adds a file and returns its `FileEntity`
- `readText(fs, path)` — reads file content as UTF-8 string
- `createMockStateStore()` — creates a mock `SyncStateStore` with in-memory maps

### Test files

- `src/fs/mock/mock-fs.test.ts` — All MockFs methods
- `src/fs/local/local-fs.test.ts` — LocalFs behavior
- `src/fs/googledrive/index.test.ts` — GoogleDriveFs behavior
- `src/fs/googledrive/auth.test.ts` — GoogleAuth OAuth + PKCE
- `src/fs/googledrive/client.test.ts` — DriveClient API calls
- `src/fs/googledrive/types.test.ts` — Drive type validators
- `src/store/idb-helper.test.ts` — IDBHelper lifecycle & transactions
- `src/store/metadata-store.test.ts` — MetadataStore CRUD
- `src/queue/async-queue.test.ts` — AsyncMutex exclusion, AsyncPool concurrency
- `src/sync/engine.test.ts` — computeDecisions decision table tests
- `src/sync/engine-build.test.ts` — buildMixedEntities integration tests
- `src/sync/conflict.test.ts` — All conflict resolution strategy patterns
- `src/sync/executor.test.ts` — SyncExecutor operations, parallel execution phases
- `src/sync/merge.test.ts` — 3-way merge (clean merge, conflicts, eligibility)
- `src/sync/service.test.ts` — SyncService orchestration
- `src/sync/state.test.ts` — IndexedDB store CRUD
- `src/logging/logger.test.ts` — Logger behavior
- `src/utils/path.test.ts` — Path utilities

---

## Risks & mitigations

1. **Mobile OAuth**: Redirect handling may differ from desktop. Mitigated by manual callback URL paste. `isDesktopOnly: false` but mobile requires additional validation
2. **Drive API rate limits**: Initial full scan on large vaults may hit limits. Subsequent syncs use `changes.list` for incremental updates only. 403 rate-limit errors (Google returns `reason: rateLimitExceeded` instead of 429 in some cases) are detected and retried with backoff
3. **Mass conflicts after extended offline**: Shows `ConflictSummaryModal` for 5+ conflicts with bulk resolution options
4. **TOCTOU races**: Delete propagation re-checks via `stat()`. Skips if the other side has changed
5. **Network reconnect + auto-sync overlap**: When the browser comes back online just before an auto-sync timer fires, two sequential syncs may run. The `syncMutex` prevents concurrent execution, and `syncPending` deduplicates requests during an active sync. However, if the first sync completes before the second trigger fires, both execute independently. Impact is minimal — the second sync uses `changes.list` incremental fetch with no new changes
6. **OAuth client secret exposure**: The Google OAuth client secret (Web application type) is embedded in the plugin source code. Google considers Web app secrets confidential (unlike Desktop app secrets). Practical risk is low — redirect URIs are locked in GCP, PKCE prevents auth code interception, and refresh tokens are stored only on the user's device. Additionally, `exchangeCode()` verifies the `state` parameter against `pendingAuthState` before processing, preventing forged callbacks from a compromised relay or CSRF attacks. However, Google could theoretically disable the client if they detect the secret is public. Mitigation options: (a) accept the risk (common in OSS — e.g. VS Code's GitHub integration), (b) add a thin serverless backend (Cloudflare Worker / Cloud Functions) for token exchange only, or (c) revert to Desktop app type and rely on manual callback URL paste
7. **Initial sync performance on large vaults**: `resolveEmptyHashes()` reads content and computes SHA-256 for all file pairs where both sides exist, no `prevSync` record exists, and sizes match. For a vault with N same-size pairs, this performs 2N file reads + 2N SHA-256 computations. Entities are processed **sequentially** (outer `for...of` loop); within each entity, the local and remote reads are parallelized via `Promise.all()` (max 2 concurrent reads). Size-mismatched pairs are skipped entirely (no I/O needed). This runs only on initial sync — after the first successful sync, `prevSync` records exist for all files and the function becomes a no-op. Future optimization: `GoogleDriveFs` already stores the Drive MD5 as `contentChecksum` in `backendMeta` during `list()`, which could be compared against a locally computed MD5 to skip remote downloads. The `contentChecksum` key is backend-agnostic (each backend maps its native checksum: Drive's `md5Checksum`, Dropbox's `content_hash`, S3's `ETag`)

