# Plugin Template

Starter template for creating a Bulwark Mail plugin.

## Setup

```bash
npm install
```

## Development

Edit `src/index.js` with your plugin code.

## Build

```bash
npm run build
```

This produces `dist/index.js` using esbuild.

## Package

```bash
cp manifest.json dist/
cd dist
zip -r ../my-plugin.zip manifest.json index.js
```

Upload the ZIP via **Admin → Plugins** in Bulwark Mail.

## Customization

1. **manifest.json**: Update `id`, `name`, `author`, `description`, `type`, and `permissions`
2. **src/index.js**: Uncomment the sections you need (UI registrations, hooks, etc.)
3. **package.json**: Update `name` to match your plugin

## Plugin Types

- **`hook`** — Event-driven, no visible UI. Reacts to emails, calendar events, etc.
- **`ui-extension`** — Adds buttons, banners, or panels to existing views.
- **`sidebar-app`** — Adds a full panel in the sidebar area.

## Notes

- React is provided by the host app — do **not** bundle it
- Use `api.storage` for persistent data, not `localStorage` directly
- Call `.dispose()` on all registrations when cleaning up
- Plugin auto-disables after 3 errors in 60 seconds
