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
