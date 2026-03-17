# Sync Pipeline

## Pipeline overview

Each sync cycle runs a 4-phase pipeline:

1. **Collect** -- `collectChanges()` gathers `MixedEntity[]` using the appropriate temperature mode
2. **Decide** -- `planSync()` maps each `MixedEntity` to a `SyncAction` and runs `checkSafety()`
3. **Execute** -- `executePlan()` runs I/O in grouped batches (A/B/C/D)
4. **Commit** -- `commitAction()` persists each successful action's `SyncRecord` to IndexedDB

The orchestrator (`SyncOrchestrator.executeSyncOnce()`) drives this pipeline, applying ignore-pattern filtering and mobile size limits between Collect and Decide.

## Temperature modes

The change detector selects a temperature based on the state of `LocalChangeTracker` and `SyncStateStore`:

### Hot -- O(delta)

Selected when `localTracker.isInitialized()` returns true and `getDirtyPaths()` is non-empty.

- Takes the union of local dirty paths and remote changed paths (from `getChangedPaths()`)
- Calls `stat()` on each path for both local and remote filesystems
- Calls `stateStore.getMany()` for the affected paths only
- Filters results through `hasChanged()` / `hasRemoteChanged()` to prune no-ops
- Most efficient mode during steady-state operation

### Warm -- O(n) local + O(delta) remote

Selected when sync records exist but the tracker is not initialized (e.g. after plugin reload without local changes).

- Calls `localFs.list()` for a full local listing
- Calls `getChangedPaths()` for the remote delta
- Compares the full local listing against all stored `SyncRecord`s to find local changes and deletions
- Calls `remoteFs.stat()` only for paths identified as changed

### Cold -- O(n)

Selected when `stateStore.getAll()` returns an empty array (first sync or after state clear).

- Calls both `localFs.list()` and `remoteFs.list()`
- Full outer join on path to build `MixedEntity[]` for every file on either side
- No filtering -- all paths are candidates

## Hash enrichment

After any temperature mode collects entries, `collectChanges()` runs `enrichHashesForInitialMatch()` on entries where both sides exist but no baseline (`prevSync`) is present. This handles cold starts, partial initial syncs, and simultaneous file creation.

`list()` returns `hash: ""` for performance. Without enrichment, the decision engine cannot distinguish identical files from conflicts (both hashes are falsy). The enrichment step:

1. Filters to entries where `local.size === remote.size` and `remote.backendMeta.contentChecksum` is available
2. Reads local file content and computes MD5 (via `js-md5`)
3. Compares with Drive's `contentChecksum` (MD5 from the files.list API response)
4. If match: sets a sentinel hash (`md5:<hex>`) on both entities so the decision engine returns `match`
5. If mismatch: leaves hashes empty → decision engine returns `conflict`

Uses `AsyncPool(10)` for parallel local reads. Per-file errors are caught and skipped (file stays unenriched → treated as conflict, safe side).

## Change detection

### Local changes

`LocalChangeTracker` (`local-tracker.ts`) tracks dirty paths in memory via a `Set<string>`. Vault events (`create`, `modify`, `delete`, `rename`) call `markDirty(path)`. After a successful sync cycle, `acknowledge(paths)` clears the set and sets `initialized = true`.

### Remote changes

`IFileSystem.getChangedPaths()` returns `{ modified: string[]; deleted: string[] }` or `null`. For Google Drive, this calls the changes.list API via `applyIncrementalChanges()`, which updates the metadata cache and returns the set of affected paths. Returns `null` when a full scan is triggered (token expired or first run).

### Comparison functions

`hasChanged(file, record)` -- local file vs baseline:

1. mtime + size comparison (fast, no I/O)
2. If mtime/size differ, verify via hash before concluding changed
3. If mtime/size match, verify hash if both available (catches same-size edits)
4. Fall back to hash-only comparison
5. Conservative: treat as changed if undeterminable

`hasRemoteChanged(file, record)` -- remote file vs baseline:

1. mtime + size comparison
2. If mtime/size differ, check `backendMeta.contentChecksum` (e.g. Drive md5Checksum)
3. Fall back to hash comparison
4. Conservative: treat as changed if undeterminable

## Decision table

