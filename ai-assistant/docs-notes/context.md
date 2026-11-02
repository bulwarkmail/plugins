# Docs notes: More context (package B)

For WRITING_PLUGINS.md "API reference", the website's guides/plugins.md
"APIs", and the user page features/ai-assistant.md.

## New host APIs (webmail 1.20)

Each has a flag in `api.host.features`; read it as `=== true` (older
webmails don't send it) and check `typeof api.email.x === 'function'`.

### api.email.getAttachmentText(emailId, blobId, { maxChars?, accountId? })

- Permission `email:blob-read`. Flag `attachmentText`. 30 calls a minute per
  plugin ("email.getAttachmentText: too many reads, try again in a minute").
- Same checks as `email.getAttachment`: the blob must be an attachment of
  that message; `accountId` for shared and group mail (rows of an open
  shared folder are found without it).
- Returns `{ name, type, size, format, status, text, truncated, pages?, sheets? }`.
  - `format`: text, csv, html, ics, vcf, pdf, docx, xlsx, pptx, odt, ods, odp, other.
  - `status`: `ok`; `too_big` (over 20 MB, or an Office file that unpacks to
    more than 50 MB); `unsupported` (images, archives, legacy .doc/.xls/.ppt);
    `no_text` (a scanned PDF, an empty file); `encrypted`; `failed`.
  - `text` is '' unless ok. `maxChars` 1 to 100,000, default 20,000;
    `truncated` when cut, or when a PDF had more than 50 pages or a sheet
    more than its rows.
  - PDFs: `pages` is the page count; at most 50 pages are read, each from
    the second on starts with "Page n". Spreadsheets: `sheets` names the
    sheets read (at most 5, 2,000 rows each), each starts with
    "Sheet: <name>" then CSV rows. Slides: "Slide n" then its text.
    Calendar files: one line per event or task (title, start, end,
    location, organiser). Contact files: name, emails, phones, company.
- The text is extracted in the webmail (pdf.js the Files viewer already
  ships; Office files with the webmail's own reader). The plugin never
  gets the file's bytes from this call.

### api.email.getAttachmentImage(emailId, blobId, { maxSide?, exif?, accountId? })

- Permission `email:blob-read`. Flag `attachmentImages`. 30 calls a minute.
- Returns `{ name, type, width, height, data, status, alt?, exif? }`.
  - `status`: `ok`, `tracker` (1-2 px), `tiny` (a side under 64 px or
    less than 128×128 in area), `too_big`, `unsupported` (not a picture the
    browser can show: HEIC, TIFF, SVG, not an image), `failed`.
  - When ok: `data` is base64 (no `data:` prefix), `type` image/jpeg
    (quality 0.85, on white) or image/png for pictures with see-through
    parts, at most 1.5 MB; `width`/`height` the size of `data`.
  - `maxSide` 64 to 2,576, default 1,568 (never made larger). Animated
    images give their first frame. EXIF orientation is applied.
  - `alt`: the alt text the message's HTML gives this inline image.
  - `exif: true` adds `exif: { taken?, lat?, lon? }` (taken like
    "2026-10-31T14:05:30", plus the offset when the camera wrote one).
    Off unless asked.
- Only attachments and inline (cid) parts of the message; remote images are
  never fetched.

### api.email.getThread(emailId, { accountId? })

- Permission `email:read`. Flag `threads`. 60 calls a minute.
- Returns `EmailReadView[]`, oldest first, at most 50 (the newest 50 of a
  longer conversation), each with `accountId`. A message the server lists
  in no thread comes back alone.

### EmailReadView.attachments: `cid?`, `alt?`

Inline images now carry `cid` (the Content-ID without angle brackets) and
`alt` (from `<img src="cid:…" alt>` in the HTML, else its `title`).

### Reader panel prop `listSelection`

`email-detail-sidebar` gets `listSelection: { emails: [{ id, accountId }], total } | null`
(gated by `email:read`): the messages ticked in the list when two or more
are, at most 50 in `emails`, `total` the real count. Rows of another
connected login are counted but not listed. Flag `listSelection`. The
app-wide side panel doesn't get it.

### api.email.search: `position`

`position` (0 to 1,000,000) pages through results, with `limit` (≤ 50).

### Permission text

`email:blob-read` now reads "Read attachments and message sources: Read
attachments (their text and pictures too) and the full source of messages
you act on, and every file you attach before it is sent."

## For users (features/ai-assistant.md)

**More context.** Next to an open message the assistant can read more than
the message's text when the question needs it. Chips in the input box show
what it may read; the x takes one out.

- Attachments: PDF (up to 50 pages), Word, Excel (5 sheets of 2,000
  rows), PowerPoint, OpenDocument, text, CSV, HTML, calendar and contact
  files. It says when a file is too big (over 20 MB), protected with a
  password, scanned without a text layer, or of a kind it can't read (old
  .doc, .xls, .ppt).
- Pictures: attached images and pictures in the message go to the model
  as images when it can see them; they are made smaller first. Tracking
  pixels and tiny images are left out; remote images are never loaded.
  Without image support the model only hears the file name and the
  picture's description. The date and place of a photo only when you ask.
- This conversation: every message of the open conversation, quotes cut.
- Messages selected in the list: "3 messages" chip; Actions offers
  Summarize these, What do I have to do?, and One reply to all (always
  asks first; a new message to everyone who wrote them). Up to 50.
- @ mentions: `@` plus a few letters adds a message or contact.
- One request reads at most 60,000 characters and 8 pictures (4 per
  message).
- User settings (Settings > AI Assistant > More context): Read
  attachments, Look at images, Read the whole conversation; with their own
  key also "My model can see images".

What is sent to the AI service:

| When you | What is sent |
| --- | --- |
| Ask about an attachment | Its text (20,000 characters, more when the model asks, at most 60,000 per request in all), or the picture, made smaller, when the model can see images; otherwise its name and description |
| Ask when or where a photo was taken | The date and place stored in the photo |
| Ask about the conversation | Sender, recipients, date, subject and text (without quotes) of every message, up to 50 |
| Ask about selected messages | The same for up to 50 of them, and how many you selected |
| Mention a message or contact with @ | The message's sender, date and subject (its text when read), or the contact's name, addresses and company |

The privacy notice adds, for what is on: "When it reads an attachment for
you, it sends the attachment's text." "Pictures it looks at go along as
images. The date and place a photo was taken go only when you ask for
them." "When it reads the whole conversation, it sends every message in
it." "When you ask about the messages you selected in the list, it sends
them." "Messages and contacts you mention with @ go along too."

## For administrators

- **More context** (`allowContext`, on): switches all of the above off.
- **Anthropic: images** / **OpenAI-compatible: images** (`anthropicImages`,
  `openaiImages`: auto, yes, no). Automatic: yes for Anthropic and for
  api.openai.com (apart from o3-mini, gpt-oss and gpt-3.5 models), no for
  other servers (Ollama, vLLM, LM Studio). If a model refuses an image
  anyway, the assistant asks once more with the file names and says so.
- Local models (OpenAI-compatible servers other than api.openai.com) get
  pictures at 1,024 px on the long edge instead of 1,568.
