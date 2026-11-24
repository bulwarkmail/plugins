# Papra

Attach documents from [Papra](https://papra.app/) to the message you are writing, and save attachments and whole messages to Papra.

## What it does

- **From Papra** in the composer's Attach menu opens a list of your documents, newest first, with their tags in their colours. Type to search names and text with Papra's own search, switch organization when you are in more than one, open a document in Papra, tick documents and click Attach: they go into the message you are writing. A file over 25 MB is not downloaded; the dialog says which one.
- **Save to Papra** in an attachment's menu, and **Save message to Papra** in the message toolbar (the whole message as an `.eml` file). With one organization the file goes straight there; with several, a dialog asks which one, starting with the one picked last.
- **Settings > Papra**: connect or disconnect, and pick the organization to start with when there are several. The choice follows the account to other browsers where Bulwark syncs plugin settings.

## Setting it up

Each user connects their own Papra account in Settings > Papra (or the first time they use the plugin). The API key is typed into Bulwark's own "Connect" dialog and kept on the webmail server; the plugin never sees it. In Papra, an API key is made in the account settings under API keys.

The administrator can enter the server URL in the plugin's admin settings so users don't have to type it. Papra can sit under a path (`https://example.com/papra`) when the administrator enters that URL; a server a user types must serve Papra at the root of its address.

A Papra server on a private address (a LAN IP, a `.lan` or Docker host name) must be listed in the webmail's `PLUGIN_PROXY_PRIVATE_ORIGINS`, or the webmail refuses to connect to it.

### API key permissions

| Papra permission | Why |
| --- | --- |
| `organizations:read` | Checking the key when connecting, and the list of organizations. |
| `documents:read` | Listing, searching and attaching documents. |
| `documents:create` | Save to Papra. |

Tags come with the documents, so `tags:read` is not needed. The plugin never changes or deletes anything in Papra.

## Permissions

| Permission | Why |
| --- | --- |
| `http:proxy` | Every call to Papra goes through the webmail's server proxy, which adds the API key. |
| `admin:config` | Reads the server URL the administrator set. |
| `email:read` | The Save to Papra entries on attachments and in the message toolbar, and the subject for the `.eml` file name. |
| `email:blob-read` | The bytes of the attachment or of the whole message to upload. |
| `email:blob-write` | Uploads a document to the mail server to attach it. |
| `ui:composer-toolbar` | From Papra in the composer's Attach menu. |
| `ui:toolbar` | Save message to Papra in the message toolbar. |
| `ui:settings-section` | Connecting, disconnecting and the organization in Settings. |

Credential: `personal` (user), sent as `Authorization: Bearer <key>`.

## Privacy

Nothing goes to Papra without a user action. Saving sends the one attachment, or the whole message, to the organization picked. Browsing sends the search text to the user's own Papra server. The plugin stores the organization picked last.
