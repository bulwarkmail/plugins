# Docs notes: chat tools (package E)

No new host API, permission or flag. The plugin uses what webmail 1.17
already has: `api.storage`, `api.templates.list/get/create/delete`
(templates:read, templates:write, both added to the manifest's
`permissions`; known since 1.3.9) and `api.composer.replaceSelection` /
`getBody` (compose:write, compose:read). Everything here works on 1.19.1.

## For features/ai-assistant.md (user page)

### Earlier chats

Next to a message the assistant keeps one running chat, across the
messages you open. When the panel opens after 8 hours without use, that
chat moves to **Earlier chats** and a fresh one starts. New chat does the
same at once. Open the list with the clock button in the panel's header:
search (titles and texts), open a chat to read it, **Continue this chat**
to make it the running one again, rename, delete. The title is the start
of the first question. The newest 30 chats are kept, at most 400 KB
together; older ones are dropped. The chats live in this browser only.
The composer keeps its own chat per draft, as before. Keyboard: arrow keys
move through the list, Enter opens, Escape goes back.

### Saved prompts and slash commands

Settings > AI Assistant > Chat: add, change and delete your own prompts
(a name and the text to send). Administrators can add prompts for
everyone. Both show in the panel's Actions menu. A saved prompt runs like
a typed request, on the message or text the panel works on.

Type `/` at the start of the input for a list of the quick actions and
saved prompts. Typing filters it, arrow keys move, Enter runs, Tab
completes the command's name (`/to-dos-and-dates`), Escape closes it.

### Edit and Answer again

The pencil next to your last typed question puts it back into the input;
a chip says "Editing your last message" (its x stops). Sending replaces
that question and its answer. **Answer again** under the last answer asks
for a new one.

### Notes the assistant remembers

Say "Remember that my manager is Jan". The assistant always asks first
("Remember: “My manager is Jan”?"), whatever the actions setting. Notes
need actions on (ask first or automatic). At most 50 notes of 200
characters, kept in this browser. Settings > AI Assistant > Chat lists
them to change or delete, and has a switch to stop using them. Undo on
the card removes a note again.

### Templates

With lookups on, the assistant can read your message templates. In the
composer it can put one into the draft at the cursor, filling in the
`{{placeholders}}` it knows (the subject stays as it is; undo it in the
editor). It can save a reply as a new template; it always asks first, and
Undo deletes the template again.

### What is sent to the AI service

- With notes on (and the admin allowing them): the notes, with every
  request. The privacy notice says "It also sends the notes you asked it
  to remember."
- A saved prompt or `/` command: the prompt's text, as if typed.
- The templates lookup: names, categories, subjects, placeholders and the
  first 300 characters of each template. The notice says "When it looks up
  your templates, it sends their names and texts."
- Earlier chats are not sent; only the running chat's last turns are, as
  before. Continuing an old chat makes its turns the running chat.

## For "For administrators"

| Setting | Effect |
| --- | --- |
| Chat tools (`allowChatTools`, on) | Earlier chats, saved prompts, slash commands, Edit and Answer again, notes and templates. Off: the reader keeps one chat that never moves to history (2.1 behaviour) |
| Prompts for everyone (`prompts`, multiline) | One prompt per line, `Name: what to ask`. Lines without a name, empty lines and lines starting with `#` are left out; at most 30 |
| Remember notes (`allowMemory`, on) | Off: no remember action, notes are not sent, the settings hide them |

## For WRITING_PLUGINS.md

Nothing new in the host API. One change to the plugin-side input menu
contract (src/ui/panel/InputMenu.jsx, internal to the assistant): a menu
may give `complete(item)`; Tab then completes the trigger text to what it
returns instead of picking.

## Storage keys (for the README's storage paragraph and support)

| Key | Content |
| --- | --- |
| `chat:reader` | `{ id, started, turns, at }`; turns carry `at` (ms). Saves merge by turn id |
| `history:index` | `[{ id, title, at, count, size, renamed? }]`, newest first |
| `history:<id>` | `{ turns }` of an old chat (no Retry inputs, lookup results cut to 2,000 characters) |
| `memory` | `{ notes: [{ id, text, at }] }` |
| `prefs.prompts` | `[{ id, name, text }]`; `prefs.memory` false switches notes off |
