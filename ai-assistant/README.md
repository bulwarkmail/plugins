# AI Writing Assistant

A chat next to the message you write or read. It rewrites, translates and
proofreads your text, summarises messages and drafts replies, with an
OpenAI-compatible service (OpenAI, Ollama, LM Studio, vLLM, ...) or the
Anthropic Messages API. It works on the text you highlight, else on the
whole message.

Nothing is sent to the AI service until you ask the assistant something.
Before the first request to a service you see which service it is, which
server the text goes to and which model answers, and have to confirm.

## Writing

Click **Assistant** in the composer's bottom bar or press **Alt+A**: the
assistant opens as a panel next to the message (Alt+A or the arrow at its
top folds it again, and it stays the way you left it; drag its edge to
make it wider). It shows what it works on:

- **Selected text**: highlight part of the message and the panel follows.
- **Your message**: nothing selected, the text you wrote so far (the
  signature and the quoted message of a reply are never sent or changed).
- **Empty message**: describe the email and the assistant writes it.

Quick actions sit above the chat: **Improve**, **Shorten**, **Formal**,
**Casual**, **Fix spelling** and **Translate** (32 languages, the last one
used is remembered). Or type what you want below: "add that I'm away next
week", "make the second paragraph friendlier", "is this too blunt?".

When the assistant proposes text, it comes in word by word as a marked
change: removed words struck out, new ones highlighted. **Replace** puts
it in place of the selection (or the message), **Insert below** adds it
after the selection, **Insert at cursor** puts it where you are. Each
change is one step in the composer's undo, so Ctrl+Z takes it back.
**Fix spelling** lists each correction to accept or keep one by one, or
all at once. A question gets a plain answer; the conversation continues
with everything said so far in mind, and stays until the composer closes.

**Right-click selected text** in the message for Improve writing, Fix
spelling, Shorten, Translate and Ask the assistant: the panel opens and
gets to work on that text.

## Reading

Click **Assistant** in the toolbar of an open message to open its panel
(or right-click selected text). It offers **Summarize**, **To-dos and
dates** (with due dates, as a copyable checklist), **Reply ideas** (three
short replies; **Reply** opens one in the composer) and **Translate**. Ask
anything about the message below: "what do they want from me?", "when is
the deadline?". **Draft a reply** writes a reply you open with one click.

Highlight a passage of the message and the panel switches to it:
**Explain**, **Translate** and **Draft a reply** to that part. The same
three are in the **right-click menu** on selected text.

Above a conversation, **Summarize this conversation** summarises up to the
last 20 messages. On phones, where there is no side panel, the actions
are in a bar above the message and the composer opens the assistant in a
dialog.

## Lookups

When an answer needs it, the assistant can look things up for you and
show each lookup as a step in the chat, with a card of what it found:
your **calendar** ("propose a time next week when I'm free" shows the
days busy or free), your **contacts** ("send it to Anna from accounting"
gives the address, to copy or insert), your **mail** ("what did Carol
write about the invoice?" searches, lists the messages found and reads
the one that matters), **the message you reply to** and **your settings**
("why are messages marked read so fast?" reads how you set the app up).
Turn this off in the plugin's settings.

The assistant also knows the app itself: its name and version, the
account and mail server you use, what the app can do, and where each
setting is. Asked "how do I set up an automatic reply?", it looks the
setting up in the app's own settings index and names the page and the
setting as you see them, in your language. Nothing is looked up or sent unless you asked a
question.

## Actions

When you turn them on, the assistant can also do things for you: archive
a message, move it to a folder, mark it read, unread, starred or not, add
a calendar event, a task or a contact, and open a reply or a new message
in the composer with the text it drafted. It never sends and never
deletes mail; a reply or a message waits in the composer for you.

