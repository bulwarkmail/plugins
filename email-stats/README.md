# Email Stats Plugin

A sidebar widget that tracks email activity during your session.

## Features

- Counts emails opened, sent, and received in the current session
- Persists lifetime totals across sessions using plugin storage
- Configurable via settings (toggle tracking of opens and sends)
- Real-time counter updates in the sidebar widget

## Demonstrates

- `api.ui.registerSidebarWidget()` — adding a React widget to the sidebar
- `api.hooks.onEmailOpen()` — tracking email opens
- `api.hooks.onAfterEmailSend()` — tracking sent emails
- `api.hooks.onNewEmailReceived()` — tracking incoming emails
- `api.storage` — persistent data across sessions
- `api.plugin.settings` — reading user-configured settings
- React `useState` + `useEffect` without JSX

## Build & Install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../email-stats.zip manifest.json index.js
```

Upload `email-stats.zip` via Admin → Plugins.
