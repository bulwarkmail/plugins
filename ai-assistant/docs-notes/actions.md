# Docs notes: more actions (package C, plugin side)

For the lead to merge into the website's features/ai-assistant.md (user
page and "For administrators"). The host API reference part is the
lead's.

## For users

With actions on (Settings > AI Assistant > Actions), the assistant can
also do these things for you, on a webmail that offers them:

- **Answer an invitation**: accept, maybe or decline the invitation in
  the open message (or one it found). Bulwark sends your answer to the
  organiser right away, so there is no Undo; answer again to change it.
- **Change an event**: its title, start and end, place, description, or
  whether it lasts all day. It never changes who is invited. Undo writes
  the old values back.
- **Delete an event**: only a single event you created. A repeating
  event, one occurrence of it, or an event someone else invited you to:
  "Delete repeating events in the calendar." Undo brings the event back.
- **Tag a message** or take a tag off, by the tag's name.
- **Out-of-office reply**: turn it on with a subject, a text and,
  if you like, the first and last day; or turn it off. While your
  out-of-office forwards mail, the assistant leaves it alone: "Your
  out-of-office forwards mail. Change it in Settings > Out of office."
  Undo puts the old reply back.
- **Create a filter** for new mail: when the sender, recipient, Cc,
  subject, text, a header, the size or an attachment matches, move or
  copy the message to a folder, mark it as read, star it, tag it, or stop
  other filters. The card shows the rule in plain words ("If the sender
  is “newsletter@shop.example”: move to “Newsletters”, mark as read").
  There is no filter that forwards, redirects, rejects or deletes mail,
  and none that moves mail to the trash. Undo removes the filter.
- **Many messages at once**: archive, move, mark read or unread, tag or
  untag the messages of a search or a list. The card shows how many and
  the first five subjects. More than your administrator's limit (50
  unless set) is refused. Undo puts them back.