`decideAction()` in `decision-engine.ts` maps each `MixedEntity` to a `SyncActionType`:

| prevSync | local | remote | localChanged | remoteChanged | Action |
|----------|-------|--------|--------------|---------------|--------|
| yes | exists | exists | yes | yes | `conflict` |
| yes | exists | exists | yes | no | `push` |
| yes | exists | exists | no | yes | `pull` |
| yes | exists | exists | no | no | (skip) |
| yes | exists | missing | yes | -- | `conflict` |
| yes | exists | missing | no | -- | `delete_local` |
| yes | missing | exists | -- | yes | `conflict` |
| yes | missing | exists | -- | no | `delete_remote` |
| yes | missing | missing | -- | -- | `cleanup` |
| no | exists | missing | -- | -- | `push` |
| no | missing | exists | -- | -- | `pull` |
| no | exists | exists | same hash+size | same hash+size | `match` |
| no | exists | exists | (otherwise) | (otherwise) | `conflict` |

## Safety check

`checkSafety()` in `safety-check.ts` evaluates the plan before execution:

- **Abort** (`shouldAbort: true`): deletion ratio is 100% (all meaningful actions are deletions)
- **Confirm** (`requiresConfirmation: true`): deletion ratio > 50% AND deletion count > 10
- **Proceed**: all other cases

`match` and `cleanup` actions are excluded from the ratio denominator (they are state-only).

## Execution groups

`executePlan()` in `plan-executor.ts` partitions actions into 4 groups executed in order:

| Group | Actions | Execution | Rationale |
|-------|---------|-----------|-----------|
| A | `push`, `pull`, `match`, `cleanup` | Parallel via `AsyncPool(5)` | Independent file I/O, safe to parallelize |
| B | `delete_remote` | Serial | Avoids race conditions with remote API |
| C | `delete_local` | Serial | Avoids local filesystem conflicts |
| D | `conflict` | Serial | May show UI modal (`ask` strategy) |

Each action calls `executeAction()` which runs `runActionIO()` followed by `commitAction()`. `AuthError` is re-thrown to abort the entire sync; all other errors are caught per-action and recorded in `result.failed`.

## State commit

`commitAction()` in `state-committer.ts` persists state per successfully-executed action:

- `push` / `pull` / `match` / `conflict`: upsert `SyncRecord` via `stateStore.put()`. If `enableThreeWayMerge` is on and the file is merge-eligible (text, <=1 MB), stores the file content via `stateStore.putContent()` for future 3-way merge base.
- `delete_local` / `delete_remote` / `cleanup`: delete `SyncRecord` via `stateStore.delete()`.

Failed actions are not committed; they will be re-detected on the next sync cycle.

## Sync triggers

`SyncScheduler` (`scheduler.ts`) registers five sync triggers on `start()`:

| Trigger | Event | Behaviour |
|---------|-------|-----------|
| Vault change | `create` / `modify` / `delete` / `rename` | Marks path dirty via `localTracker.markDirty()`, then calls `debouncedSync()` (5 s debounce). Consecutive edits reset the timer so sync fires 5 s after the last change. |
| Visibility | `document.visibilitychange` → `"visible"` | Calls `debouncedSync()` when the app returns to the foreground, unless a sync is already running. |
| Online | `window.online` | Immediately calls `runSync()` when the network connection is restored. |
| Auto sync | `setInterval` | Periodic sync at the user-configured interval (`autoSyncIntervalMinutes`). Skipped if a sync is already running. |
| File open | `workspace.on("file-open")` | Priority pull for the opened file (see below). |

All triggers except file-open run a full sync cycle through the pipeline. Ignored paths (from `ignorePatterns`) are excluded at the vault-event level — dirty marks and debounce are skipped entirely.

## Active file priority sync

`SyncScheduler.wireFileOpenEvent()` hooks the `file-open` workspace event. When a user opens a file:

1. Skip if a sync is already running
2. Look up the file's `SyncRecord`
3. Call `stat()` on both local and remote
4. If remote has changed (`hasRemoteChanged`) but local has NOT changed (`hasChanged`), call `orchestrator.pullSingle(path)` to immediately pull the latest version
5. This gives the user the freshest content without waiting for the next scheduled sync
