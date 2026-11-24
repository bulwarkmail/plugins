# Immich

Attach photos and videos from your [Immich](https://immich.app/) library to the message you are writing, and save photos and videos you receive to Immich.

## What it does

- **From Immich** in the composer's Attach menu opens a picker with your newest photos and videos. Type to search (Immich's smart search, or the file name when the server runs without machine learning), or pick one of your own or shared albums. Tick photos and videos and click Attach: they go into the message you are writing. A file over 25 MB is not downloaded; the dialog says which one.
- **Save to Immich** in an attachment's menu uploads a photo or video to your library. Immich dates it by the date in the file; a file without one gets the message's date. When Immich already has the file, the message says so. Other files (PDFs and so on) are refused with a message.

## Setting it up

Each user connects their own Immich account in Settings > Immich (or the first time they use the plugin). The API key is typed into Bulwark's own "Connect" dialog and kept on the webmail server; the plugin never sees it. In Immich, an API key is made under Account Settings > API Keys.

The administrator can enter the server URL in the plugin's admin settings so users don't have to type it. Immich can sit under a path (`https://example.com/immich`) when the administrator enters that URL; a server a user types must serve Immich at the root of its address.

An Immich server on a private address (a LAN IP, a `.lan` or Docker host name) must be listed in the webmail's `PLUGIN_PROXY_PRIVATE_ORIGINS`, or the webmail refuses to connect to it.

### API key permissions

An API key with all permissions works. A key limited to what the plugin uses needs:

| Immich permission | Why |
| --- | --- |
| `user.read` | Checking the key when connecting, and showing who is connected. |
| `album.read` | The album list in the picker. |
| `asset.read` | Listing and searching photos. |
| `asset.view` | Thumbnails in the picker. |
| `asset.download` | Attaching a photo (its original file). |
| `asset.upload` | Save to Immich. |

The plugin never changes or deletes anything in Immich. Tested against the API of Immich 1.132, 2.x and 3.x.

## Permissions

| Permission | Why |
| --- | --- |
| `http:proxy` | Every call to Immich goes through the webmail's server proxy, which adds the API key. |
| `admin:config` | Reads the server URL the administrator set. |
| `email:read` | The Save to Immich entry in an attachment's menu, and the message's date. |
| `email:blob-read` | The bytes of the attachment to upload. |
| `email:blob-write` | Uploads a photo to the mail server to attach it. |
| `ui:composer-toolbar` | From Immich in the composer's Attach menu. |
| `ui:settings-section` | Connecting and disconnecting in Settings. |

Credential: `personal` (user), sent as the `X-API-Key` header.

## Privacy

Nothing goes to Immich without a user action. Saving sends the one attachment, with its name and the message's date. Browsing sends the search text and the album picked to the user's own Immich server. The plugin stores nothing in the browser.
