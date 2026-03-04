# Smart Sync — Obsidian Plugin

An Obsidian community plugin for bidirectional sync between vaults and cloud storage.

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Development (watch)
npm run build      # Production build (tsc -noEmit && esbuild)
npm test           # vitest
npm run test:watch # vitest watch
npm run lint       # eslint ./src/
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for details.

```
src/
├── main.ts              # Entry point (lifecycle only, delegates logic)
├── settings.ts          # SmartSyncSettings type & defaults
├── fs/
│   ├── types.ts         # FileEntity, SyncRecord, MixedEntity, SyncDecision, DecisionType, ConflictStrategy
│   ├── interface.ts     # IFileSystem (name, list, stat, read, write, mkdir, delete, rename)
│   ├── backend.ts       # IBackendProvider
│   ├── registry.ts      # Backend registry
│   ├── local/           # LocalFs — Obsidian Vault API wrapper
│   ├── googledrive/     # GoogleDriveFs — Drive REST API v3 + OAuth PKCE
│   └── mock/            # MockFs — in-memory for testing
├── sync/
│   ├── engine.ts        # buildMixedEntities() + computeDecisions() — 3-state decision
│   ├── executor.ts      # SyncExecutor — Decision → IFileSystem operations
│   ├── service.ts       # SyncService — orchestration, retry, mutual exclusion
│   ├── state.ts         # SyncStateStore — IndexedDB
│   ├── conflict.ts      # resolveConflict() — 6 strategies
│   └── merge.ts         # threeWayMerge() — node-diff3
├── queue/async-queue.ts # AsyncMutex
├── utils/               # sha256(), matchGlob()
├── ui/                  # SettingTab, ConflictModal, ConflictSummaryModal
└── __mocks__/           # obsidian.ts, sync-test-helpers.ts
```

Dependency direction: `main.ts` → `SyncService` → `engine/executor` → `IFileSystem`. The sync engine is backend-agnostic.

## Coding conventions

- TypeScript strict mode
- `main.ts` handles lifecycle only; delegate logic to separate modules
- Split files at ~200-300 lines
- Register listeners via `this.register*` (prevent leaks)
- Prefer `async/await`
- Mobile compatible (`isDesktopOnly: false`) — no Node/Electron APIs
- Minimize network calls; require explicit disclosure
- Command IDs are immutable once published

## Build artifacts

`main.js`, `manifest.json`, `styles.css` → placed in vault's `.obsidian/plugins/obsidian-smart-sync/`. Never commit `node_modules/` or `main.js`.

## Releases

Update `version` in `manifest.json` (SemVer, no `v` prefix) and `versions.json`. GitHub release tag must match the version exactly.
