# Smart Sync

A community plugin for bidirectional sync between your Obsidian vault and cloud storage.

Detects file creation, modification, deletion, and renames on both local and remote sides, then safely synchronizes changes. For concurrent text edits, automatic 3-way merge is also available.

Currently supports Google Drive as a storage backend.

> **Requires a Google account.** This plugin communicates with Google Drive API (`googleapis.com`) for file sync and with an auth server (`auth-smartsync.takezo.dev`) for OAuth token exchange. No vault data is sent to the auth server — it only handles authentication tokens. Custom OAuth allows you to authenticate with your own client ID and scope, and exchange tokens directly with Google.

## Features

- **Bidirectional sync**: Push local changes to remote, pull remote changes to local
- **Auto-sync**: Runs at a configurable interval (default 5 min). Also triggers automatically on vault file changes
- **Conflict detection**: Accurately detects local and remote changes, even when both sides are edited
- **Conflict resolution**: 6 strategies — keep_newer / keep_local / keep_remote / duplicate / 3-way merge / ask (manual)
- **3-way merge**: For concurrent edits on text files (Markdown, etc.), automatically merges changes
- **Exclude patterns**: Specify files/folders to exclude via glob patterns (e.g. `*.zip`, `large-assets/**`)
- **Status bar**: Real-time sync status display (Synced / Syncing... / Sync error / Not connected)
- **Ribbon icon**: One-click manual sync

## Google Drive setup

1. Open the plugin settings (**Settings → Smart Sync**)
2. Click the **Connect to Google Drive** button
3. Complete the Google account authorization in the browser
4. The plugin automatically receives the callback via `obsidian://` protocol handler
5. A remote vault folder is created automatically in your Google Drive

If the automatic callback fails, try disconnecting and reconnecting from the plugin settings.

The first sync after connecting performs a full scan of the Drive folder. This may take some time depending on vault size. Subsequent syncs fetch only changes and are much faster.

### Custom OAuth (advanced)

With custom OAuth, you authenticate using your own Google Cloud OAuth client ID and scope.

1. Create an OAuth 2.0 client in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Enable the Google Drive API
3. Set the authorized redirect URI (default: `https://smartsync.takezo.dev/callback`)
4. In plugin settings, select **Google Drive (custom OAuth)** as the backend
5. Enter your client ID and client secret
6. Click **Connect to Google Drive**

The default redirect page (`https://smartsync.takezo.dev/callback`) is a [single static HTML file](https://github.com/takezoh/smart-sync-auth/blob/main/docs/callback/index.html) that only relays the authorization code back to the plugin. The code is protected by PKCE — it cannot be used without the verifier held only by the plugin. You can also host your own redirect page and configure its URL in the settings.

### Troubleshooting

- **Authentication completes but sync doesn't start**: Restart the plugin (disable → enable in Community plugins settings), then try syncing manually
- **Token error after successful authorization**: Check that the device has a stable network connection — token exchange requires connectivity immediately after authorization
- **Protocol handler not triggered**: Try disconnecting and reconnecting from the plugin settings

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Backend | Storage backend for sync | Google Drive (or Google Drive custom OAuth) |
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

If you want to try syncing Obsidian's config directory (`.obsidian/`), add it to **Dot-prefixed paths to sync** and use **Ignore patterns** to select what to include.

> **⚠️ Warning**: The config directory contains Obsidian's internal metadata. Syncing it across devices may cause settings loss, layout corruption, or plugin malfunction.

Example:

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
