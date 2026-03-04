# Google Drive Setup

## Connection steps

1. Open the plugin settings (**Settings → Smart Sync**)
2. Enter the sync target folder ID under **Drive folder ID**
3. Click the **Connect to Google Drive** button
4. Complete the Google account authorization in the browser
5. The plugin automatically receives the callback via `obsidian://smart-sync-auth` protocol handler

If the automatic callback fails, copy the redirect URL from the browser and paste it into the **Authorization code** field in settings.

### How to get the Drive folder ID

Open the folder in Google Drive and copy the ID portion at the end of the URL:

```
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                       This part is the folder ID
```

## Backend-specific settings

| Setting | Description |
|---------|-------------|
| Drive folder ID | Google Drive folder ID for the sync target |

## Initial sync

The first sync after connecting performs a full scan of the Drive folder. This may take some time depending on vault size. Subsequent syncs fetch only changes and are much faster.

## Mobile support

The `obsidian://` protocol handler works on both desktop and mobile. If it fails on mobile, the manual callback URL paste fallback is available in settings.

### Troubleshooting on mobile

- **Authentication completes but sync doesn't start**: Restart the plugin (disable → enable in Community plugins settings), then try syncing manually
- **Token error after successful authorization**: Check that the device has a stable network connection — token exchange requires connectivity immediately after authorization
- **Protocol handler not triggered**: Use the manual fallback — copy the full redirect URL from the browser and paste it into the **Authorization code** field in settings
