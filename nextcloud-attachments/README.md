# Nextcloud Attachments Plugin

Inspired by the Roundcube [`nextcloud_attachments`](https://github.com/bennet0496/nextcloud_attachments) plugin. Sidecar-less — the plugin talks directly to Nextcloud over WebDAV (PUT) and OCS (public-share create) from the browser using `api.http.fetch`.

Adds an **"Attach from Nextcloud"** button to the composer toolbar. Files picked from the dialog are uploaded to the user's Nextcloud, a public share link is created, and the link is appended to the outgoing email body at send time — so the binary never travels through the mail server.

## How it works

- Each user supplies their own Nextcloud URL, username and **app password** in plugin settings (Nextcloud → Settings → Security → Devices & sessions → Create new app password).
- The composer toolbar action picks files, runs WebDAV `MKCOL` to ensure the per-user folder exists (`<base>/<username>/<YYYY>/<MM>` by default), `PUT`s the file, and `POST`s an OCS public-link share with optional password and expiry.
- Pending uploads show in a right-side composer sidebar with status. At send, `onTransformOutgoingEmail` appends an HTML link card + plain-text fallback to the body and clears the queue.

## Prerequisites

The plugin can only work if both of these are true:

### 1. The Nextcloud origin is in the manifest's `httpOrigins`

`api.http.fetch` enforces a manifest-declared allowlist. The default ships with `"https://cloud.example.com"` — **edit `manifest.json` to your Nextcloud's origin and rebuild before installing**:

```json
"httpOrigins": ["https://cloud.your-domain.com"]
```

A wildcard is allowed (`https://*.your-domain.com`) but matches exactly one subdomain layer.

### 2. The Nextcloud server returns CORS headers permitting the webmail origin

Nextcloud's WebDAV and OCS endpoints don't send CORS headers by default. The browser will refuse direct cross-origin requests without them. Configure your reverse proxy in front of Nextcloud (Nginx example):

```nginx
location / {
    # Pre-flight
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin "https://mail.your-domain.com" always;
        add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, MKCOL, PROPFIND, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Authorization, Content-Type, Depth, OCS-APIRequest, X-Requested-With" always;
        add_header Access-Control-Max-Age 86400;
        add_header Content-Length 0;
        add_header Content-Type "text/plain charset=UTF-8";
        return 204;
    }

    add_header Access-Control-Allow-Origin "https://mail.your-domain.com" always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, MKCOL, PROPFIND, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type, Depth, OCS-APIRequest, X-Requested-With" always;
    add_header Access-Control-Expose-Headers "Content-Length, Content-Range, ETag, OC-FileId, OC-ETag" always;

    proxy_pass http://nextcloud-upstream;
    # … your usual Nextcloud proxy directives …
}
```

`api.http.fetch` always uses `credentials: 'omit'`, so `Access-Control-Allow-Credentials` should be left unset (or `false`). Authentication is via the Basic-auth header the plugin builds from the user's app password.

## Build

```bash
cd repos/plugins/nextcloud-attachments
npm install
npm run build   # → dist/index.js
```

Install via Admin → Plugins (zip the directory + manifest), or drop the folder under `PLUGIN_DEV_DIR` for live-reload development.

## User settings

| Setting | Default | Description |
|---|---|---|
| `ncUrl` | — | Full URL of your Nextcloud (must match the manifest's `httpOrigins`). |
| `ncUsername` | — | Your Nextcloud login. |
| `ncAppPassword` | — | App password (not your account password). Stored unencrypted in this browser. |
| `ncBaseFolder` | `Mail attachments` | Path inside your home folder; created on demand. |
| `ncFolderLayout` | `date` | `flat`, `date` (`<user>/<YYYY>/<MM>`), or `hash` (`<user>/<xx>/<yy>`). |
| `expiryDays` | 14 | Public share expiry in days. `0` disables expiry. |
| `passwordProtect` | `false` | Generate a random password per share; shown next to the link in the email. |
| `sizeThreshold` | 10 MB | Files attached the regular way that exceed this size produce a hint toast. |
| `nudgeOnLargeUpload` | `true` | Disable to silence the hint. |

## Permissions

| Permission | Why |
|---|---|
| `email:write` | `onBeforeAttachmentUpload` for the size-threshold hint. |
| `email:send` | `onTransformOutgoingEmail` for the link-block injection. |
| `ui:composer-toolbar` | "Attach from Nextcloud" button. |
| `ui:composer-sidebar` | The cloud-attachments panel on the composer's right side. |
| `ui:settings-section` | The settings page for entering Nextcloud credentials. |
| `http:fetch` | Cross-origin requests to Nextcloud; gated by `httpOrigins`. |

## Use

1. Install + enable the plugin, then open Settings → Plugins → Nextcloud Attachments and fill in the four required fields.
2. Open the composer.
3. Click **Attach from Nextcloud** in the toolbar and pick one or more files.
4. Each file uploads in the background; the right-hand sidebar shows status (`uploading` → `ready`) and lets you remove an entry before sending.
5. On send, an HTML link block is appended to both the HTML and plain-text bodies. Each entry shows the file name, size, expiry, and (optionally) the password.

## Limitations

- **Browser-only auth.** App password lives in plugin settings, persisted in the browser. Don't enable on shared profiles.
- **CORS dependency.** Nextcloud admin must add the headers shown above. Without them, the browser rejects the cross-origin call before any handler runs and `api.http.fetch` reports a network error.
- **No streaming.** `api.http.fetch` accepts a `Blob`/`File` body, so files of any size up to your reverse-proxy's `client_max_body_size` work — but the upload is one PUT, no chunking. Very large files (>1 GB) should use Nextcloud's chunked-upload API; not implemented here.
- **Removing a pending entry does not delete the file from Nextcloud.** The share link is created up-front. Orphans clean themselves up when the share expires.
- **Per-deployment manifest.** `httpOrigins` is fixed at install time. Each org needs to edit and rebuild with their own Nextcloud URL.
