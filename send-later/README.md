# Send Later Plugin

Adds a "Send Later" button to the email composer toolbar with configurable scheduling delays.

## Features

- **Composer button** — "Send Later" button with configurable default delay
- **Keyboard shortcut** — `Ctrl+Shift+L` to schedule send
- **Multiple delay options** — 30 minutes, 1/2/4 hours, or tomorrow at 9 AM
- **Toast confirmation** — Optional notification when email is scheduled

## Demonstrates

- `api.ui.registerComposerAction()` — adding a button to the composer toolbar
- `api.hooks.registerShortcut()` — registering keyboard shortcuts
- `api.hooks.onComposerOpen()` — reacting to composer events
- `api.plugin.settings` — using select-type settings
- `api.toast` — showing user notifications
- `api.storage` — tracking scheduled send count

## Build & Install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../send-later.zip manifest.json index.js
```

Upload `send-later.zip` via Admin → Plugins.
