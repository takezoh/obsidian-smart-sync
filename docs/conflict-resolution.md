# Conflict Resolution

## v2 simplified strategies

The v2 pipeline (`conflict-resolver.ts`) exposes 3 user-facing strategies via `SimplifiedConflictStrategy`:

| Strategy | Behavior |
|----------|----------|
| `auto_merge` | Try 3-way merge, fall back to `keep_newer`, then `duplicate` |
| `duplicate` | Save remote as `.conflict` file, keep local at original path |
| `ask` | Show a modal for the user to choose `keep_local` / `keep_remote` / `duplicate` |

The setting is stored as `conflictStrategy` in `SmartSyncSettings`. Legacy values are migrated on load by `migrateConflictStrategy()` in `migrate.ts`:

| Legacy value | Migrated to |
|-------------|-------------|
| `keep_newer` | `auto_merge` |
| `three_way_merge` | `auto_merge` |
| `keep_local` | `ask` |
| `keep_remote` | `ask` |

## auto_merge fallback chain

`resolveAutoMerge()` implements a cascading resolution:

```
auto_merge
  ├── local + remote + baseline all present?
  │     ├── yes → attempt 3-way merge (via conflict.ts "auto_merge" with "keep_newer" fallback)
  │     │           ├── merge-eligible (text, <=1 MB) + base content in store?
  │     │           │     ├── success (no conflicts) → write merged to both sides → "merged"
  │     │           │     ├── has conflicts (markers) → write merged to both sides → "merged" (hasConflictMarkers: true)
  │     │           │     └── JSON/Canvas with conflicts → duplicate
  │     │           └── not eligible / no base → keep_newer fallback
  │     └── no  → keep_newer
  └── keep_newer
        ├── one side deleted → other side wins
        ├── both exist, mtime comparable → newer wins (overwrites older side)
        ├── same mtime + same hash → keep local (content identical)
        └── same mtime or unknown mtime, different content → duplicate
```

## 3-way merge

Implemented in `merge.ts` using the `node-diff3` library.

**Eligibility** (`isMergeEligible()`):
- File size <= 1 MB (`MAX_MERGE_SIZE`)
- Extension in `TEXT_EXTENSIONS`: `.md`, `.txt`, `.json`, `.canvas`, `.css`, `.js`, `.ts`, `.html`, `.xml`, `.yaml`, `.yml`, `.csv`, `.svg`, `.tex`, `.bib`, `.org`, `.rst`, `.adoc`, `.toml`, `.ini`, `.cfg`, `.conf`, `.log`, `.sh`, `.bash`, `.zsh`, `.fish`, `.py`, `.rb`, `.lua`, `.sql`, `.graphql`, `.env`, `.gitignore`

**Merge process** (`threeWayMerge()`):
1. Normalize CRLF to LF in all three inputs
2. Run `mergeDiff3(local, base, remote)` with `\n` separator
3. If either input used CRLF, convert output back to CRLF
4. Return `{ success, content, hasConflicts }`

Conflict markers use labels `LOCAL`, `BASE`, `REMOTE`:
```
<<<<<<< LOCAL
local change
||||||| BASE
original text
=======
remote change
>>>>>>> REMOTE
```

**JSON/Canvas guard**: if the file extension is `.json` or `.canvas` and the merge has conflicts (or the result is invalid JSON), the resolver falls back to `duplicate` instead of writing broken JSON.

**Rollback**: if writing the merged content to remote fails, the local file is restored to its pre-merge state.

## Conflict file naming

`generateConflictPath()` in `conflict.ts` creates duplicate paths:

- `notes/file.md` -> `notes/file.conflict.md`
- If that exists: `notes/file.conflict-2.md`, `notes/file.conflict-3.md`, ..., up to 100
- Beyond 100: timestamp-based suffix
- Checks all involved filesystems to avoid overwrites on either side

## Legacy strategies

The following strategies are retained in `conflict.ts` for internal use by `resolveConflict()`:

| Strategy | Behavior |
|----------|----------|
| `keep_newer` | Compare mtime; newer side overwrites the other |
| `keep_local` | Push local to remote (or delete remote if local deleted) |
| `keep_remote` | Pull remote to local (or delete local if remote deleted) |
| `three_way_merge` | Same as `auto_merge` in `conflict.ts` (tries merge, falls back) |
| `duplicate` | Save remote copy with `.conflict` suffix, keep local |

These are never exposed in the settings UI. They are used internally as building blocks by `resolveConflictV2()`.

## Conflict history

`ConflictHistory` (`conflict-history.ts`) writes an audit log of all conflict resolutions to `.smartsync/conflicts/{device}.json`.

```typescript
interface ConflictRecord {
  path: string;
  actionType: SyncActionType;
  strategy: ConflictStrategy;
  action: "kept_local" | "kept_remote" | "duplicated" | "merged";
  local?: FileEntity;
  remote?: FileEntity;
  duplicatePath?: string;
  hasConflictMarkers?: boolean;
  resolvedAt: string;   // ISO timestamp
  sessionId: string;
}
```

- Maximum 500 records per device file (`MAX_RECORDS`); older entries are trimmed on append
- Directory structure `.smartsync/conflicts/` is created on demand
- The device name is pre-sanitized (same as logging)
