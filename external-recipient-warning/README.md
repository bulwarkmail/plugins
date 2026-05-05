# External Recipient Warning

Intercepts outgoing email and asks the user to confirm before delivering to
addresses outside the safe-domain list. Useful as a guardrail against
auto-complete mistakes (`alice@compettior.com`) and reply-all leaks.

## Safe-domain sources

Three sources are merged (de-duplicated):

1. **Admin-managed list** — written to plugin admin config under
   `safeDomains`. Set via:
   ```
   PUT /api/admin/plugins/external-recipient-warning/config
   { "key": "safeDomains", "value": "example.com, partner.com" }
   ```
   Accepts a comma/newline-separated string or a JSON array.
2. **Per-user list** — `Additional safe domains` field in the plugin's
   settings panel.
3. **Sender's identity domain** — when `Trust your sending identity's
   domain` is enabled (default), the domain of the active From address is
   treated as safe automatically.

Subdomains are matched automatically: trusting `example.com` also covers
`eu.example.com`.

## Settings

| Key | Default | Effect |
| --- | --- | --- |
| `safeDomainsCsv` | empty | Per-user safe-domain list. |
| `treatIdentityDomainAsSafe` | `true` | Auto-trust the From address's domain. |
| `warnOnCcBcc` | `true` | Also flag external Cc/Bcc, not just To. |

## Permissions

- `email:send` — required by `onBeforeEmailSend`.
- `admin:config` — read the admin-managed safe-domain list.

## Hooks used

- `onBeforeEmailSend` — intercept hook. Returning `false` from any handler
  cancels the send before it reaches the JMAP / S/MIME pipeline.

## Behaviour

The hook receives the prepared `OutgoingEmail` (recipients, subject,
body preview, identity, `fromEmail`). The plugin classifies each address
in `to` / `cc` / `bcc` against the merged safe-domain list. If everyone
is safe, the hook passes through silently. Otherwise a confirmation
modal is shown listing the external recipients grouped by field.

The host enforces a 5 s timeout on intercept hooks. The modal therefore
auto-resolves to **Cancel** after 4.5 s if the user has not responded —
this is fail-closed behaviour appropriate for a security feature. Users
can simply click Send again.

## Build & install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../external-recipient-warning.zip manifest.json index.js
```

Upload `external-recipient-warning.zip` via Admin → Plugins.

## Notes

- The dialog is plain DOM (no React) so the bundle stays tiny and the
  plugin has zero runtime dependencies.
- Dark mode is detected via the host's `.dark` class on `<html>` plus a
  luminance fallback so third-party themes are also covered.
- Pressing **Esc** or clicking the overlay cancels; **Enter** sends. The
  Cancel button is the default focus target on purpose — confirming an
  external send should require intent, not muscle memory.
