# Nextcloud

Connects Bulwark Mail to your Nextcloud.

## Connecting

Open Settings > Plugins > Nextcloud and choose **Connect Nextcloud**. The
webmail asks you to confirm the server, then opens Nextcloud's own sign-in
page (Login Flow v2) in a new tab. Sign in there and grant access. Nextcloud
creates an app password for Bulwark, and the webmail server stores it right
away. The plugin never sees it: every request goes through the webmail's
plugin proxy, which adds the password and only talks to that one server.

Settings then show which Nextcloud account is connected ("Connected to
Nextcloud at cloud.example.com as Alice Example (alice)"). That is the account
that was signed in on Nextcloud's page when you connected, which doesn't have
to be your mail account: if someone else was signed in to Nextcloud in that
browser, their account gets connected. **Use another Nextcloud account**
disconnects and starts the sign-in again; if Nextcloud's page still shows the
wrong person, log out there first.

**Disconnect** deletes the stored password and revokes it in Nextcloud. If
the app password is revoked in Nextcloud (or expires), the plugin says so and
offers to sign in again.

Errors are shown in plain words: an expired or revoked app password (with
**Sign in again** right where it happened), sharing not allowed by the
Nextcloud admin, a full storage quota, rate limits, timeouts, Nextcloud in
maintenance mode, and Nextcloud's own message for things like password rules.

![Sign in again after the app password was revoked](screenshots/expired-light.png)
![Settings, not connected](screenshots/settings-disconnected-light.png)
![Settings, connected](screenshots/settings-connected-dark.png)

## Attach from Nextcloud

In the composer, **Attach > From Nextcloud** opens a file picker. Browse your folders, look at **Recent** files or search
by name, and pick one or more files. Then:

- **Attach copies** downloads the files through the proxy and attaches them
  like any other attachment.
- **Share as link…** creates a public, read-only Nextcloud link for each file.
  You can protect the links with a password (the plugin suggests one that
  meets your server's password rules) and set an expiry date. The links go
  into the message where the cursor is, as a short list under "Files shared
  with Nextcloud". You see them, can edit or delete them like any text, and
  one Ctrl+Z takes them out again. The password is only written into the
  message if you tick **Put the password in the message**; otherwise send it
  some other way.

![From Nextcloud in the Attach menu](screenshots/attach-menu-light.png)
![File picker](screenshots/picker-light.png)
![Share options](screenshots/share-options-dark.png)
![Share links in the message](screenshots/links-in-message-light.png)

## Large attachments

When you attach a file of 10 MB or more (adjustable), the plugin asks whether
to upload it to your Nextcloud and put a share link in the message instead.
The same link options apply. Files larger than 10 MB go up in 10 MB chunks
(Nextcloud's chunked upload v2) with a progress bar. **Cancel** pauses the
upload; **Resume upload** continues with the chunks the server already has,
also after a failed chunk. Short network errors are retried by themselves.
**Attach as usual** (or closing the dialog) attaches the file normally.

Uploads go to the upload folder, by default `Mail attachments/<date>`. A
file with the same name gets " (2)" added.

![Large attachment offer](screenshots/large-offer-light.png)
![Link in the message](screenshots/large-link-light.png)

## Save attachments and messages

Each attachment's menu (the "…" button) has **Save to Nextcloud**, and the
toolbar of an open message has **Save message to Nextcloud**, which saves
the whole message as an `.eml` file named after its subject. A folder picker
opens on the folder you used last; **New folder** creates one in place. A
file with the same name gets " (2)" added. Attachments and messages of up to
25 MB can be saved (the webmail's limit for plugins).

![Choosing a folder](screenshots/save-folder-dark.png)

## The Nextcloud page

**Nextcloud** in the navigation opens your files in the webmail, laid out
like the Files app. Browse, search and look at recent files; **Upload** (or
drop files onto the page) with progress, cancel, resume and remove; **New
folder**. The account button at the end of the toolbar shows which Nextcloud
account is connected and lets you use another one. Select a file to
**Download** it, create a **Share link**, **Attach to new message** (opens the
composer with the file attached) or **Open in Nextcloud**. The webmail
refuses to hand out some file types from a plugin (HTML, SVG, programs);
for those only "Open in Nextcloud" is offered. A file can't be dragged from
this page into a composer: the page and the composer are separate frames,
so "Attach to new message" does that job.

![The Nextcloud page](screenshots/files-page-light.png)
![Creating a share link](screenshots/share-link-light.png)
![The connected Nextcloud account](screenshots/account-dark.png)
![The Nextcloud page on a phone](screenshots/files-page-phone-dark.png)
![The Nextcloud page before connecting](screenshots/files-page-disconnected-light.png)

## Talk meetings

With **Talk meeting button** turned on in the settings, the event form shows
**Add Talk meeting** under the meeting link. It creates a public Nextcloud
Talk conversation named after the event and puts its link into the event's
meeting link, so everyone invited can join with it. The button is greyed out
while the event already has a meeting link. Nextcloud needs the Talk app.

## Settings

User settings (Settings > Plugins > Nextcloud):

| Setting | Default |
| --- | --- |
| Protect share links with a password | off |
| Share links expire after (days), 0 = never | 14 |
| Offer to send large attachments as a Nextcloud link | on |
| Large attachment size (MB) | 10 |
| Upload folder | Mail attachments |
| Folder layout (`date`: a subfolder per day, `flat`) | date |
| Talk meeting button in the event form | off |

## For administrators

| Setting | What it does |
| --- | --- |
| Nextcloud server (`serverUrl`) | Your organisation's Nextcloud, e.g. `https://cloud.example.com`. Users don't have to type it and can only connect to this server. Leave empty to let each user choose. |

The webmail server must be able to reach Nextcloud. A Nextcloud on a private
network has to be listed in `PLUGIN_PROXY_PRIVATE_ORIGINS`, by exact origin.
Nextcloud needs no CORS setup.

### Permissions

| Permission | Why |
| --- | --- |
| `http:proxy` | All requests to Nextcloud go through the webmail's secret proxy with the user's app password. |
| `ui:settings-section` | The connect / disconnect section in Settings. |
| `ui:composer-toolbar` | "From Nextcloud" in the composer's Attach menu (`composer-attach-menu`). |
| `email:blob-write` | Upload a file picked in Nextcloud to the mail server and attach it to the composer (`api.composer.attach`). |
| `compose:write` | Put the share links into the message at the cursor (`api.composer.replaceSelection`). |
| `email:read` | The "Save to Nextcloud" entry in the attachment menu (`attachment-menu`) and reading the subject of a message you save. |
| `email:blob-read` | Read a large file you just attached (`upfiles.get`), and an attachment or the message source you save (`email.getAttachment`, `email.getRaw`). |
| `ui:toolbar` | The "Save message to Nextcloud" button in the reader (`reader-actions`). |
| `ui:app-page` | The Nextcloud page and its entry in the navigation. |
| `compose:open` | "Attach to new message" on the Nextcloud page. |
| `ui:download-file` | "Download" on the Nextcloud page. |
| `ui:calendar-action` | "Add Talk meeting" in the event form (`calendar-event-actions`). |
| `calendar:read` | The event's title, description and meeting link, which the Talk button reads. |

The server address the administrator set is read with `api.config.get()`,
which needs no permission.

`email:blob-write` also covers the `onBeforeBlobUpload` hook, which is how the
large-attachment offer gets in before the file is uploaded to the mail
server.

The `nextcloud` credential is a user credential with Basic auth: the user
name and app password come from Nextcloud's Login Flow v2.

## What is sent where

Nothing goes to Nextcloud until you connect it. The plugin then only sends
what you ask it to: folder listings and searches while the picker is open,
a share request for each file you share as a link, and the large files you
choose to upload, and the attachments and messages you save.

## Moving from "Nextcloud Attachments"

This plugin replaces Nextcloud Attachments. The old plugin kept the app
password in plain text in the browser's plugin settings, where this plugin
can't read it (and shouldn't). So the move takes one sign-in per user:

1. The admin installs this plugin, sets the Nextcloud server under its admin
   settings, and removes the old `nextcloud-attachments` plugin.
2. On the first start, the plugin shows a short note pointing to Settings >
   Plugins > Nextcloud. The server is already filled in from the admin
   setting. The user signs in with Nextcloud once; the old app password is
   not carried over. Users can revoke the old one in Nextcloud under
   Settings > Security > Devices & sessions.

## Development

```
node nextcloud/scripts/sync-locales.mjs     # copy locales/*.json into manifest.json
node scripts/build.mjs nextcloud            # build nextcloud.zip
node node_modules/vitest/vitest.mjs run nextcloud
BULWARK_ADMIN_PASSWORD=... node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.mjs nextcloud/e2e
```

Translations live in `locales/<lang>.json`, one file per webmail language.
The end-to-end tests run against the Nextcloud container from `test-env`
(user alice).
