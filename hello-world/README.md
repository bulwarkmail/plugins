# Hello World Plugin

The simplest possible Bulwark Mail plugin. Logs lifecycle events and email activity to the browser console.

## What it does

- Logs when the app is ready
- Logs when emails are opened (subject and sender)
- Logs when new emails arrive
- Tracks activation count in plugin storage
- Shows a welcome toast on first install

## Build & Install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../hello-world.zip manifest.json index.js
```

Upload `hello-world.zip` via Admin → Plugins.