- **Change a setting** of the app ("Change Time format: 12-hour →
  24-hour?"), only when your administrator allows it and you turn it on.
  Settings your organisation set stay as they are ("This setting is set
  by your organisation."); some settings the assistant can never change
  ("The assistant can't change this setting."). Undo writes the old value
  back.
- **Change a contact**: name, email addresses, phone numbers, company,
  postal address. Undo puts the old card back.

It can also read your out-of-office reply and your filters when it needs
them (with lookups on).

Answering an invitation, deleting an event, the out-of-office reply,
filters, many messages at once, settings and contacts always ask you
first, even in automatic mode. Changing an event and tags follow your
mode (ask first or automatic).

Settings > AI Assistant > "What the assistant may change" has a switch
for each group: answer invitations, change and delete events, tag
messages, out-of-office reply, create filters, act on many messages at
once, change my settings, change contacts. All are on except "Change my
settings", which is off until you turn it on and greyed out unless your
administrator allows it. A switch is hidden when your webmail doesn't
offer what it needs.

## What is sent to the AI service

The privacy notice adds: "It may also send your out-of-office reply,
your filter rules, the names of your tags and the settings it reads or
changes."

| When you | What is sent |
| --- | --- |
| Ask about or change your out-of-office reply | Whether it is on, its dates, subject and text, and whether it forwards mail |
| Ask about or create a filter | Your filter rules: names, conditions, what they do (folder and tag names, and the address of a forwarding rule) |
| Tag messages, or file or tag many at once | The names of your tags and folders, and how many messages changed |
| Change a setting (when allowed) | The setting's name and its old and new value, or why it can't be changed |
| Change an event, a contact or answer an invitation | The event's title and time, the contact's name, addresses, phones, company and postal address, the invitation's title and organiser |

## For administrators

| Setting (configSchema key) | What it does |
| --- | --- |
| More actions (`allowMoreActions`, on) | Offers the actions and lookups above. Off hides them, their switches and the privacy sentence |
| Change settings (`allowSettingsChanges`, off) | Lets users turn on "Change my settings". Never account, security, sharing, forwarding or plugin settings, and never one your policy locks |
| Most messages per batch (`batchLimit`, 50) | 1 to 200. A batch over the limit is refused before the user is asked |

The Actions setting (`actions`: off, ask first, automatic) still caps
what users can choose; the actions that always ask first do so in every
mode.

## Plugin internals (for WRITING_PLUGINS.md examples, if wanted)

- Tool names and arguments: `answer_invitation {emailId?, status}`,
  `update_event {id, title?, start?, end?, location?, description?, isAllDay?}`,
  `delete_event {id}`, `tag_message {id, tag}`, `untag_message {id, tag}`,
  `set_vacation {subject, text, from?, to?}`, `turn_off_vacation {}`,
  `create_filter {name?, match?, conditions[], actions[]}`,
  `batch_messages {ids[] | search{text?, from?, subject?, after?, before?, folder?}, action, folder?, tag?}`,
  `change_setting {key, value} | {changes}`, `update_contact {id | query, name?, emails?, phones?, company?, address?}`;
  lookups `get_vacation {}`, `list_filters {}`.
- User switches: `prefs.doActions = { invitations, events, tags, vacation, filters, batch, settings, contacts }`
  (booleans; missing means on, except `settings`).
- Host checks: `answerInvitation` (calendar.respond), `filterRules`
  (filters.list / create / undo), `batchMail` (email.batch / undoBatch),
  `changeSettings` (app.describeSettings / setSettings / undoSettings);
  delete_event needs `calendar.undoDelete`; the out-of-office needs
  vacation.get to return `forwardActive`.

## Host API (webmail, for WRITING_PLUGINS.md "API reference" and guides/plugins.md)

New in the webmail with the AI assistant 2.2 work. Every call is announced
by a flag in `api.host.features` (missing, so false, on older webmails);
check `api.host?.features?.<flag> === true` and `typeof api.<ns>.<fn> === 'function'`.
Undo tokens are random strings the host keeps for 30 minutes, bound to
the plugin and the signed-in account; each works once. The host never
re-creates anything a plugin hands it.

```js
// Flag answerInvitation. Permission calendar:respond (new, high risk; list it
// in optionalPermissions so older webmails still install the plugin).
await api.calendar.respond(emailId, 'accepted' | 'tentative' | 'declined')
//   → { status, title, start, organizer } or null (another plugin stopped it)
await api.calendar.deleteEvent(id)       // → { undoToken } (null when it can't be undone)
await api.calendar.undoDelete(undoToken) // → { id } of the event created again (calendar:write)

// Flag filterRules (the server has Sieve). filters:read / filters:write.
await api.filters.list()   // → { supported, editable, rules: [{ id, name, isActive, editable, match, conditions, actions }] }
await api.filters.create({ name, match: 'all' | 'any', conditions: [{ field, op, value, headerName }], actions: [{ type, mailboxId, tagId }] })
//   → { id, undoToken }
await api.filters.undo(undoToken)

// Flag batchMail. email:write.
await api.email.batch({ emailIds, action: 'archive' | 'move' | 'read' | 'unread' | 'tag' | 'untag', mailboxId, tagId })
//   → { done, failed, undoToken }
await api.email.undoBatch(undoToken)

// vacation.get (vacation:read) now also returns forwardActive: true while
// the out-of-office forwards mail (set in Settings > Out of office).

// Flag changeSettings.
await api.app.describeSettings({ key: value } | [key])  // settings:read
//   → { key: { key, label, page, pageLabel, current, currentLabel, next, nextLabel, allowed, reason, options } }
await api.app.setSettings({ key: value })  // settings:change (new, high risk, optional)
//   → { applied: { key: { old, new } }, refused: { key: reason }, undoToken }
await api.app.undoSettings(undoToken)      // → { restored: [key], refused: { key: reason } }
```

- **calendar.respond** answers an invitation in a message of the user's own
  account the way the reader's banner does (lib/calendar-rsvp.ts, shared by
  both): the calendar store writes the answer with scheduling on, so the
  server sends the reply to the organiser, and plugin calendar hooks run.
  When the event isn't in the calendar yet it is added first. Refused: a
  message with no invitation or one that asks no answer (a reply, a
  cancellation), an event the user organises, an invitation whose sender
  doesn't match its organiser and isn't authenticated, mail of a shared or
  group mailbox (answer those in the reader), while invitations are
  switched off in Settings > Calendar, and without a calendar.
- **calendar.deleteEvent** works as before (one occurrence for an
  occurrence's id; never sends cancellations). It now returns an undo token
  for a single event of the user's own calendars; repeating events, their
  occurrences and events in shared calendars get none.
- **filters.create** checks the rule the way the rule editor does (a name, 1
  to 10 conditions, 1 to 10 actions, a valid header name, a size in bytes)
  and refuses any action other than move, copy, mark_read, star,
  add_label and stop: forward, redirect, reject, discard and keep are
  refused by name. Move and copy go only into folders of the filters' own
  account that nobody else shares, never the trash. add_label takes one of
  the user's tags (keywords.list). The rule goes at the top; a script edited
  by hand is not changed (list says editable: false). Settings > Filters
  shows the rule at once. filters.undo puts the script back as it was, and
  refuses when it changed since.
- **email.batch** changes up to 200 messages of the signed-in account in
  one go, through the app's own batch functions (their plugin hooks run,
  the list updates): archive follows the user's archive mode (single, by
  year, by month) and makes the Archive folder when there is none; move
  only into the account's own folders that nobody else shares, never the
  trash; tags are the user's tags. Messages not found count as failed.
  Archive and move count as one call against the move limit (20 a minute).
  The batch is one entry in the app's undo history, so Ctrl+Z undoes it
  too; undoBatch and Ctrl+Z run the same undo once. Undo puts every message
  back in its folders with its read state, or puts the read state or tag
  back on exactly the messages that changed.
- **app.describeSettings / setSettings** work on the allow-list in
  lib/settings-schema.ts (about 150 settings: appearance, language and
  formats, message list, reading, composing, notifications, calendar view,
  contacts view, accessibility). Never: remote content, trusted senders,
  signature details, push relay, the download templates, security,
  identities, sync, debug, and values that delete, send mail or turn off a
  delete safety net (deleteAction "permanent", readReceiptResponse
  "always", confirmDelete and confirmBulkDelete off, permanentlyDeleteJunk
  on, postExportAction "trash"). At the moment of the change it also
  refuses: a setting the admin locked or hid, a value outside the admin's
  restriction, a row a feature gate or no-third-party mode hides. Reasons:
  unknown, not_allowed, bad_value, locked, hidden, unavailable, stopped
  (another plugin's onBeforeSettingChange said no). Writes go through the
  setters the settings pages use, so the open page shows the change and it
  syncs. undoSettings writes the exact old value back, even one setSettings
  wouldn't offer, but not to a setting the admin has locked since.
- app.getSettings (settings:read) now also returns every setting
  setSettings may change, and calendarView.

New permissions and their texts (Settings > plugins consent dialog):
- calendar:respond: "Answer invitations / Accept or decline calendar
  invitations. Your answer goes to the organiser by email."
- settings:change: "Change your settings / Change how the app looks and
  works, such as the theme, the time format or the reading pane. Settings
  your organisation set stay as they are."
- settings:write reworded: "Change your tags / Add, rename and reorder your
  tags, and stop changes to your settings."

Webmail fixes on the way: Settings > Composing shows the admin's locks for
plain text, picking the reply identity and how it matches; "Permanently
delete junk" now syncs between devices.
