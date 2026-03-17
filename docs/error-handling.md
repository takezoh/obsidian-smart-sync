# Error Handling

## Error classification

`getErrorInfo()` (`sync/error.ts`) extracts structured information from errors:

```typescript
interface ErrorInfo {
  status: number | null;     // HTTP status code
  retryAfter: number | null; // Retry-After header value in seconds
}
```

It handles both Fetch API `Headers` objects and plain `Record<string, string>` headers. The `Retry-After` header is parsed as either a number of seconds or an HTTP-date (RFC 7231).

`isRateLimitError()` checks whether a 403 error is actually a Google Drive rate limit by inspecting `error.json.error.errors[].reason` for:
- `rateLimitExceeded`
- `userRateLimitExceeded`
- `dailyLimitExceeded`

This distinction is important because 403 rate limits should be retried, while 403 permission errors should not.

## Retry strategy

`SyncOrchestrator.runSync()` wraps `executeSyncOnce()` in a retry loop:

- **Maximum retries**: 3 (`MAX_RETRIES`)
- **Backoff**: exponential with jitter -- `2^(attempt-1) * 1000 * (0.5 + random())` ms
- **Rate limit override**: if status is 429 or 403 (rate limit) and `Retry-After` is present, use `retryAfter * 1000` ms instead of computed backoff

### Non-retryable errors

| Error | Behavior |
|-------|----------|
| `AuthError` | Immediate abort, status set to `"error"`, notification to reconnect |
| 403 (non-rate-limit) | Immediate abort, permission denied notification |
| 404 | Break retry loop (but don't abort with special handling) |

## Rate limiting

Google Drive rate limits manifest as:

| Status | Condition | Detection |
|--------|-----------|-----------|
| 429 | Too Many Requests | `getErrorInfo().status === 429` |
| 403 | Rate limit exceeded | `isRateLimitError()` checks `error.json` for rate limit reasons |

Both are retried with the `Retry-After` header value when available, falling back to exponential backoff.

## Recovery scenarios

| Scenario | Recovery |
|----------|----------|
| Network drop | Retry up to 3x with backoff. If all retries fail, set status to `"error"`. On network restore (`online` event), `SyncScheduler` triggers a new sync. |
| Crash mid-sync | `SyncRecord` is only committed after successful I/O (`commitAction` runs post-`runActionIO`). Uncommitted actions are re-detected by the next sync cycle. |
| IndexedDB eviction | `GoogleDriveFs` falls back to cold path (full scan). `SyncStateStore` returns empty `getAll()`, triggering cold change detection which does a full outer join. `resolveEmptyHashes` is implicit: cold mode treats all paths as candidates. |
| Auth error | `AuthError` causes immediate abort. `GoogleAuthBase` sets `authFailed = true`; subsequent API calls throw without attempting refresh. User must reconnect in settings. |
| Individual file error | Caught per-action in `executeAction()`. The failed action is recorded in `result.failed`; other actions continue. Status set to `"partial_error"`. |
| Mass deletion | `checkSafety()` evaluates the plan before execution. 100% deletion ratio aborts silently. >50% ratio with >10 deletions requires user confirmation (if `onConfirmation` callback is provided). |
| Stale cache (Drive) | `withCacheMutex()` verifies the file ID hasn't changed during I/O. If stale, the cache update is skipped with a warning. |

## Per-file error isolation

In `plan-executor.ts`, each action is wrapped in a try/catch:

```typescript
try {
  const { localEntity, remoteEntity } = await runActionIO(action, ctx);
  await commitAction(action, localEntity, remoteEntity, ctx.committer);
  result.succeeded.push({ action, localEntity, remoteEntity });
} catch (err) {
  if (err instanceof AuthError) throw err;  // re-throw to abort entire sync
  result.failed.push({ action, error });     // isolate, continue with other actions
}
```

`AuthError` is the only error type that aborts the entire sync. All other errors (network, file not found, permission on individual file) are isolated to that action.

## Acknowledge pattern

`LocalChangeTracker.acknowledge(paths)` is called only after a successful sync cycle completes:

```typescript
// In orchestrator.runSync():
const allPaths = this.deps.localTracker.getDirtyPaths();
this.deps.localTracker.acknowledge(allPaths);
```

If a sync fails, dirty paths remain in the tracker and will be included in the next sync attempt. The `pullSingle()` method also calls `acknowledge([path])` after completion (success or failure) to prevent re-triggering the file-open priority sync for the same path.

`acknowledge()` also sets `initialized = true`, which transitions the tracker from warm to hot mode for subsequent sync cycles.
