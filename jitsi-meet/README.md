# Jitsi Meet Plugin

Adds a **"Add Jitsi meeting"** button to the calendar event editor. Meeting URLs are generated server-side by a sidecar service, which handles room name generation, optional JWT signing, and user authentication via OIDC.

## Architecture

The plugin has two parts:

- **Client** (`dist/index.js`) — UI plugin that registers a calendar event action button. On click, it sends an authenticated `POST /api/jitsi` request to the sidecar.
- **Server sidecar** (`server/`) — A Node.js HTTP service that verifies the user's OIDC Bearer token, generates a unique Jitsi room name, and, with JWT auth, signs a short-lived moderator token for the organizer when they join.

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
| `OIDC_ISSUER_URL` | **Yes** | OIDC issuer URL (e.g. your Zitadel instance). Bearer tokens are verified by calling its userinfo endpoint (found through `/.well-known/openid-configuration`). |
| `JITSI_URL` | **Yes** | Base URL of your Jitsi Meet instance (e.g. `https://meet.example.com`). |
| `JITSI_JWT_SECRET` | No | HMAC-SHA256 secret for signing Jitsi room JWTs. Only needed when your Jitsi instance uses JWT authentication. See [Moderator rights](#moderator-rights). |
| `PORT` | No | Port the sidecar listens on (default: `3001`). |

### 2. Configure Reverse Proxy

The sidecar must be reachable at `/api/jitsi` on the same origin as Bulwark Mail. The plugin cannot make network requests itself: it calls `api.http.post('/api/jitsi', ...)`, and the webmail sends that same-origin request for it with the signed-in user's `Authorization` header. The manifest's `apiPostPaths` allows exactly this path. A reverse proxy in front of both the webmail and the sidecar routes this path to the sidecar while everything else goes to the webmail.

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

The key point is that the browser never contacts the sidecar directly. It only sees `mail.example.com/api/jitsi`, and the reverse proxy forwards that request (including the `Authorization` header) to the sidecar internally.

### Sign-in requirement

The sidecar accepts only `Authorization: Bearer` tokens, which it verifies against `OIDC_ISSUER_URL`. That header is only sent when users sign in to Bulwark Mail with OAuth/OIDC. With password login the webmail sends Basic credentials instead, the sidecar answers 401, and the button shows an error. Use this plugin only on deployments where users sign in through your OIDC provider.

### 3. Install the Plugin

Upload or deploy `jitsi-meet` through Admin → Plugins. No plugin configuration is needed; all settings are handled by the sidecar's environment variables.

### 4. Use

Open any calendar event form and an **"Add Jitsi meeting"** button appears. Clicking it:

1. Sends the event title to the sidecar with the user's OIDC Bearer token
2. The sidecar verifies the token and generates a room name
3. The meeting link is populated on the event

The link in the event is the plain room link, such as `https://meet.example.com/planning-1a2b3c4d-…`. It goes to every attendee with the invitation, so it never carries a token.

### Moderator rights

With `JITSI_JWT_SECRET` set, the room name ends in a tag made from the organizer's OIDC subject and the secret. When the organizer opens the event form again, a **"Join as moderator"** button appears next to the meeting link. It asks the sidecar for a link with a Jitsi JWT for the organizer alone (their name and email, `moderator: true`, valid for one hour) and opens the meeting in a new tab. That link is never written into the event. The sidecar refuses it to anyone else, attendees who sign in to the same webmail included.

Attendees join with the plain link, so your Jitsi instance has to let people without a token in. With docker-jitsi-meet that is `ENABLE_GUESTS=1` next to the JWT settings: guests wait until someone with a token, such as the organizer, has joined.

Events made with version 1.3.1 or earlier carry the organizer's token in their link (`?jwt=…`). When such an event is opened in the form, the plugin takes the token out; save the event to send attendees the clean link. Copies already sent keep the token until it expires, 24 hours after it was made. To make them useless right away, change `JITSI_JWT_SECRET` and the matching secret in Jitsi (`JWT_APP_SECRET`). Rooms made before 1.4.0 have no tag, so nobody can join those as moderator through the button.

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
- `http:post` — Make authenticated HTTP requests to the sidecar via the webmail proxy
