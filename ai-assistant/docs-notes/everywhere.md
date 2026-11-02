# Docs notes: the assistant everywhere (package F)

## Host API (WRITING_PLUGINS.md "API reference" and guides/plugins.md "APIs")

New slot `app-side-panel` (area app, kind frame, fillable), new permission
`ui:side-panel`, flag `api.host.features.sidePanel` (webmail 1.20). The flag
is per plugin: true when this plugin may show the panel (ui:side-panel
granted), false when the webmail has the panel but the plugin lacks the
grant (enabled before an update added it: turn it off and on), missing on
older webmails.

```js
// manifest.json
"optionalPermissions": ["ui:side-panel"]   // older webmails skip it and install the plugin
// index.js
slots: { 'app-side-panel': { component: Panel, fill: true, startFolded: true, shouldShow } }

await api.ui.openPanel('app-side-panel')    // true: open; false: no room here, the plugin got onAction 'open'; null: no such panel on screen (Mail)
await api.ui.closePanel('app-side-panel')
await api.ui.togglePanel('app-side-panel')
```

- Where: a side panel next to Calendar, Contacts, Files and Settings, under
  a button at the end of each view's h-14 toolbar row, at the same place
  as the reader's panel button. Calendar: after the view menu. Files:
  right after the details button (the two panels take turns: opening one
  folds the other). Contacts: a row over the open contact with its name.
  Settings (1024 px and wider): a row over the page with its name. Mail
  keeps `email-detail-sidebar`. Not in the Pro shell's panes.
- Shown only for a plugin whose `shouldShow` for the slot says yes (asked
  with `{ view, context }`); until it answers, no button.
- The button (reader and views): one name, "Plugin panel", with
  `aria-pressed`; a plugin shortcut with the id `toggle-panel` is named in
  its title and `aria-keyshortcuts`. The open panel is a `complementary`
  landmark named after its plugin. Closing it with the focus inside gives
  the focus back to the button.
- Resizing stops where the view keeps 480 px, so it never folds mid-drag.
- Files: while its details panel is open the assistant panel steps aside
  there only (the stored choice for the other views stays).
- Width 200 to 500 px (default 280), folded state and width shared by the
  four views (localStorage `appSidePanelCollapsed`, `appSidePanelWidth`).
  When the view would get narrower than 480 px it folds, and opened anyway
  it lies over the view. `startFolded` holds until the user chooses.
- Props: `{ view, context, focusRequest }`. `view` is `'calendar' |
  'contacts' | 'files' | 'settings'`. `focusRequest` counts up when the
  panel opens on request (its button, api.ui.openPanel). `context` is what
  the view shows; each field only with its permission:
  - `event: CalendarEventView` (calendar:read): the event open in the
    details or the editor.
  - `contact: ContactView`, `selectedCount: number` (contacts:read).
  - `files: FileResourceView[]` (at most 20), `fileCount: number`,
    `folder: { id, path }` (files:read): the selection and the open folder.
  - `page: { id, label }` (no permission): the open settings page.
  Fields the catalogue doesn't name never reach a plugin (new: the slot
  catalogue's `fields` map filters parts of an object prop per permission).
- Phones, and Settings below 1024 px: no panel. The phone header shows a
  panel button that sends the plugin `onAction({ surface: 'app-side-panel',
  actionId: 'open', context: { view, context } })` (context cut to the
  plugin's permissions as above); the plugin opens its dialog
  (`api.ui.openDialog({ slot: 'plugin-dialog', fill: true, extraProps: { view, context } })`).
  In Contacts the button also sits over an open contact.
  `api.ui.openPanel` / `togglePanel` there answer `false` and send the same
  onAction to the plugin that asked; `closePanel` answers `false`.
- Older webmails: `ui:side-panel` is unknown, so put it into
  `optionalPermissions`; `api.host.features.sidePanel` is missing and
  `openPanel('app-side-panel')` throws "is not a panel".
- Also fixed: the sandbox runtime now passes every assistant flag of
  `api.host.features` to the plugin (it copied only the three policy flags).

New option of `api.ui.openDialog` (webmail 1.20; older ones ignore it):

```js
await api.ui.openDialog({ slot: 'plugin-dialog', title, fill: true, extraProps })
```

With `fill: true` the frame fills the dialog, which is as tall as the
visible window allows (90 %, at most 640 px, following a phone's keyboard),
instead of growing with its content. The slot's root is then as tall as
the frame (like a fillable panel slot).

Permission text (webmail locales, `plugins.permissions.ui_side_panel`):
"Add a panel to other views" / "Show its own panel next to Calendar,
Contacts, Files and Settings."

## User page (features/ai-assistant.md)

From webmail 1.20 the assistant also sits next to Calendar, Contacts, Files
and Settings. The panel button at the end of the toolbar row, or Alt+A,
opens it. It is the same chat as in Mail and knows what you have open: the
event, the contact, the selected files and folder, or the settings page
(a chip in the input says which). The Actions menu offers what fits:
What's on this week? (Calendar), Last mails with the open contact,
Summarize this file (one selected file, with the Files lookups), Explain
this page (Settings). On phones and in Settings below 1024 px the header's
panel button opens the assistant as a dialog that fits above the keyboard
(in Contacts the button also sits over an open contact).

Catch me up (Actions menu, and a button in the empty panel when no message
is open; only while lookups are on): unread inbox mail since your last visit, sorted into "needs an
answer" and "for your information", today's events, open tasks due today
or earlier, and sent mail of the last week nobody answered (webmails that
read whole conversations). The last visit is when the webmail was last
open before this time (noted every few minutes while it is open), or the
last Catch me up; the first time, the last day.

Alt+A outside the composer toggles the panel of the view you are in
(Calendar, Contacts, Files, Settings), else the one next to the message.
The composer keeps its own Alt+A.

What is sent to the AI service:
- Asking in Calendar, Contacts, Files or Settings: what you have open there:
  the event (title, time, place, participants, description), the contact
  (name, addresses, phones, company, dates, notes) and how many contacts
  are ticked, names, types, sizes and dates of up to 20 selected files and
  the folder path, or the settings page's name.
- Catch me up: unread inbox mail since the last visit (sender, recipients,
  date, subject, preview, message id), today's events (time, title, place),
  open tasks (title, due date) due today or earlier, sent mail of the last
  week waiting for a reply (same fields as the unread mail). These go with
  that one request as data in its system prompt; the chat keeps only the
  request "Catch me up" and the answer with its cards.

Privacy notice sentences (plugin locale keys `view.privacy`, `brief.privacy`),
in the notice whenever the area is on (it is asked once per service, maybe
first in Mail): "In Calendar, Contacts, Files and Settings it also sends
what you have open there: the event, the contact, the names, types, sizes
and change dates of the selected files and the folder, or the settings
page." / "Catch me up also sends your unread mail since your last visit
(sender, recipients, date, subject, first lines and message id), today's
events, your open tasks and the sent mail of the last week that is waiting
for a reply."

User settings ("Other views and Catch me up", shown while the admin allows
the area): Show in Calendar, Contacts, Files and Settings (webmails with
the side panel; without the grant a line says to turn the assistant off and
on in Settings > Add-ons); Offer Catch me up; Look for mail waiting for a
reply (webmails that read conversations).

## Admin settings

`allowEverywhere` (boolean, default on): "Every view". Off hides the panel
in Calendar, Contacts, Files and Settings, Catch me up and the user
settings above.
