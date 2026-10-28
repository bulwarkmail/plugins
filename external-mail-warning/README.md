# External Mail Warning

> **Replaced by Bulwark.** From Bulwark 1.19, admins turn on an "External"
> label for mail from outside the organisation and a confirm before sending
> outside it in the admin panel, under Organisation > Security > External
> mail. They can be set per domain or group, and they work in Bulwark Lite.
> While either is on, this plugin does nothing (version 1.6.0 and later
> read `api.host.features.externalMailWarnings`; Bulwark also skips the
> hooks of older copies). To move over:
>
> 1. In Organisation > Security, click **Import from the plugin** to copy
>    the plugin's admin safe-domain list, then save.
> 2. Turn on the label, the confirm, or both.
> 3. Remove the plugin in Extensions > Plugins.
>
> Two things don't carry over: each user's own safe domains
> (`safeDomainsCsv`), and the banner for failed SPF, DKIM or DMARC checks.
> Bulwark shows its own "Unverified sender" warning for those.
>
> On Bulwark 1.18 and older the plugin works as described below.

Intercepts outgoing email and asks the user to confirm before delivering to
addresses outside the safe-domain list. Useful as a guardrail against
auto-complete mistakes (`alice@compettior.com`) and reply-all leaks.

## Safe-domain sources

Three sources are merged (de-duplicated):

1. **Admin-managed list** — written to plugin admin config under
   `safeDomains`. Set via:
   ```
   PUT /api/admin/plugins/external-mail-warning/config
   { "key": "safeDomains", "value": "example.com, partner.com" }
   ```
   Accepts a comma/newline-separated string or a JSON array.
2. **Per-user list** — `Additional safe domains` field in the plugin's
   settings panel.
3. **Your identity domains** — when `Trust your sending identity's
   domain` is enabled (default), the domains of all your sending
   identities (and the active From address) are treated as safe
   automatically.

If no safe domain is known at all, incoming mail is not flagged as
external, because every sender would be. A failed SPF/DKIM/DMARC check
still shows the banner.

Subdomains are matched automatically: trusting `example.com` also covers
`eu.example.com`.

## Settings

| Key | Default | Effect |
| --- | --- | --- |
| `safeDomainsCsv` | empty | Per-user safe-domain list. |
| `treatIdentityDomainAsSafe` | `true` | Auto-trust your identities' domains. |
| `warnOnCcBcc` | `true` | Also flag external Cc/Bcc, not just To. |

## Permissions

- `email:send` — required by `onBeforeEmailSend`.
- `identity:read` — read your sending identities to trust their domains.
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
auto-resolves to **Cancel** after 4.5 s if the user has not responded,
this is fail-closed behaviour appropriate for a security feature. Users
can simply click Send again.

## Build & install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../external-mail-warning.zip manifest.json index.js
```

Upload `external-mail-warning.zip` via Admin → Plugins.

## Notes

- The dialog is plain DOM (no React) so the bundle stays tiny and the
  plugin has zero runtime dependencies.
- Dark mode is detected via the host's `.dark` class on `<html>` plus a
  luminance fallback so third-party themes are also covered.
- Pressing **Esc** or clicking the overlay cancels; **Enter** sends. The
  Cancel button is the default focus target on purpose, because confirming an
  external send should require intent, not muscle memory.
