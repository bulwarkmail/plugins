# Email to task

Turn a message into a task. The plugin fills in the title from the subject, a
description with the sender, the date and a link back to the message, a due
date it finds in the text ("by Friday", "until 2026-10-20", "bis zum 20.10.")
and a priority from urgent markers. You check it, change what you like and
create it in one of these:

- **Tasks (Bulwark)**: the webmail's own tasks, kept in your calendars on the
  mail server. Only offered when the server has them.
- **Vikunja**, with an API token.
- **Todoist**, with an API token (API v1).
- **Donetick**, with an access token. Its API has no projects and no
  priority, so the dialog asks for neither.
- **A CalDAV task list** (Nextcloud, Stalwart, Radicale, Baïkal, ...), with
  your user name and password or an app password.

![The dialog, light](screenshots/dialog-light.png)
![The dialog, dark](screenshots/dialog-dark.png)

## Where to find it

- **Message toolbar**: "Create task" while a message is open.
- **Message rows**: the hover button, and the right-click menu (the long-press
  menu on phones).
- **Selection toolbar**: "Create tasks" makes one task per selected message
  (up to 25 at once). Each message keeps its own title and due date; you can
  untick the ones you don't need.
- **Keyboard**: Alt+Shift+T creates a task from the open message.

![Several messages at once](screenshots/bulk-light.png)

Messages that have a task get a "Task" badge in the list, and opening the
dialog again for such a message says so (with a link to the task when the
service has one). Tasks deleted in the service are forgotten the next time,
except in Donetick, whose API can't tell a deleted chore from a finished one.

![The badge in the list](screenshots/badge-light.png)

After creating, the plugin can mark the message: add the keyword `$task`
(the default; other mail apps can filter on it), mark it as read, both, or
leave it alone. The choice sits at the bottom of the dialog and is
remembered, together with the last service and project you used.

## Due dates

A date counts only after a deadline word: by, until, till, due, before,
deadline, no later than, within / bis, spätestens, fällig, Frist, innerhalb,
binnen. Dates in a message that aren't deadlines (when it was sent, a meeting)
are left alone. Understood forms, in English and German:

- `2026-10-20`, `20.10.2026`, `20.10.26`, `20.10.`, `20 October`, `October 20, 2026`,
  `3. November`, `10/20/2026` (slash dates only when they can't be read two ways)
- `Friday`, `next Friday`, `nächsten Freitag`, `today`, `tomorrow`, `morgen`,
  `übermorgen`, `end of the week`, `Ende des Monats`, `Monatsende`,
  `end of November`, `next week` (its Monday), `in 3 days`, `innerhalb von 5 Tagen`

Relative dates count from when the message arrived, not from today. The
subject is read first, then the message's own text; quoted replies are
skipped, so an old "by Monday" further down doesn't count. The dialog shows
the words it used ("Found in the message: “by Friday”").

Vikunja and Donetick have no date-only due dates; the plugin sets 12:00
local time, as Vikunja's own quick add does.

## Priority

The dialog uses the webmail's four levels (none, low, medium, high). "High"
is suggested for messages marked urgent (`X-Priority: 1`/`2`,
`Importance: high`) or with urgent, ASAP, important, dringend, eilig or wichtig
in the subject; "low" for `X-Priority: 4`/`5` or `Importance: low`. Mapped to
each service: Bulwark and CalDAV 1/5/9, Vikunja 3/2/1, Todoist p1/p2/p3.
Donetick's API takes no priority.

## Setup

Install the zip in the admin dashboard. Users connect their own accounts the
first time they pick a service; the webmail's own dialog asks for the token or
password, which is stored on the server and never reaches the plugin.

Optional admin settings:

| Setting | What it does |
| --- | --- |
| `vikunjaUrl` | Suggested Vikunja address, e.g. `https://tasks.example.com` (a sub-path works) |
| `todoistApiUrl` | Todoist API address; only for a proxy or a test server. Default `https://api.todoist.com/api/v1` |
| `caldavUrl` | Suggested CalDAV address: the server, a principal or a task list |
| `donetickUrl` | Suggested Donetick address, e.g. `https://donetick.example.com` |

CalDAV task lists are found automatically (current user principal, calendar
home, calendars that take tasks). Lists made only for tasks come first. If
nothing is found, the dialog asks for the address of a task list.

## Permissions and data

| Permission | Why |
| --- | --- |
| `email:read` | Read the message the task is made from (subject, sender, text) |
| `email:write` | Mark the message afterwards (keyword `$task` or read) |
| `email:render-takeover` | The "Task" badge on message rows (the host gates its row-badge hook with this permission) |
| `tasks:read`, `tasks:write` | Find out whether the server has tasks, and create them there |
| `http:proxy` | Talk to Vikunja, Todoist, Donetick and CalDAV through the webmail's server, which adds the token or password |
| `ui:message-list`, `ui:toolbar` | The buttons on rows, the selection toolbar and the message toolbar |
| `ui:observe` | The dialog |
| `ui:keyboard` | Alt+Shift+T |
| `admin:config` | Read the admin settings above |

Credentials (`credentials` in the manifest): `vikunja` (bearer token),
`todoist` (bearer token), `caldav` (basic auth) and `donetick` (the token in
the `secretkey` header), all per user, server chosen by the user.

Nothing leaves the webmail until you press "Create". Then the title,
description (by default the sender, the date, the link and the first 600
characters of the message's own text; you see and can edit all of it in the
dialog), due date and priority go to the service you chose. The plugin keeps,
in its storage in your browser, which messages have which task (id, title,
link), at most 2000 messages, and your last choices in the dialog.

## Errors

Failures are shown in plain words inside the dialog: a rejected or expired
token or password (with "Connect again"), missing rights on a project, a
deleted project or list, full storage, rate limits (with the wait time the
service sent), time-outs, unreachable or blocked servers. With several
messages, the ones that worked are created and the others stay in the dialog
with what went wrong; after a rejected token or a rate limit the rest are not
tried.

![A refused task, dark](screenshots/error-dark.png)

## Known limits

- "Archive the message" isn't offered: plugins can't move messages yet.
- The plugin's settings live in the dialog, not in the plugin's settings page,
  because the settings page doesn't translate plugin setting labels.

## Development

```
node scripts/build.mjs email-to-task
node node_modules/vitest/vitest.mjs run email-to-task
BULWARK_ADMIN_PASSWORD=... node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.mjs email-to-task/e2e
```

The end-to-end tests need the webmail and the services from `test-env`
(Vikunja, the Todoist mock, Stalwart's CalDAV and tasks). They import their own
messages into alice's inbox and remove the messages and tasks afterwards.
