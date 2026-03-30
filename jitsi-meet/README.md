# Jitsi Meet Plugin

Adds a **"Add Jitsi Meeting"** button to the calendar event editor. When clicked it generates a unique Jitsi room name, optionally signs a JWT for authenticated rooms, and sets the meeting link on the event.

## Setup

### 1. Install the Plugin

Upload or deploy `jitsi-meet` through Admin → Plugins.

### 2. Configure

Go to **Admin → Plugins → jitsi-meet → Configure** and set:

| Key | Required | Description |
|-----|----------|-------------|
| `jitsi-url` | **Yes** | Base URL of your Jitsi Meet instance (e.g. `https://meet.example.com`) |
| `jitsi-jwt-secret` | No | HMAC-SHA256 secret for signing JWTs. Only needed when your Jitsi instance requires JWT authentication. Must match the secret in your Jitsi deployment. |

### 3. Use

Open any calendar event form — a **"📹 Add Jitsi Meeting"** button appears below the meeting link field. Clicking it:

1. Generates a room name from the event title + random suffix
2. Builds the full meeting URL
3. (If JWT secret is configured) Creates and appends a signed JWT
4. Populates the meeting link field

## Building

```bash
cd repos/plugins/jitsi-meet
npm install
npm run build
```

The built bundle will be at `dist/index.js`.

## Permissions

This plugin requests the following permissions:

- `calendar:read` — Read calendar event data
- `calendar:write` — Set the meeting link on events
- `ui:calendar-action` — Register an action button in the event editor
- `ui:settings-section` — (reserved for future per-user settings)
- `admin:config` — Read admin-managed configuration (Jitsi URL, JWT secret)
