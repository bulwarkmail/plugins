# Changelog

## Unreleased

## 2.0.0 (2026-11-01)

### Added
- Admins can check links when they are clicked: with their own link check service (a small JSON contract, see the README), Google Safe Browsing, or both
- The dialog says what the check found, warns strongly about unsafe links, and points out link text that names another domain than the link goes to
- Admins choose what happens when a link can't be checked (let users continue, the default, or don't open it) and whether unsafe links can still be opened

### Changed
- Needs Bulwark 1.20.0 or later
- Reads the admin settings without any secret fields, and needs no admin permission any more
- Keeps working when Bulwark's no-third-party mode is on; only Google Safe Browsing is off then
- German texts use the formal "Sie"

## 1.3.1 (2026-10-31)

### Added
- Screenshots in the extension directory
