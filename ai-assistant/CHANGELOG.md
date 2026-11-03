# Changelog

## Unreleased

## 2.2.0 (2026-11-03)

### Added
- Reads the open message's attachments (PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV, HTML, calendar and contact files), its pictures when the model can see images, the whole conversation and the messages ticked in the list. Type @ to add a message, contact or file to the question
- Admins choose per service whether its model gets images; users with their own key set it themselves. A photo's date and place go only with a user switch, off by default
- More actions: answer invitations, change and delete events, tag messages, set the out-of-office reply, create filters, archive, move, mark or tag many messages at once, change a contact, and change app settings when the admin allows it and the user turns it on. All but changing events and tags ask first in every mode, and Undo puts things back
- Files: find, read and attach files, save attachments to Files, create notes and folders, replace a text file (the old version goes to the Files trash), move and rename. It never deletes or shares a file
- Earlier chats: after 8 hours away the panel starts a fresh chat and keeps the old one to search, continue, rename or delete
- Saved prompts from the user and the admin, / commands, Edit and Answer again, notes the assistant remembers, and message templates
- The assistant sits next to Calendar, Contacts, Files and Settings too, knows what is open there, and opens with Alt+A in every view, also next to a message
- Catch me up lists unread mail since your last visit, today's events, open tasks and sent mail still waiting for a reply
- The suggestions of "Check spelling and grammar" also show as underlines in the message, where proofreading is on. Picking one there puts it in; accepting or keeping one in the panel removes its underline
- Admin switches for each group (More context, More actions, Change settings, Files, Chat tools, Remember notes, Every view), the batch limit and prompts for everyone

### Changed
- It's called "AI assistant" everywhere, the composer included
- The privacy notice names everything that goes to the AI service, so users confirm it once more
- Quick actions say what they do ("Summarize") and name the part they work on only for highlighted or selected text. Right-click Translate… asks for the language
- The reader has one button for the panel, the webmail's, at the end of the toolbar
- New features need Bulwark 1.20. On 1.19.1 the plugin installs and keeps the panels, quick actions, lookups, actions, chat tools, @ mentions, Catch me up in Mail, and changing events, tags and contacts. It asks for its three new permissions as optional ones, so older webmails still install it

### Security
- A message or file that tells the assistant to forward mail, add a forwarding filter or share files leads to nothing, and a draft to an address the user didn't name asks first

### Fixed
- "Today" and "tomorrow" follow the user's time zone: shortly after midnight the assistant no longer took the day before for today, and events show under their local day
- The context chip stays readable at every panel width, and its x never covers the text
- The panel's header is as tall as the app's toolbars and doesn't jump when the first answer arrives
- The Actions menu stays when no message is open and in an empty draft
- After a message is taken out of the chat, the panel shows where it left and names it on the chip that adds it back
- "Thinking…" no longer shows while the privacy notice waits for an answer
- Replies open for the message an answer was about; with no message open the text becomes a new email
- Escape closes the reader panel and the language picker
- A failed action says why in the user's language, every lookup has a label, and the undo hint says Cmd+Z on a Mac
- Saved chats stay small, and a full storage says so
- A server that blocks the AI service's address says so, instead of "isn't set up yet"
- Long lookups no longer fail with Anthropic, and a model that keeps calling tools no longer stops the assistant

## 2.1.3 (2026-10-31)

### Added
- Screenshots in the extension directory
