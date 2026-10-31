# Changelog

## Unreleased

## 1.4.2 (2026-10-31)

### Added
- Screenshots in the extension directory

## 1.4.1 (2026-10-31)

### Fixed
- Since Bulwark 1.11.1 an impersonated session signs in with the plain mailbox, so the banner never showed. It now also shows when the host passes `impersonated: true` with the username, which newer Bulwark versions do. On hosts without that flag it still looks for `%` in the username.