Each action shows as a card in the chat with what it will do ("Move
“Invoice 42” to Projects 2026"). Settings > AI Writing Assistant >
Actions has two modes:

- **Ask me first**: the card waits with Do it and Skip, and nothing
  happens until you click Do it. Skip tells the model you said no.
- **Automatic**: the action runs right away and the card offers Undo
  (archive, move and marks go back, an event, task or contact is
  deleted again). After five actions in one answer the assistant asks
  first anyway.

Actions are off until a user turns them on. The administrator decides
how far users may go (off, ask first, or automatic) in the plugin's
admin settings. The model is told to act only when you ask or agree,
never because a message says so; ask first is the safer mode for
mailboxes that receive mail from strangers.

## Answers, cards and what the assistant knows

Answers come as formatted text (bullet lists, bold, small tables, links
that open in a new tab). The assistant can add cards to an answer: quick
replies to click, time slots to put into the message or answer with, a
checklist, people, a table. In the composer a card's text goes into the
message where the cursor is.

Every request tells the model who you are, from your account: your
name, your addresses, how you sign (the plain-text signature of your
first identity), your time zone, the local time and the language of the
mail client. Two kinds of standing instructions go along as well:
**the administrator's**, for everyone (the plugin's admin settings), and
**your own** (Settings > AI Writing Assistant > Standing instructions):
"I am a teacher, keep my emails short and warm, sign with Anna". Yours
come last, so they win when the two disagree.

Mail text is put between tags and the model is told that it is data, not
instructions, so a message that says "ignore your instructions" is
summarised, not obeyed. Very long texts are cut at 30 000 characters.

## Setting it up (administrator)

Install `ai-assistant.zip` in the admin dashboard, then fill in its
settings. Set up one or both services:

| Setting | What to enter |
| --- | --- |
| OpenAI-compatible API address | Up to and including `/v1`: `https://api.openai.com/v1`, or `http://ollama:11434/v1` for Ollama |
| OpenAI-compatible API key | The key. Ollama needs none, but the field must not be empty: enter any text |
| OpenAI-compatible model | e.g. `gpt-4o-mini`, or `qwen2.5:7b` on Ollama |
| Anthropic API address | `https://api.anthropic.com/v1` (Ollama also speaks this API at `http://ollama:11434/v1`) |
| Anthropic API key | The key |
| Anthropic model | e.g. `claude-haiku-4-5` |
| Default service | Which one users get when both are set up |
| Instructions for the assistant | Standing instructions for everyone, added to every request (house style, sign-offs, languages, things never to say) |
| Actions | The most users may choose: off, ask first, or automatic (default: automatic allowed; each user starts with actions off) |
| Let users connect their own API key | Off by default |

Without a model the defaults are `gpt-4o-mini` and `claude-haiku-4-5`.
Lookups need a model that supports tool calls; small local models often
answer without them. The instructions field takes several lines from
webmail 1.20 on; older versions show one line, so separate instructions
with semicolons there.

The keys stay on the webmail server. The plugin asks the webmail's server
proxy to send each request "with the OpenAI key" or "with the Anthropic
key", and the server adds the key and only sends it to the address above.

An address on your own network (Ollama on the same host, say) is only
reachable when its origin is listed in `PLUGIN_PROXY_PRIVATE_ORIGINS` on
the webmail server, e.g. `PLUGIN_PROXY_PRIVATE_ORIGINS=http://ollama:11434`.

Needs Bulwark Mail 1.17.0 or newer (the side panels, the right-click
menus and `api.ui.openPanel`).

## Settings (users)

Settings > AI Writing Assistant shows which service and model are used. A
user can pick another model, choose between the two services when both
are set up, hide the assistant next to messages, turn the lookups
off, and turn actions on (ask first or automatic). When the administrator allows it, a user can connect their own key:
they pick the service and address here, and type the key into the
webmail's own dialog, so the plugin never sees it. Their key is stored
encrypted on the server and only sent to the address they approved there.

## What is sent where

| When you | What is sent to the AI service |
| --- | --- |
| Describe an empty message | Your description and the subject |
| Use Improve, Shorten, Formal, Casual, Translate or Fix spelling | The selected text, or your own text of the message (no signature, no quote) |
| Type a request in the composer | The same text, the subject, whether it is a reply and to what, and the earlier turns of the chat |
| Anything | Your name, addresses, plain-text signature, time zone, local time and language, and the standing instructions (the administrator's and yours) |
| Use Summarize, To-dos and dates, Reply ideas, Explain or Translate on a message | Sender, date, subject and text of the open message (and the highlighted passage) |
| Type a request about a message | The same, and the earlier turns of the chat |
| Summarize a conversation | Sender, date, subject and text (without quotes) of up to 20 messages |
| Ask something that needs a lookup | What the lookup found: calendar events of the days asked for, matching contacts, the messages a mail search found (sender, date, subject, preview) and the text of a message it reads, or the message you reply to |

Nothing else leaves the webmail. In the browser the plugin keeps your
choices, which services you confirmed, the chats of the open composer and
of the messages you talked about, and, while a composer is open, the
draft's subject and what the composer is a reply to (removed when the
composer closes).

