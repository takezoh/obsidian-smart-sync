# Smart Sync

Sync your Obsidian vault bidirectionally with cloud storage, resolving conflicts and concurrent edits automatically via 3-way merge.

Currently supports Google Drive as a storage backend.

> **Requires a Google account.** This plugin communicates with Google Drive API (`googleapis.com`) for file sync and with an auth server (`auth-smartsync.takezo.dev`) for OAuth token exchange. No vault data is sent to the auth server — it only handles authentication tokens. Custom OAuth allows you to own the authorization, configure broader access scopes, and exchange tokens directly with Google.

## Features

- **Bidirectional sync**: Push local changes to remote, pull remote changes to local
- **Auto-sync**: Triggers on vault file changes (5 s debounce), app foreground, network restore, and configurable interval
- **Incremental sync**: After the initial full scan, only changed files are synced (hot/warm detection)
- **Conflict detection**: 3-state comparison (local / remote / last sync record) accurately detects changes even when both sides are edited
- **Conflict resolution**: 3 strategies — auto merge (3-way merge → keep newer fallback) / duplicate / ask
- **3-way merge**: For concurrent edits on text files, automatically merges changes using the last-synced content as a base
- **Active file priority sync**: When opening a file, immediately pulls the latest version if remote has changed
- **Exclude patterns**: Specify files/folders to exclude via glob patterns (e.g. `*.zip`, `large-assets/**`)
- **Status bar**: Real-time sync status display (synced / syncing / error / not connected)
- **Ribbon icon**: One-click manual sync

## Google Drive setup

1. Open the plugin settings (**Settings → Smart Sync**)
2. Click the **Connect to Google Drive** button
3. Complete the Google account authorization in the browser
4. The plugin automatically receives the callback via `obsidian://` protocol handler
5. A remote vault folder is created automatically in your Google Drive

If the automatic callback fails, try disconnecting and reconnecting from the plugin settings.

The first sync after connecting performs a full scan of the Drive folder. This may take some time depending on vault size. Subsequent syncs use incremental change detection and are much faster.

### Custom OAuth (advanced)

The built-in OAuth uses the `drive.file` scope, which only allows access to files created by the plugin. With custom OAuth, you own the authorization and can grant broader access — for example, the `drive` scope allows the plugin to access files created outside the plugin as well.

1. Create an OAuth 2.0 client in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Enable the Google Drive API
3. Set the authorized redirect URI (default: `https://smartsync.takezo.dev/callback`)
4. In plugin settings, select **Google Drive (custom OAuth)** as the backend
5. Enter your client ID and client secret
6. Configure the scope as needed (default: `drive.file`, set to `https://www.googleapis.com/auth/drive` for full access)
7. Click **Connect to Google Drive**

The default redirect page (`https://smartsync.takezo.dev/callback`) is a [single static HTML file](https://github.com/takezoh/smart-sync-auth/blob/main/docs/callback/index.html) that only relays the authorization code back to the plugin. The code is protected by PKCE — it cannot be used without the verifier held only by the plugin. You can also host your own redirect page and configure its URL in the settings.

### Troubleshooting

- **Authentication completes but sync doesn't start**: Restart the plugin (disable → enable in Community plugins settings), then try syncing manually
- **Token error after successful authorization**: Check that the device has a stable network connection — token exchange requires connectivity immediately after authorization
- **Protocol handler not triggered**: Try disconnecting and reconnecting from the plugin settings

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Backend | Storage backend for sync | Google Drive (or Google Drive custom OAuth) |
| Auto-sync interval | Periodic sync interval in minutes (0 to disable). Vault changes, app foreground, and network restore also trigger sync independently. | 5 |
| Conflict strategy | Resolution strategy for conflicts (see below) | Auto merge |
| Dot-prefixed paths to sync | Dot-prefixed folders to include in sync (e.g. `.templates`) | (none) |
| Ignore patterns | Glob patterns to exclude (one per line) | Desktop: (none), Mobile: `.md`/`.canvas`/`.base` only |
| Mobile max file size | Skip files larger than this on mobile | 10 MB |
| Enable logging | Write sync logs to `.smartsync/` in your vault | Off |
| Log level | Minimum log level (debug / info / warn / error) | info |

### Conflict resolution strategies

| Strategy | Behavior |
|----------|----------|
| Auto merge (recommended) | Attempts 3-way merge for text files using the last-synced content as the base. If merge is not possible (binary file, no base content, or merge failure), falls back to keep newer (by mtime). If mtime is equal or unknown, creates a duplicate. |
| Duplicate | Always saves the remote version as a `.conflict` file and keeps the local version at the original path. |
| Ask | Shows a modal for each conflict, letting you choose keep local, keep remote, or duplicate. |

### Syncing the config directory

If you want to try syncing Obsidian's config directory (`.obsidian/`), add it to **Dot-prefixed paths to sync** and use **Ignore patterns** to select what to include.

> **Warning**: The config directory contains Obsidian's internal metadata. Syncing it across devices may cause settings loss, layout corruption, or plugin malfunction.

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
