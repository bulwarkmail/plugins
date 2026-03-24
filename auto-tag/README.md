# Auto Tag Plugin

Automatically tags incoming emails based on configurable rules. Recognizes newsletters, invoices, and GitHub notifications out of the box.

## Features

- **Newsletter detection** — Tags emails from `noreply@` addresses or with unsubscribe-related subjects
- **Invoice detection** — Tags emails with invoice/receipt/billing keywords in the subject
- **GitHub detection** — Tags emails from GitHub notification addresses
- All rules are toggleable via plugin settings

## Demonstrates

- `api.hooks.onNewEmailReceived()` — reacting to incoming email
- `api.plugin.settings` — user-configurable boolean settings
- `api.storage` — persisting counters across sessions
- Pattern matching on email from/subject fields

## Build & Install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../auto-tag.zip manifest.json index.js
```

Upload `auto-tag.zip` via Admin → Plugins.
