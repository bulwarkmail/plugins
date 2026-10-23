# Paperless-ngx

Send attachments and whole messages from Bulwark to [Paperless-ngx](https://docs.paperless-ngx.com/), find your documents there and attach them to new mail.

![Send to Paperless](screenshots/send-dialog-light.png)

## What it does

- **Send to Paperless** on an attachment (its menu), on the open message (reader toolbar) and on several selected messages (selection toolbar). A dialog lists what will be sent: the attachments, and the message itself as `.eml`. Attachments Paperless can read are ticked; the message is ticked only when it has no such attachment.
- **Suggestions from the sender.** The dialog fills in correspondent, document type, tags and storage path: first what you chose for this sender last time ("Use these for … next time"), else a correspondent whose name, match pattern or domain fits the sender, and a document type and tags named in the subject or file name (also "Rechnung", "facture", "Stromrechnung" for Invoice and so on).
- **Already in Paperless.** Each file's SHA-256 (Paperless 3) and MD5 (older versions) are compared with the documents in Paperless. A file that is there already is flagged with its title and left unticked; "Open in Paperless" in the dialog opens the copy that is there.
- **Follows the import.** After the upload the plugin watches the consume task and tells you when the document is filed or why it failed, for example a duplicate or a file type Paperless can't read. The notice has an "Open in Paperless" link to the new document (to the copy already there for a duplicate). When Paperless doesn't name the document, or the plugin stops waiting, the link opens the Paperless document list filtered by the title. Open tasks survive a reload; it gives up after 15 minutes.
- **Documents page** in the navigation: search title and text, filter by tags, correspondent, document type and date, see a preview and the text, open a document in Paperless, download the original, or attach one or several documents to a new message. The same browser opens from Settings > Paperless-ngx > Browse documents.
- **Rules for new mail** (Settings > Paperless-ngx): "mail from billing@acme.com (or acme.com) with 'Invoice' in the subject → send the attachments (or the whole message) with these tags, correspondent, type and storage path". A rule is off until you switch it on and only runs on mail that arrives after that, never on mail already in the mailbox. Each message is handled once.

![Documents](screenshots/documents-light.png)

## Setting it up

The administrator picks one of three ways in the plugin's admin settings:

| Admin settings | What users do |
| --- | --- |
| Server URL and shared API token | Nothing. Everyone uses that one Paperless account. |
| Server URL only | Each user connects their own API token; the server is filled in. |
| Nothing | Each user enters their Paperless address and token. |

Users connect in Settings > Paperless-ngx (or when they first press Send to Paperless). The token is typed into Bulwark's own "Connect" dialog and kept on the webmail server; the plugin never sees it. A Paperless API token is in Paperless under the user's profile ("Auth token").

Paperless can sit under a path (`https://example.com/paperless`) when the administrator enters that URL; a user-entered server must serve Paperless at the root of its address.

### Paperless permissions

The Paperless user behind the token needs these permissions (Users & Groups > Permissions). The plugin never changes or deletes anything in Paperless.

| Paperless permission | Why |
| --- | --- |
| UI Settings: View | Connecting and showing who is connected (`/api/ui_settings/`). |
| Documents: View | Search, "Already in Paperless", thumbnails, previews and downloads. |
| Documents: Add | Send to Paperless. Tags, correspondent, type and storage path are sent with the upload, so Change is not needed. |
| Tags, Correspondents, Document Types: View | Filters and the choices in the send dialog. |
| Storage Paths: View | Optional; without it the dialog has no storage path choice. |
| Tasks: View | Following the import after an upload (filed, failed, duplicate). |

The user sees only the documents, tags and so on that they own or that are shared with them. A shared token makes every webmail user see what that one Paperless account sees, so it should not be a superuser's.

![Settings](screenshots/settings-light.png)

Screenshots in dark mode: [settings](screenshots/settings-dark.png), [documents](screenshots/documents-dark.png), [document](screenshots/document-details-dark.png), [send dialog](screenshots/send-dialog-dark.png).

### Uploads and reverse proxies

The webmail's plugin proxy forwards uploads as a stream (`Transfer-Encoding: chunked`, no `Content-Length`). Paperless (Django) reads such a request as empty and answers "No file was submitted", which the plugin shows as "Paperless refused the request: document: No file was submitted.". Behind nginx with its default request buffering, uploads work. Paperless served directly, or behind a proxy that streams request bodies (Traefik, Caddy), needs the webmail to send `Content-Length`; until then, searching, previews, downloads and "Already in Paperless" work but sending does not.

## Permissions

| Permission | Why |
| --- | --- |
| `http:proxy` | Every call to Paperless goes through the webmail's server proxy, which adds the token. |
| `admin:config` | Reads the server URL the administrator set (non-secret fields only; the shared token stays on the server). |
| `email:read` | The attachment, reader and selection buttons, and new-mail events for rules. |
| `email:blob-read` | The bytes of an attachment or of the whole message, to upload them and to compare checksums. |
| `email:blob-write` | Uploads a Paperless document to the mail server to attach it to a new message. |
| `compose:open` | Opens the composer with the attached documents. |
| `ui:message-list`, `ui:toolbar` | The buttons in the selection toolbar and the reader toolbar. |
| `ui:app-page` | The documents page in the navigation. |
| `ui:settings-section` | Connection and rules in Settings. |
| `ui:notifications` | "Filed in Paperless" and failures; without permission for system notifications they show in the app. |
| `ui:download-file` | Downloads a document's original file. |

Credentials: `shared` (admin; secret `apiToken`, origin from `serverUrl`) and `personal` (user). Both send `Authorization: Token <token>`.

## Privacy

Nothing goes to Paperless without a user action, except mail matched by a rule the user switched on. What goes there: the files the user picked (or the rule names), the title and the metadata picked in the dialog. Checksums of the files in the dialog are sent to look for duplicates. The plugin stores in its own storage: open import tasks, links to filed documents for the notification, the last choice per sender address (if "Use these … next time" is ticked), the rules and the ids of messages a rule handled.

## Settings

- **Notify when Paperless has filed a document** (on): off shows a short message in the app instead.

## Product decisions

- Attachments are preselected over the message, because most people file the invoice PDF, not the mail, and Paperless only reads `.eml` with Tika and Gotenberg. Files that need Tika are marked.
- A bulk send reads at most 25 messages at once.
- The title field is shown for a single file; several files keep their file names as titles.
- The documents page is a page with a header at the app's content width, not a Files-style toolbar: it is one flat, searchable list with filters (no folders to walk through), and the same view runs inside a dialog, where a toolbar would sit oddly inside the dialog's padding.
- There is no "Open in Paperless" entry in the attachment menu: the host draws the same menu entries for every attachment, so an entry can't depend on whether that one file is in Paperless. The Send dialog shows it instead.
- The document preview shows the Paperless thumbnail (the picture itself for image documents) and the document text; PDFs can't be shown inside the sandboxed plugin frame.

## Development

```
node scripts/build.mjs paperless
node node_modules/vitest/vitest.mjs run paperless
BULWARK_ADMIN_PASSWORD=... node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.mjs paperless/e2e
```

The end-to-end tests run against the Paperless container from `test-env` and send their own test mail over SMTP (`e2e/send_mail.py`, needs Python). They detect whether the Paperless in front of them accepts streamed uploads and expect either the filed document or the clear error above.
