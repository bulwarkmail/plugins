# External Link Warning

Intercepts clicks on external links and asks the user to confirm before
navigating to a domain that isn't on the trusted list.

## Trusted-domain sources

The plugin merges three sources (de-duplicated):

1. **Admin-managed list** — written to plugin admin config under
   `trustedDomains`. Set via:
   ```
   PUT /api/admin/plugins/external-link-warning/config
   { "key": "trustedDomains", "value": "example.com, github.com" }
   ```
   Accepts a comma/newline-separated string or a JSON array.
2. **Per-user list** — `Trusted domains` field in the plugin's settings panel.
3. **Local "Always trust" choices** — added through the dialog checkbox,
   stored in plugin storage on the user's device.

Subdomains are matched automatically: trusting `example.com` also trusts
`docs.example.com`.

## Permissions

- `admin:config` — read the admin-managed trusted list.
- `ui:observe` (implicit) — required by `onBeforeExternalLink`.

## Hooks used

- `onBeforeExternalLink` — intercept hook, returns `false` to cancel the
  native navigation; the plugin re-opens the link via `window.open` after
  the user confirms.

## Build & install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../external-link-warning.zip manifest.json index.js
```

Upload `external-link-warning.zip` via Admin -> Plugins.

## Notes

- `onBeforeExternalLink` has a 5-second timeout, so the plugin cannot
  await user input inside the hook. It cancels the navigation
  immediately and re-opens the URL manually after confirmation.
- The dialog is plain DOM (no React) so the plugin has zero runtime
  dependencies and the bundle stays tiny.
