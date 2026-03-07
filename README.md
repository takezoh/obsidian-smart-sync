# Smart Sync

A community plugin for bidirectional sync between your Obsidian vault and cloud storage.

Detects file creation, modification, deletion, and renames on both local and remote sides, then safely synchronizes changes. For concurrent text edits, automatic 3-way merge is also available.

Currently supports Google Drive as a storage backend.

> **Requires a Google account.** This plugin communicates with Google Drive API (`googleapis.com`) for file sync and with an auth server (`auth-smartsync.takezo.dev`) for OAuth token exchange. No vault data is sent to the auth server — it only handles authentication tokens.

## Features

- **Bidirectional sync**: Push local changes to remote, pull remote changes to local
- **Auto-sync**: Runs at a configurable interval (default 5 min). Also triggers automatically on vault file changes
- **Conflict detection**: Accurately detects local and remote changes, even when both sides are edited
- **Conflict resolution**: 6 strategies — keep_newer / keep_local / keep_remote / duplicate / 3-way merge / ask (manual)
- **3-way merge**: For concurrent edits on text files (Markdown, etc.), automatically merges changes
- **Exclude patterns**: Specify files/folders to exclude via glob patterns (e.g. `*.zip`, `large-assets/**`)
- **Status bar**: Real-time sync status display (Synced / Syncing... / Sync error / Not connected)
- **Ribbon icon**: One-click manual sync

## Backend setup

See backend-specific setup instructions:

- **Google Drive**: [docs/google-drive-setup.md](docs/google-drive-setup.md)

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Backend | Storage backend for sync | Google Drive |
| Auto-sync interval | Sync interval in minutes (0 to disable) | 5 |
| Conflict strategy | Resolution strategy for conflicts | keep_newer |
| Enable 3-way merge | Enable 3-way merge for text files | On |
| Dot-prefixed paths to sync | Dot-prefixed folders to include in sync (e.g. `.templates`) | (none) |
| Ignore patterns | Glob patterns to exclude (one per line) | Desktop: (none), Mobile: `.md`/`.canvas`/`.base` only |
| Mobile max file size | Skip files larger than this on mobile | 10 MB |

### Conflict resolution strategies

| Strategy | Behavior |
|----------|----------|
| `keep_newer` | Keeps the version with the more recent timestamp |
| `keep_local` | Always keeps local changes |
| `keep_remote` | Always keeps remote changes |
| `duplicate` | Saves the remote version as a `.conflict` file, keeps local as-is |
| `three_way_merge` | Attempts 3-way merge (text files only, up to 1 MB). Falls back on failure |
| `ask` | Shows a modal for each conflict. Displays a summary modal for 5+ conflicts |

### Syncing the config directory

To sync Obsidian's config directory (`.obsidian/`), add it to **Dot-prefixed paths to sync** and use **Ignore patterns** to select what to include.

> **⚠️ Warning**: The config directory contains Obsidian's internal metadata. Syncing it across devices may cause settings loss, layout corruption, or plugin malfunction.

Example — sync only JSON config files and plugins:

```
.obsidian/**
!.obsidian/*.json
.obsidian/workspace.json
.obsidian/workspace-mobile.json
!.obsidian/plugins/
!.obsidian/plugins/**
.obsidian/plugins/*/data.json
```

## Commands

| Command | Description |
|---------|-------------|
| `Smart Sync: Sync now` | Run sync manually |

## Disclaimer

This plugin is provided "as is", without warranty of any kind. The authors are not responsible for any loss or corruption of data, or any other damages arising from the use of this plugin. **Use at your own risk.** It is strongly recommended that you back up your vault before using this plugin.

## License

MIT
