# Jitsi Meet Plugin

Adds a **"Add Jitsi Meeting"** button to the calendar event editor. Meeting URLs are generated server-side by a sidecar service, which handles room name generation, optional JWT signing, and user authentication via OIDC.

## Architecture

The plugin has two parts:

- **Client** (`dist/index.js`) — UI plugin that registers a calendar event action button. On click, it sends an authenticated `POST /api/jitsi` request to the sidecar.
- **Server sidecar** (`server/`) — A Node.js HTTP service that verifies the user's OIDC Bearer token, generates a unique Jitsi room name, and optionally signs a Jitsi JWT.

## Setup

### 1. Deploy the Sidecar

The sidecar runs as a separate service. Build and run with Docker:

```bash
cd server
docker build -t jitsi-meet-sidecar .
docker run -d \
  -e OIDC_ISSUER_URL=https://zitadel.example.com \
  -e JITSI_URL=https://meet.example.com \
  -e JITSI_JWT_SECRET=your-jitsi-jwt-secret \
  -p 3001:3001 \
  jitsi-meet-sidecar
```

#### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OIDC_ISSUER_URL` | **Yes** | OIDC issuer URL (e.g. your Zitadel instance). Used to fetch JWKS and verify Bearer tokens. |
| `JITSI_URL` | **Yes** | Base URL of your Jitsi Meet instance (e.g. `https://meet.example.com`). |
| `JITSI_JWT_SECRET` | No | HMAC-SHA256 secret for signing Jitsi room JWTs. Only needed when your Jitsi instance requires JWT authentication. |
| `PORT` | No | Port the sidecar listens on (default: `3001`). |

### 2. Configure Reverse Proxy

The sidecar must be reachable at `/api/jitsi` on the same origin as Bulwark Mail. The plugin's client-side code calls `fetch("/api/jitsi", ...)`, so the browser treats it as a same-origin request. A reverse proxy in front of both the webmail and the sidecar routes this path to the sidecar while everything else goes to the webmail.

For example, with nginx:

```nginx
server {
    listen 443 ssl;
    server_name mail.example.com;

    # Jitsi sidecar — must come before the catch-all
    location /api/jitsi {
        proxy_pass http://jitsi-sidecar:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Bulwark Mail (Next.js)
    location / {
        proxy_pass http://bulwark-webmail:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

In Docker Compose, both services share a network so the proxy can reach them by service name:

```yaml
services:
  webmail:
    image: bulwark-webmail
    # ...

  jitsi-sidecar:
    build: ./jitsi-meet/server
    environment:
      - OIDC_ISSUER_URL=https://zitadel.example.com
      - JITSI_URL=https://meet.example.com
      # - JITSI_JWT_SECRET=your-secret

  nginx:
    image: nginx
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf
    depends_on:
      - webmail
      - jitsi-sidecar
```

The key point is that the browser never contacts the sidecar directly — it only sees `mail.example.com/api/jitsi`, and the reverse proxy forwards that request (including the `Authorization` header) to the sidecar internally.

### 3. Install the Plugin

Upload or deploy `jitsi-meet` through Admin → Plugins. No plugin configuration is needed — all settings are handled by the sidecar's environment variables.

### 4. Use

Open any calendar event form — an **"Add Jitsi Meeting"** button appears. Clicking it:

1. Sends the event title to the sidecar with the user's OIDC Bearer token
2. The sidecar verifies the token, generates a room name, and optionally appends a signed Jitsi JWT
3. The meeting link is populated on the event

## Building

```bash
cd jitsi-meet
npm install
npm run build
```

The built client bundle will be at `dist/index.js`.

## Permissions

- `calendar:read` — Read calendar event data
- `calendar:write` — Set the meeting link on events
- `ui:calendar-action` — Register an action button in the event editor
- `auth:read` — Read the current user's auth headers to authenticate with the sidecar
