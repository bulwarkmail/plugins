# Team inbox

Assign messages in a team mailbox (a Stalwart group account) to a member
and mark them done. Everyone in the team sees the same state.

In a team mailbox's folders, users get:

- **Assign to me**, **Assign to…**, **Unassign**, **Mark done** and
  **Reopen** in the message's right-click menu, its hover buttons and the
  reader toolbar (the row menu and the reader's More menu on phones). Each
  shows only when it applies: Reopen on done messages, Unassign on assigned
  ones.
- A chip with the assignee's name and a **Done** mark on list rows.
- **Assigned to me** and **Open** filters in the list header. Open means not
  marked done.

Nothing shows in the user's own mailbox or in a mailbox another person
shared.

Needs Bulwark 1.19 or later. Install it in the admin panel (Extensions >
Plugins) and turn on "Enabled for everyone" to give it to every user; it
has no settings.

## How it is stored

On the message, as keywords, so other members and other clients see it:

| Keyword | Meaning |
| --- | --- |
| `$assigned:<principal id>` | Assigned to that member. One at a time. |
| `$done` | Dealt with. |

The principal id is the member's Stalwart account id (for example `cj`).
IMAP clients show the keywords as flags.

Reading a message in a team mailbox marks it read for the whole team
(Stalwart keeps one read state per group account), so "Open" is driven by
**Mark done**, never by read state.

## Names

The keywords carry ids, so the plugin needs names for them:

- the user's own name comes from their session;
- other people come from the server's directory when the administrator
  allows directory lookups (off by default on Stalwart 1.0);
- on Stalwart 1.0 and later the plugin keeps a small list of names in the
  team mailbox's Inbox metadata (`org.bulwarkmail.plugin.team-inbox`, under
  3.5 KB, oldest names dropped first): each member who uses the plugin adds
  themselves, and whoever assigns adds the assignee.

Without either, another member shows as "Assigned" until a name is known.
"Assign to…" offers the user, people messages were assigned to lately, the
names list and directory matches. A typed address can only be assigned when
the directory or the names list knows it.

## Limits

- No notification to the assignee: a plugin can't send push notifications.
  Members see their work with the "Assigned to me" filter.
- Only in group accounts. Mailboxes a person shared with someone else don't
  count as team mailboxes.
- Not in Bulwark Lite, which has no plugins.

## Permissions

| Permission | Why |
| --- | --- |
| `email:read` | Row badges, and the message's keywords before a change. |
| `email:write` | Set and clear the keywords; keep the names list. |
| `account:read` | The user's own id, and which accounts are team mailboxes. |
| `directory:read` | Names for the ids on rows, and finding people in Assign to, where the server allows directory lookups. |
| `ui:message-list` | The buttons on message rows and the list filters. |
| `ui:toolbar` | The buttons in the reader toolbar. |
