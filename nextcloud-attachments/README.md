# Nextcloud Attachments Plugin

Inspired by the Roundcube [`nextcloud_attachments`](https://github.com/bennet0496/nextcloud_attachments) plugin.

Adds an **"Attach from Nextcloud"** button to the composer toolbar. Files picked from the dialog are uploaded to a configured Nextcloud server, a public share link is created, and the link is appended to the outgoing email body at send time — so the binary never travels through the mail server.

## Architecture

Two parts, mirroring the Jitsi Meet plugin layout:

- **Client** (`dist/index.js`) — composer toolbar action + composer sidebar (right) listing pending uploads. At send time, `onTransformOutgoingEmail` injects an HTML / plain-text link block into the message body.
- **Server sidecar** (`server/`) — Node HTTP service exposing `POST /api/nextcloud/upload`. Verifies the user's OIDC bearer token via the issuer's userinfo endpoint, uploads the file to Nextcloud over WebDAV using a service account, creates a public share via the OCS Files-Sharing API, and returns the share URL (plus optional password and expiry).

The browser only ever talks to `<webmail-host>/api/nextcloud/upload`. A reverse proxy in front of the webmail forwards that path to the sidecar internally.

## Why a service account, not per-user auth

The upstream Roundcube plugin authenticates each user with their own Nextcloud account. That's not buildable in this API today — the plugin runs in the browser sandbox and cannot pop a separate login flow. A v1 service-account model uploads everything through one Nextcloud user, partitioned into per-mail-user sub-folders (`<base>/<user@example.com>/...`). Per-user OAuth can layer on later without changing the client side.

## Setup

### 1. Create a Nextcloud service account

1. In Nextcloud, create a dedicated user (e.g. `webmail-attachments`).
2. Sign in as that user → **Settings → Security → Devices & sessions → Create new app password**. Note the password.
3. Create the base folder you want uploads to land in (default `Mail attachments`).

### 2. Deploy the sidecar

```bash
cd server
docker build -t nextcloud-attachments-sidecar .
docker run -d \
  -e OIDC_ISSUER_URL=https://zitadel.example.com \
  -e NEXTCLOUD_URL=https://cloud.example.com \
  -e NEXTCLOUD_USERNAME=webmail-attachments \
  -e NEXTCLOUD_PASSWORD=<app-password> \
  -e NEXTCLOUD_FOLDER='Mail attachments' \
  -e NEXTCLOUD_FOLDER_LAYOUT=date \
  -e MAX_UPLOAD_BYTES=104857600 \
  -p 3002:3002 \
  nextcloud-attachments-sidecar
```

#### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OIDC_ISSUER_URL` | yes | — | OIDC issuer used to verify Bearer tokens (e.g. your Zitadel URL). |
| `NEXTCLOUD_URL` | yes | — | Base URL of your Nextcloud instance. |
| `NEXTCLOUD_USERNAME` | yes | — | Service account login. |
| `NEXTCLOUD_PASSWORD` | yes | — | Service account app password. |
| `NEXTCLOUD_FOLDER` | no | `Mail attachments` | Root folder for uploads (must already exist). |
| `NEXTCLOUD_FOLDER_LAYOUT` | no | `date` | `flat`, `date` (`<user>/<YYYY>/<MM>`), or `hash` (`<user>/<xx>/<yy>`). |
| `MAX_UPLOAD_BYTES` | no | `104857600` (100 MB) | Hard cap on each base64 request body. |
| `PORT` | no | `3002` | Listen port. |

### 3. Reverse-proxy the path

The browser calls `/api/nextcloud/upload` on the webmail origin. Forward that path to the sidecar before the webmail catch-all:

```nginx
server {
    listen 443 ssl;
    server_name mail.example.com;

    location /api/nextcloud {
        proxy_pass http://nextcloud-sidecar:3002;
        client_max_body_size 110m;     # roughly MAX_UPLOAD_BYTES + slack
        proxy_request_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://bulwark-webmail:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`client_max_body_size` must be larger than `MAX_UPLOAD_BYTES` because the JSON body carries the file as base64 (~33 % overhead).

### 4. Install the plugin

```bash
cd ..
npm install
npm run build
```

Then upload the resulting `dist/index.js` (along with `manifest.json`) through **Admin → Plugins**, or zip the directory and install through the marketplace.

## User settings

| Setting | Default | Description |
|---|---|---|
| `sizeThreshold` | 10 MB | Files attached the regular way that exceed this size produce a hint toast. |
| `nudgeOnLargeUpload` | `true` | Disable to silence the hint. |
| `expiryDays` | 14 | Public share expiry in days. `0` disables expiry. |
| `passwordProtect` | `false` | Generate a random password per share; the password is shown next to the link in the email body. |

## Permissions

| Permission | Why |
|---|---|
| `email:write` | `onBeforeAttachmentUpload` for the size-threshold hint. |
| `email:send` | `onTransformOutgoingEmail` for the link-block injection. |
| `ui:composer-toolbar` | "Attach from Nextcloud" button. |
| `ui:composer-sidebar` | The cloud-attachments panel on the composer's right side. |
| `http:post` | Authenticated POST to `/api/nextcloud/upload`. |

## Use

1. Open the composer.
2. Click **Attach from Nextcloud** in the toolbar and pick one or more files.
3. Each file uploads in the background; the right-hand sidebar shows status (`uploading` → `ready`) and lets you remove an entry before sending.
4. On send, an HTML link block is appended to both the HTML and plain-text bodies. Each entry shows the file name, size, expiry, and (optionally) the password.

## Limitations vs. the Roundcube plugin

- **Service-account uploads only** — no per-user Nextcloud login flow. All files end up under one Nextcloud account, partitioned by user email.
- **Base64-over-JSON transport** — capped by `MAX_UPLOAD_BYTES`. Plain `multipart/form-data` would lift the cap, but `api.http.post` only accepts JSON today; a chunked or pre-signed flow can come later.
- **No "auto cloud-attach for files over N bytes"** — the plugin can detect the upload (`onBeforeAttachmentUpload`) but does not have access to the file bytes from that hook, so it can only nudge with a toast.
- **Removing a pending entry does not delete the file from Nextcloud.** The share link is created up-front, before the user decides to send. Orphans get cleaned up when the share expires.
