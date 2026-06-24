# Libravatar Avatars Plugin

Resolves [Libravatar](https://www.libravatar.org/) profile pictures for email
contacts and feeds them to the host's avatar pipeline via the
`onAvatarResolve` transform hook. Libravatar is a federated, privacy-friendly
Gravatar alternative.

Modelled on the bundled Gravatar plugin.

## Features

- SHA-256 hashing through the Web Crypto API (no dependencies)
- Persistent cache with separate hit / miss TTLs
  - 7 days for known profiles
  - 1 day for "no Libravatar" so newly created profiles are eventually picked up
- In-flight request coalescing — concurrent renders for the same address share
  one HEAD request
- 3-second abort on the existence check (well under the 5s hook timeout)
- Defers to higher-priority avatar plugins instead of overriding them
- Configurable image size and fallback style

## Settings

| Setting        | Description                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| `size`         | Avatar size in pixels (clamped to 16–512)                                            |
| `defaultStyle` | What to show when no profile exists. `404` defers to the host's own initials/favicon |

## Notes vs. Gravatar

- Endpoint is `seccdn.libravatar.org` (the public delegation CDN).
- No content-rating parameter — Libravatar has no rating system.
- **Federation:** a browser-sandboxed plugin can't perform Libravatar's
  DNS-SRV delegation lookup, so this targets the central CDN. That CDN still
  serves avatars for domains that delegate to it; self-hosted Libravatar
  servers that don't delegate to the CDN aren't reached from a client-side
  plugin.

## Marketplace media

`media/icon.svg` and `media/banner.svg` are ingested from this git repo by the
extension directory; they do not ship in the runtime zip.

## Build & Install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../libravatar.zip manifest.json index.js
```

Upload `libravatar.zip` via Admin → Plugins.
