# Quick Notes Plugin

Per-email sticky notes in the sidebar. Jot down notes while reading emails and see them again when you revisit.

## Features

- **Sidebar widget** — Textarea for adding/editing notes per email
- **Email banner** — Shows a preview of your note above emails that have one
- **Persistent storage** — Notes survive page reloads and sessions
- **Auto-cleanup** — Oldest notes removed when storage limit reached
- **Theme-aware** — Uses CSS variables for proper light/dark mode support

## Demonstrates

- `api.ui.registerSidebarWidget()` — interactive React widget with state
- `api.ui.registerEmailBanner()` — conditional banner with `shouldShow` predicate
- `api.hooks.onEmailOpen()` / `onEmailClose()` — tracking the active email
- `api.storage` — persisting structured data (notes object)
- `api.plugin.settings` — number and boolean settings
- React `useState`, `useEffect`, `useCallback` without JSX
- Using CSS custom properties (`var(--color-*)`) for theme integration

## Build & Install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../quick-notes.zip manifest.json index.js
```

Upload `quick-notes.zip` via Admin → Plugins.
