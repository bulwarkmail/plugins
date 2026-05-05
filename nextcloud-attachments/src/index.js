/**
 * Nextcloud Attachments — sidecar-less.
 *
 * Talks directly to the user's Nextcloud over WebDAV (PUT) and OCS
 * (public-share create) using `api.http.fetch`. Each user supplies their
 * own Nextcloud URL, username, and app password via plugin settings. The
 * Nextcloud origin must be present in the manifest's `httpOrigins`, and
 * the Nextcloud server must serve CORS headers permitting the webmail
 * origin.
 *
 * Composer flow:
 *   - Toolbar button "Attach from Nextcloud" picks files, uploads them,
 *     creates public shares, and stages them in a per-compose list.
 *   - The right-side composer sidebar shows status and lets the user
 *     remove items before sending.
 *   - onTransformOutgoingEmail appends an HTML link block + plain-text
 *     fallback to the body at send time.
 */

function getReact() {
  return globalThis.__PLUGIN_EXTERNALS__?.React;
}
const h = (...args) => getReact().createElement(...args);
const useState = (...args) => getReact().useState(...args);
const useEffect = (...args) => getReact().useEffect(...args);

let pluginApi = null;
let pendingAttachments = [];
const listeners = new Set();

function notify() {
  listeners.forEach((fn) => {
    try { fn(); } catch { /* ignore */ }
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trimTrailingSlash(s) {
  return String(s).replace(/\/+$/, "");
}

function sanitizeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/<>:"|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length === 0 ? "attachment" : cleaned.slice(0, 240);
}

function userSlug(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function pad2(n) { return String(n).padStart(2, "0"); }

function buildSubFolder(layout, username) {
  const slug = userSlug(username);
  if (layout === "flat") return slug;
  if (layout === "hash") {
    const bytes = crypto.getRandomValues(new Uint8Array(3));
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
    return `${slug}/${hex.slice(0, 2)}/${hex.slice(2, 4)}`;
  }
  const d = new Date();
  return `${slug}/${d.getFullYear()}/${pad2(d.getMonth() + 1)}`;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function generatePassword(length = 14) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function basicAuthHeader(user, pass) {
  return "Basic " + btoa(unescape(encodeURIComponent(`${user}:${pass}`)));
}

function getConfig() {
  const s = (pluginApi && pluginApi.plugin.settings) || {};
  const ncUrl = trimTrailingSlash(String(s.ncUrl || ""));
  return {
    ncUrl,
    ncUsername: String(s.ncUsername || ""),
    ncAppPassword: String(s.ncAppPassword || ""),
    ncBaseFolder: String(s.ncBaseFolder || "Mail attachments"),
    ncFolderLayout: ["flat", "date", "hash"].includes(s.ncFolderLayout) ? s.ncFolderLayout : "date",
    expiryDays: typeof s.expiryDays === "number" ? s.expiryDays : 14,
    passwordProtect: s.passwordProtect === true,
  };
}

function isConfigured(cfg) {
  return cfg.ncUrl && cfg.ncUsername && cfg.ncAppPassword;
}

function encodePath(p) {
  return p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function ensureFolder(cfg, folderPath) {
  const parts = folderPath.split("/").filter(Boolean);
  const auth = basicAuthHeader(cfg.ncUsername, cfg.ncAppPassword);
  let acc = "";
  for (const part of parts) {
    acc += "/" + encodeURIComponent(part);
    const url = `${cfg.ncUrl}/remote.php/dav/files/${encodeURIComponent(cfg.ncUsername)}${acc}`;
    const res = await pluginApi.http.fetch(url, {
      method: "MKCOL",
      headers: { Authorization: auth },
    });
    // 201 = created, 405 = already exists.
    if (!res.ok && res.status !== 405) {
      const text = await res.text().catch(() => "");
      throw new Error(`MKCOL ${acc} failed: HTTP ${res.status} ${text.slice(0, 160)}`);
    }
  }
}

async function uploadAndShare(file) {
  const cfg = getConfig();
  if (!isConfigured(cfg)) {
    throw new Error("Nextcloud is not configured. Set URL, username and app password in plugin settings.");
  }

  const safeName = sanitizeFileName(file.name);
  const subFolder = buildSubFolder(cfg.ncFolderLayout, cfg.ncUsername);
  const folderPath = `${cfg.ncBaseFolder.replace(/^\/+|\/+$/g, "")}/${subFolder}`;
  await ensureFolder(cfg, folderPath);

  const remoteName = `${randomToken()}-${safeName}`;
  const remotePath = `${folderPath}/${remoteName}`;
  const auth = basicAuthHeader(cfg.ncUsername, cfg.ncAppPassword);

  const putUrl =
    `${cfg.ncUrl}/remote.php/dav/files/${encodeURIComponent(cfg.ncUsername)}/` +
    encodePath(remotePath);

  const putRes = await pluginApi.http.fetch(putUrl, {
    method: "PUT",
    headers: {
      Authorization: auth,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(`Upload failed: HTTP ${putRes.status} ${text.slice(0, 160)}`);
  }

  const password = cfg.passwordProtect ? generatePassword() : undefined;
  let expiresAt;

  const form = new URLSearchParams();
  form.set("path", `/${remotePath}`);
  form.set("shareType", "3"); // public link
  form.set("permissions", "1"); // read
  if (password) form.set("password", password);
  if (cfg.expiryDays > 0) {
    const d = new Date(Date.now() + cfg.expiryDays * 86400000);
    form.set("expireDate", d.toISOString().slice(0, 10));
    expiresAt = d.toISOString();
  }

  const shareRes = await pluginApi.http.fetch(
    `${cfg.ncUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`,
    {
      method: "POST",
      headers: {
        Authorization: auth,
        "OCS-APIRequest": "true",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
  );
  if (!shareRes.ok) {
    const text = await shareRes.text().catch(() => "");
    throw new Error(`Share create failed: HTTP ${shareRes.status} ${text.slice(0, 160)}`);
  }
  const shareJson = await shareRes.json();
  const data = shareJson && shareJson.ocs && shareJson.ocs.data;
  if (!data || !data.url) throw new Error("Share response missing url");

  return {
    url: data.url,
    password,
    expiresAt,
    name: safeName,
    size: file.size,
  };
}

function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.onchange = () => {
      const files = input.files ? Array.from(input.files) : [];
      input.remove();
      resolve(files);
    };
    document.body.appendChild(input);
    input.click();
  });
}

async function handleAttachClick() {
  if (!pluginApi) return;
  const cfg = getConfig();
  if (!isConfigured(cfg)) {
    pluginApi.toast.error("Configure Nextcloud URL, username and app password in plugin settings first.");
    return;
  }

  const files = await pickFiles();
  if (files.length === 0) return;

  for (const file of files) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingAttachments.push({
      id,
      name: file.name,
      size: file.size,
      type: file.type,
      status: "uploading",
    });
    notify();

    try {
      const result = await uploadAndShare(file);
      const item = pendingAttachments.find(a => a.id === id);
      if (item) {
        item.status = "ready";
        item.url = result.url;
        item.password = result.password;
        item.expiresAt = result.expiresAt;
        notify();
      }
      pluginApi.toast.success(`Uploaded "${file.name}" to Nextcloud`);
    } catch (err) {
      const item = pendingAttachments.find(a => a.id === id);
      if (item) {
        item.status = "error";
        item.error = err && err.message ? err.message : String(err);
        notify();
      }
      pluginApi.log.error("Nextcloud upload failed", err);
      pluginApi.toast.error(`Failed to upload "${file.name}"`);
    }
  }
}

function removePending(id) {
  pendingAttachments = pendingAttachments.filter(a => a.id !== id);
  notify();
}

function CloudAttachmentsPanel() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick(t => t + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  const cfg = getConfig();
  if (!isConfigured(cfg)) {
    return h(
      "div",
      { style: { padding: "12px", color: "#888", fontSize: "13px", lineHeight: "1.4" } },
      "Configure Nextcloud URL, username and app password in plugin settings to use cloud attach.",
    );
  }

  if (pendingAttachments.length === 0) {
    return h(
      "div",
      { style: { padding: "12px", color: "#888", fontSize: "13px", lineHeight: "1.4" } },
      "No cloud attachments yet. Use “Attach from Nextcloud” in the composer toolbar to upload large files. A share link is inserted automatically when you send.",
    );
  }

  return h(
    "div",
    { style: { padding: "8px", display: "flex", flexDirection: "column", gap: "6px" } },
    pendingAttachments.map(a =>
      h(
        "div",
        {
          key: a.id,
          style: {
            padding: "8px",
            border: "1px solid var(--color-border, #e2e8f0)",
            borderRadius: "6px",
            background: "var(--color-background, #fff)",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          },
        },
        h(
          "div",
          { style: { fontSize: "13px", fontWeight: 500, wordBreak: "break-all" } },
          a.name,
        ),
        h(
          "div",
          { style: { fontSize: "11px", color: "#888" } },
          `${formatBytes(a.size)} · ${a.status === "uploading"
            ? "uploading…"
            : a.status === "ready"
              ? a.expiresAt
                ? `ready · expires ${a.expiresAt.slice(0, 10)}`
                : "ready"
              : `error: ${a.error || "failed"}`}`,
        ),
        a.status === "ready" && a.password
          ? h(
              "div",
              { style: { fontSize: "11px", color: "#666", fontFamily: "monospace" } },
              `password: ${a.password}`,
            )
          : null,
        h(
          "div",
          { style: { display: "flex", gap: "6px", marginTop: "2px" } },
          a.status === "ready"
            ? h(
                "a",
                {
                  href: a.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  style: { fontSize: "11px", color: "var(--color-primary, #3b82f6)" },
                },
                "open",
              )
            : null,
          a.status !== "uploading"
            ? h(
                "button",
                {
                  onClick: () => removePending(a.id),
                  style: {
                    fontSize: "11px",
                    padding: "2px 8px",
                    border: "1px solid var(--color-border, #e2e8f0)",
                    borderRadius: "4px",
                    background: "transparent",
                    color: "var(--color-destructive, #ef4444)",
                    cursor: "pointer",
                  },
                },
                "remove",
              )
            : null,
        ),
      ),
    ),
  );
}

function buildHtmlBlock(items) {
  const rows = items
    .map((a) => {
      const meta = `${formatBytes(a.size)}${a.expiresAt ? ` &middot; expires ${escapeHtml(a.expiresAt.slice(0, 10))}` : ""}`;
      const pwd = a.password
        ? `<div style="font-size:12px;color:#555;font-family:monospace">password: ${escapeHtml(a.password)}</div>`
        : "";
      return `<tr><td style="padding:8px 0;border-top:1px solid #e5e7eb"><div style="font-weight:600"><a href="${escapeHtml(a.url)}" style="color:#2563eb;text-decoration:none">${escapeHtml(a.name)}</a></div><div style="font-size:12px;color:#6b7280">${meta}</div>${pwd}</td></tr>`;
    })
    .join("");
  return (
    `<div style="margin-top:24px;padding:12px 16px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;font-family:Helvetica,Arial,sans-serif">` +
    `<div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:4px">☁ Cloud attachments</div>` +
    `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">Hosted on Nextcloud. Click a name to download.</div>` +
    `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows}</table>` +
    `</div>`
  );
}

function buildTextBlock(items) {
  const lines = items.map((a) => {
    const parts = [`- ${a.name} (${formatBytes(a.size)})`, `  ${a.url}`];
    if (a.password) parts.push(`  password: ${a.password}`);
    if (a.expiresAt) parts.push(`  expires: ${a.expiresAt.slice(0, 10)}`);
    return parts.join("\n");
  });
  return `\n\n--- Cloud attachments (Nextcloud) ---\n${lines.join("\n")}\n`;
}

export function activate(api) {
  pluginApi = api;
  const disposables = [];

  // Reset pending list whenever a fresh composer opens.
  disposables.push(
    api.hooks.onComposerOpen(() => {
      pendingAttachments = [];
      notify();
    }),
  );

  disposables.push(
    api.ui.registerComposerAction({
      id: "nextcloud-attach",
      label: "Attach from Nextcloud",
      icon: "☁",
      onClick: handleAttachClick,
      order: 80,
    }),
  );

  disposables.push(
    api.ui.registerComposerSidebar({
      id: "nextcloud-attachments-panel",
      label: "Cloud attachments",
      side: "right",
      render: CloudAttachmentsPanel,
      order: 50,
    }),
  );

  const settings = api.plugin.settings || {};
  if (settings.nudgeOnLargeUpload !== false) {
    const threshold = Number(settings.sizeThreshold) || 10 * 1024 * 1024;
    disposables.push(
      api.hooks.onBeforeAttachmentUpload((info) => {
        if (info && typeof info.size === "number" && info.size > threshold) {
          api.toast.info(
            `"${info.name}" is large — use “Attach from Nextcloud” to send a share link instead.`,
          );
        }
      }),
    );
  }

  disposables.push(
    api.hooks.onTransformOutgoingEmail((email) => {
      const ready = pendingAttachments.filter(a => a.status === "ready");
      if (ready.length === 0) return;

      const next = {
        ...email,
        htmlBody: (email.htmlBody || "") + buildHtmlBlock(ready),
        textBody: (email.textBody || "") + buildTextBlock(ready),
      };

      pendingAttachments = pendingAttachments.filter(a => a.status !== "ready");
      notify();

      return next;
    }),
  );

  api.log.info("Nextcloud Attachments plugin activated");

  return {
    dispose: () => {
      disposables.forEach(d => d.dispose());
      pendingAttachments = [];
      listeners.clear();
      pluginApi = null;
    },
  };
}