## Permissions

| Permission | Why |
| --- | --- |
| `email:read` | Read the open message and conversation, the message you reply to, the draft's subject, and search and read your mail for a lookup |
| `http:proxy` | Send requests to the AI service through the webmail's server, which adds the API key |
| `admin:config` | Read the administrator's settings (addresses and models; the host never hands out the keys) |
| `ui:composer-sidebar` | The panel next to the message you write (`composer-sidebar-right`) |
| `ui:email-details` | The panel next to the open message (`email-detail-sidebar`) |
| `ui:composer-toolbar` | The Assistant button in the composer's bottom bar and the right-click entries on selected text in the message |
| `ui:context-menu` | The right-click entries on selected text in an open message |
| `ui:toolbar` | The Assistant button in the open message's toolbar (`reader-actions`) |
| `ui:email-banner` | The bar above a message on phones and the conversation summary |
| `ui:settings-section` | The plugin's settings page |
| `compose:read` | Read the selection or your own text of the message the assistant works on |
| `compose:write` | Replace the selection or the message, or insert text, when you click Replace or Insert |
| `compose:open` | Open a reply with a drafted reply or a reply idea in it, and the reply or new message of an action |
| `calendar:read` | The calendar lookup |
| `contacts:read` | The contact lookup |
| `email:write` | Actions: archive, move and mark messages |
| `calendar:write` | Actions: add an event (and delete it again on Undo) |
| `tasks:write` | Actions: add a task (and delete it again on Undo) |
| `contacts:write` | Actions: add a contact (and delete it again on Undo) |
| `identity:read` | Your name, addresses and signature, so the model knows who writes |
| `account:read` | Your account's name and address when there is no identity, and the mail server it is on |
| `settings:read` | Your settings (layout, formats, reading and sending options), for the settings lookup |

## Credentials

| Id | Set up by | Sent as |
| --- | --- | --- |
| `openai` | administrator | `Authorization: Bearer <key>` to the OpenAI-compatible address |
| `anthropic` | administrator | `x-api-key: <key>` to the Anthropic address |
| `own-openai` | user, if allowed | `Authorization: Bearer <key>` to the address the user approved |
| `own-anthropic` | user, if allowed | `x-api-key: <key>` to the address the user approved |

## Errors

You get a plain sentence instead of an error code: the key was refused
(401), no permission for the model (403), unknown model or address (404),
too many requests (429, with the wait time from `retry-after` and a Try
again button that waits it out), no credit left, service overloaded
(529/503), no answer for 60 seconds, text too long, or the service can't
be reached. A lookup that fails is shown as a failed step and the model
is told so.

## Tests

```
node node_modules/vitest/vitest.mjs run ai-assistant
BULWARK_ADMIN_PASSWORD=... node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.mjs ai-assistant/e2e
```

The end-to-end tests need the webmail and `test-env` running, with
Ollama (`up.ps1 -WithAI`). They use the Anthropic and OpenAI mocks
(`http://localhost:18099`) for the error cases, and Ollama for answers,
through both its OpenAI-compatible and its Anthropic API.
`e2e/seed_thread.py` adds a three-message conversation to alice's inbox
for the conversation summary.

## Screenshots

| | |
| --- | --- |
| ![The panel next to a new message, light](screenshots/composer-panel-the-anthropic-mock-light.png) | ![A proposal, marked against the message](screenshots/composer-proposal-the-anthropic-mock-light.png) |
| ![The panel, dark](screenshots/composer-proposal-the-openai-mock-dark.png) | ![Writing an empty message](screenshots/composer-write-light.png) |
| ![The right-click menu on selected text in the composer](screenshots/composer-context-menu-light.png) | ![Spelling fixes, dark](screenshots/composer-grammar-dark.png) |
| ![The panel next to an open message](screenshots/reader-panel-light.png) | ![A summary, dark](screenshots/reader-summary-dark.png) |
| ![Reply ideas](screenshots/reader-replies-light.png) | ![The right-click menu on a passage of a message](screenshots/reader-context-menu-light.png) |
| ![The bar on a phone](screenshots/reader-bar-phone-light.png) | ![The dialog in a phone's composer](screenshots/composer-dialog-phone-light.png) |
| ![A rate limit](screenshots/composer-rate-limit-light.png) | ![Settings, dark](screenshots/settings-own-key-dark.png) |
