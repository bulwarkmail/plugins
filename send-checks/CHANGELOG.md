# Changelog

## Unreleased

### Added
- First release. Before a message is sent, checks the subject, the text the user wrote and text attachments for IBANs (mod-97 check), payment card numbers (Luhn check), keywords and the admin's own patterns, and checks attachment types (by extension and by content) and sizes. Each rule warns or blocks, and can count only when the message goes outside the organisation. Matches are shown masked. Runs for the composer, quick reply and plugin forwards (Bulwark 1.20 and later).
