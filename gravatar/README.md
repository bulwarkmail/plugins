# Gravatar Avatars Plugin

Resolves Gravatar profile pictures for email contacts and feeds them to the
host's avatar pipeline via the `onAvatarResolve` transform hook.

## Features

- SHA-256 hashing through the Web Crypto API (no dependencies)
- Persistent cache with separate hit / miss TTLs
  - 7 days for known profiles
  - 1 day for "no Gravatar" so newly created profiles are eventually picked up
- In-flight request coalescing — concurrent renders for the same address share
  one HEAD request
- 3-second abort on the existence check (well under the 5s hook timeout)
- Defers to higher-priority avatar plugins instead of overriding them
- Configurable image size, content rating, and fallback style

## Settings

| Setting        | Description                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| `size`         | Avatar size in pixels (clamped to 16–512)                                            |
| `rating`       | Maximum Gravatar content rating (`g` / `pg` / `r` / `x`)                             |
| `defaultStyle` | What to show when no profile exists. `404` defers to the host's own initials/favicon |

## Demonstrates

- `api.hooks.onAvatarResolve()` — transform hook with cooperative chaining
- `api.storage` — TTL-based persistent cache scoped to the plugin
- `api.plugin.settings` — schema-driven user configuration
- Web Crypto + `AbortSignal.timeout` for safe outbound requests

## Build & Install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../gravatar.zip manifest.json index.js
```

Upload `gravatar.zip` via Admin → Plugins.
