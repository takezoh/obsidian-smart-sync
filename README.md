# Smart Sync

A community plugin for bidirectional sync between your Obsidian vault and cloud storage.

Detects file creation, modification, deletion, and renames on both local and remote sides, then safely synchronizes changes. For concurrent text edits, automatic 3-way merge is also available.

Currently supports Google Drive as a storage backend.

## Features

- **Bidirectional sync**: Push local changes to remote, pull remote changes to local
- **Auto-sync**: Runs at a configurable interval (default 5 min). Also triggers automatically on vault file changes
- **Conflict detection**: Accurately detects local and remote changes, even when both sides are edited
- **Conflict resolution**: 6 strategies — keep_newer / keep_local / keep_remote / duplicate / 3-way merge / ask (manual)
- **3-way merge**: For concurrent edits on text files (Markdown, etc.), automatically merges changes
- **Exclude patterns**: Specify files/folders to exclude via glob patterns (`.obsidian/**` and `.trash/**` excluded by default)
- **Status bar**: Real-time sync status display (Synced / Syncing... / Sync error / Not connected)
- **Ribbon icon**: One-click manual sync

## Backend setup

See backend-specific setup instructions:

- **Google Drive**: [docs/google-drive.md](docs/google-drive.md)

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Backend | Storage backend for sync | Google Drive |
| Auto-sync interval | Sync interval in minutes (0 to disable) | 5 |
| Conflict strategy | Resolution strategy for conflicts | keep_newer |
| Enable 3-way merge | Enable 3-way merge for text files | Off |
| Exclude patterns | Glob patterns to exclude (one per line) | `.trash/**` (`.obsidian/**` auto-added) |

### Conflict resolution strategies

| Strategy | Behavior |
|----------|----------|
| `keep_newer` | Keeps the version with the more recent timestamp |
| `keep_local` | Always keeps local changes |
| `keep_remote` | Always keeps remote changes |
| `duplicate` | Saves the remote version as a `.conflict` file, keeps local as-is |
| `three_way_merge` | Attempts 3-way merge (text files only, up to 1 MB). Falls back on failure |
| `ask` | Shows a modal for each conflict. Displays a summary modal for 5+ conflicts |

## Commands

| Command | Description |
|---------|-------------|
| `Smart Sync: Sync now` | Run sync manually |

## Disclaimer

This plugin is provided "as is", without warranty of any kind. The authors are not responsible for any loss or corruption of data, or any other damages arising from the use of this plugin. **Use at your own risk.** It is strongly recommended that you back up your vault before using this plugin.

## License

MIT
