# Docs notes: Files (package D)

For WRITING_PLUGINS.md "API reference", the website's guides/plugins.md
"APIs", and the user page features/ai-assistant.md.

## New host APIs (webmail 1.20)

`api.files`, flag `files` in `api.host.features`: true when the server has
Files for the signed-in account and the administrator left Files on
(the same check as the navigation rail: `client.supportsFiles()` and the
policy's `filesEnabled`). Read it as `=== true` and check
`typeof api.files?.find === 'function'`. Every call refuses with
"files.x: Files is not available" when the flag is false. Plugins don't
run in Bulwark Lite, so the API is never there.

The permissions are the existing `files:read` and `files:write`; their
consent texts now read "Find, open and read the files in your account."
and "Save, create, rename and move files in your account, and stop a
file from being deleted."

There is no call that deletes a file, shares it, makes a public link or
moves it to another account. Writes go only into the user's own drive
and never into, out of or inside a folder that is shared with others
(`shareWith` on it or a folder above it); files in drives others shared
with the user can be found, read and attached, never changed. The Files
trash (`.Trash`) is never listed and can't be written into.

Writes run the same plugin hooks as the Files app: `onBeforeFileUpload`
(create, replace, saveAttachments), `onBeforeFileMove`,
`onBeforeFileRename` can stop them ("files.x: another plugin stopped
this"); `onAfterFileUpload`, `onDirectoryCreate`, `onFileMove`,
`onFileRename` report them. An open Files view refreshes after a change.

### FileInfo

`{ id, name, path, parentId, kind: 'file'|'folder', mimeType, size, modified, shared?, owner? }`

- `id`: for the other calls. Files in a drive someone shared with the
  user have ids like `account:node`.
- `path`: the folder the item is in, from the top of its drive ("/",
  "/Documents/2026").
- `mimeType` and `size` are '' and 0 for folders. `modified` is ISO 8601.
- `shared: true` and `owner` (the drive's name) for others' files.

### api.files.find(query?)

- `files:read`. Query `{ text?, folderId?, kind?, modifiedAfter?, modifiedBefore?, limit? }`:
  `text` words of the name or path (all must appear, any case);
  `folderId` only below that folder; `kind` one of document, image, pdf,
  spreadsheet, presentation, text, folder; dates as ISO 8601 (after is
  inclusive, before exclusive); `limit` 1 to 50, default 20.
- Returns `FileInfo[]`, newest first: the user's own drive and the drives
  shared with them. Left out: the Files trash and what is in it, Stalwart
  1.0 symlinks, and the folders of another account that are only listed
  as the way down to something shared.
- The listing is kept for 60 seconds (a change through api.files or the
  Files view drops it).

### api.files.list(folderId?)

- `files:read`. Returns what a folder holds, folders first, then by name,
  at most 200. Without a folder: the top of the user's drive and the top
  items others shared with them. "files.list: "x" is not a folder" for a file.

### api.files.getText(fileId, { maxChars? })

- `files:read`, 30 a minute. Same answer and limits as
  `email.getAttachmentText`: `{ name, type, size, format, status, text, truncated, pages?, sheets? }`.
  Files of others' drives are read from their owner's account.

### api.files.getImage(fileId, { maxSide?, exif? })

- `files:read`, 30 a minute. Same answer as `email.getAttachmentImage`
  (without `alt`): a picture shrunk in the app, base64.

### api.files.attach(fileIds, target)

- `files:read`, plus `compose:write` for `{ composerId }` (the draft open
  in the composer, as for `api.composer.*`) or `compose:open` for
  `{ newDraft: { to?, subject?, body? } }` (goes through `compose.open`:
  its address checks, 5 a minute, and it asks before replacing an open
  draft). At most 20 files; folders are refused.
- Attaches by blob: no download, no upload. The composer's own checks
  run (the size limit, `onBeforeAttachmentUpload`). A file of the user's
  Files keeps the login that holds it, so a draft sent from another login
  copies it over first.
- Returns `{ attached: string[], refused: string[] }` (file names).

### api.files.saveAttachments(emailId, blobIds, folderId?, { accountId? })

- `files:write` and `email:read`; 20 changes a minute (shared with the
  other writes). At most 20 attachments; each blob must be an attachment
  of that message (found as `email.get` finds it).
- Files the blobs into the folder (null: the top of the user's drive),
  copying them from a shared or group mailbox's account first. A name
  that is taken becomes "name (2).ext". The reader's Save to Files dialog
  uses the same code (lib/files-save.ts) and now runs the upload hooks too.
- Returns `{ saved: FileInfo[], stopped: string[] }` (names another
  plugin stopped).

### api.files.create({ folderId?, name?, content, type, replace? })

- `files:write`, 20 changes a minute. `type` text/markdown or text/plain;
  `content` up to 512 KB.
- New file: `name` is required and checked against the server's naming
  rules first ("files.create: that name is reserved by the server", "the
  name may not contain :", control characters, too long). A name that is
  taken becomes "name (2).md"; nothing is overwritten.
- `replace: fileId`: new content for a text or Markdown file of the
  user's own drive. The old version goes into the Files trash first (a
  copy pointing at the old content, in a trash folder of its own), where
  Restore in Files brings it back next to the new one. Other kinds of
  files are refused.
- Returns `{ file: FileInfo, kept?: { trashFolder, name } }`.

### api.files.createFolder({ parentId?, name })

- `files:write`. Same name checks; Stalwart 1.0's depth limit (64) is
  checked. Returns the `FileInfo`.

### api.files.move(fileId, folderId | null)

- `files:write`. Within the user's own drive; not into itself, not into
  the trash, not where something has the same name. Returns
  `{ file, previousFolderId }`: move it back to undo.

### api.files.rename(fileId, name)

- `files:write`. Name checks as above; refused when the folder already
  has that name. Returns `{ file, previousName }`: rename back to undo.

## Fixed on the way

- Plugins got Stalwart 1.0 symlinks (and an old blob-backed file marked
  "d") as folders in `FileResourceView` (hooks, `file-actions` and
  `file-preview-section` props); they are files now.
- The global search listed the Files trash, its folders and deleted
  files; they are left out.

## For the user page (features/ai-assistant.md)

Where the webmail has Files, the assistant can look in them when your
question needs it: find files and folders by name, kind or date, list a
folder, and read a file (PDF, Word, Excel, PowerPoint, OpenDocument,
text) or look at a picture. It sees your own files and the ones others
shared with you, never the Files trash. Type `@` and part of a name to
add a file to the chat.

With actions on it can also attach files to the message you write or to
a new one (always asks first and lists the files and recipients), save
the open message's attachments into a folder, create a Markdown or text
note and folders, replace a text file (always asks first; the old
version goes to the Files trash, where Restore brings it back), and move
and rename files and folders (always asks first, with Undo). It only
changes your own files, never a shared folder, and it can't delete or
share a file.

What goes to the AI service: the names, folder paths, kinds, sizes and
dates of the files and folders a search or folder list finds, and the
contents of the files it reads (pictures as images when the model can see
them, else only the name). Names of files it saves, creates, moves or
renames. Everything one request reads shares the 60,000-character and
8-picture limit with attachments.

Settings > AI Assistant > Files: "Find and read files" (also attaching)
and "Save and create files", both on by default.

## For administrators

- Plugin setting **Files** (`allowFiles`, on by default) switches the
  whole group off: no lookups, no actions, no @ files, no settings.
- The webmail's own Files switch (policy "Files (WebDAV)") and the
  server's Files support decide whether `api.files` exists at all.
