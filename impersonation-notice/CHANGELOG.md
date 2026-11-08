# Changelog

## Unreleased

## 1.5.0 (2026-11-08)

### Added
- A "Return to my account" button in the banner. On Bulwark releases after 1.21.0 it ends the impersonation and signs the admin back in to the accounts they had open before, when the webmail still holds that session. Bulwark's own return strip then stays away, so the button isn't there twice. It needs the new optional `auth:impersonation-return` permission; older webmails install the plugin without it and show the banner as before. "Back to platform" still signs out.

## 1.4.2 (2026-10-31)

### Added
- Screenshots in the extension directory

## 1.4.1 (2026-10-31)

### Fixed
- Since Bulwark 1.11.1 an impersonated session signs in with the plain mailbox, so the banner never showed. It now also shows when the host passes `impersonated: true` with the username, which newer Bulwark versions do. On hosts without that flag it still looks for `%` in the username.
