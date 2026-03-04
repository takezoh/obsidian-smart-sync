# Google Drive Backend

Setup instructions and technical details for the Smart Sync Google Drive backend.

## Prerequisites

### 1. GCP Project

1. Create a new project in the [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Google Drive API** under **APIs & Services → Library**
3. Configure the **OAuth consent screen** under **APIs & Services → OAuth consent screen**
4. Create an **OAuth 2.0 Client ID** under **APIs & Services → Credentials**

### 2. Token Exchange Server

A token exchange endpoint is required to keep the OAuth client secret on the server side.

- Deploy on Cloud Functions, Cloud Run, etc.
- The plugin exchanges the authorization code for tokens via this endpoint
- Ensures the client secret is never exposed on the client side

## Connection Steps

1. Open the plugin settings (**Settings → Smart Sync**)
2. Enter the OAuth client ID created in GCP under **OAuth client ID**
3. Enter the deployed token exchange endpoint URL under **Token exchange URL**
4. Click the **Connect to Google Drive** button
5. Complete the Google account authorization in the browser
6. Copy the callback URL and paste it into the plugin
7. Enter the sync target folder ID under **Drive folder ID**

### How to Get the Drive Folder ID

Open the folder in Google Drive and copy the ID portion at the end of the URL:

```
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                       This part is the folder ID
```

## Backend-Specific Settings

| Setting | Description |
|---------|-------------|
| Drive folder ID | Google Drive folder ID for the sync target |
| OAuth client ID | GCP OAuth 2.0 client ID |
| Token exchange URL | URL of the token exchange server |

## Technical Details

### OAuth 2.0 + PKCE

The authentication flow uses OAuth 2.0 Authorization Code Grant + PKCE (S256).

1. The plugin generates a PKCE code challenge and redirects to Google's authorization endpoint
2. After the user completes authorization, the callback URL is pasted into the plugin
3. Access and refresh tokens are obtained via the token exchange server
4. Access tokens are automatically refreshed 60 seconds before expiry

The PKCE `pendingCodeVerifier` and `pendingAuthState` are persisted in settings, allowing the auth flow to continue even if the plugin is reloaded mid-flow.

### Drive API Usage

- **HTTP client**: Uses Obsidian's `requestUrl()` (bypasses CORS, no external HTTP library needed)
- **Folder structure**: Uses Drive's native folder hierarchy as-is (not flat). This provides better browsability on the Drive side
- **Upload**: Multipart upload for files ≤ 5 MB, resumable upload for files > 5 MB
- **Incremental fetch**: Uses the `changes.list` API for incremental change detection. Only the initial sync requires a full scan; subsequent syncs use a persisted `startPageToken` to fetch only changes

### Caching Strategy

`GoogleDriveFs` maintains the following caches:

- `pathToFile: Map<string, DriveFile>` — path → Drive metadata
- `idToPath: Map<string, string>` — ID → path reverse lookup
- `folders: Set<string>` — set of folder paths

Caches are protected by `AsyncMutex`. Network I/O (downloads/uploads) executes outside the mutex to prevent deadlocks. Falls back to a full scan on HTTP 410 (expired token).

### Mobile Support

The plugin is configured with `isDesktopOnly: false`, but the OAuth redirect flow may behave differently on mobile. This is handled via manual callback URL paste.
