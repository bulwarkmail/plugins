# Changelog

## Unreleased

## 2.0.0 (2026-11-01)

### Added
- Admins can check links when they are clicked: with their own link check service (a small JSON contract, see the README), Google Safe Browsing, or both
- The dialog says what the check found, warns strongly about unsafe links, and points out link text that names another domain than the link goes to
- Admins choose what happens when a link can't be checked (let users continue, the default, or don't open it) and whether unsafe links can still be opened
- The dialogs come in all 30 languages Bulwark ships

### Changed
- Needs Bulwark 1.20.0 or later
- Reads the admin settings without any secret fields, and needs no admin permission any more
- Keeps working when Bulwark's no-third-party mode is on; only Google Safe Browsing is off then
- German texts use the formal "Sie"
- Checks, shows and opens the address the browser really opens: a backslash before an @ or an international domain can't make it check another site than the one that opens
- The first click after the plugin starts stays within the 3-second budget, settings included, so the link isn't blocked as a popup
- Trusted domains match international domains in either form, and link text that is a file name ("report.pdf") isn't taken for a domain

## 1.3.1 (2026-10-31)

### Added
- Screenshots in the extension directory
