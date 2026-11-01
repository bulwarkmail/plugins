# Changelog

## Unreleased

## 1.0.0 (2026-11-01)

### Added
- First release. Before a message is sent, checks the subject, the text the user wrote and text attachments for IBANs (mod-97 check), payment card numbers (Luhn check), keywords and the admin's own patterns, and checks attachment types (by extension and by content) and sizes. Each rule warns or blocks, and can count only when the message goes outside the organisation. Matches are shown masked. Runs for the composer, quick reply and plugin forwards (Bulwark 1.20 and later).
- Fails closed: a blocking rule that couldn't be checked (patterns out of time, a pattern line that can't run, an attachment Bulwark couldn't read, settings that never loaded) stops the send; a warning rule that couldn't finish says so in the warning.
- The admin's patterns run in a Web Worker that is stopped after 250 ms per message, and patterns with nested or overlapping repeats are refused.
- Finds card numbers grouped with no-break or thin spaces and followed by the expiry date or security code, and leaves out phone numbers and numbers no card network uses.
- Catches shortcuts, cabinet files, installers and Java and Android apps renamed to a document name.
- In all 30 languages Bulwark ships.
