/**
 * Nextcloud Attachments — upload large files to Nextcloud and insert a
 * public share link into the outgoing email body instead of attaching the
 * binary directly.
 *
 * Architecture:
 *   - Composer toolbar button picks files and POSTs them base64-encoded to
 *     /api/nextcloud/upload (provided by the bundled sidecar).
 *   - A composer sidebar widget shows the pending uploads with status.
 *   - onTransformOutgoingEmail appends an HTML / text link block at send.
 *   - onBeforeAttachmentUpload optionally nudges the user toward cloud
 *     attach when a regular attachment is over the threshold.
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

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected reader result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  const settings = pluginApi.plugin.settings || {};
  const base64 = await readFileAsBase64(file);
  const res = await pluginApi.http.post("/api/nextcloud/upload", {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    contentBase64: base64,
    expiryDays: typeof settings.expiryDays === "number" ? settings.expiryDays : 14,
    passwordProtect: settings.passwordProtect === true,
  });
  if (!res.ok) {
    const msg = (res.data && res.data.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.data;
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
      const result = await uploadFile(file);
      const item = pendingAttachments.find((a) => a.id === id);
      if (item) {
        item.status = "ready";
        item.url = result.url;
        item.password = result.password;
        item.expiresAt = result.expiresAt;
        notify();
      }
      pluginApi.toast.success(`Uploaded "${file.name}" to Nextcloud`);
    } catch (err) {
      const item = pendingAttachments.find((a) => a.id === id);
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
  pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
  notify();
}

function CloudAttachmentsPanel() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  if (pendingAttachments.length === 0) {
    return h(
      "div",
      {
        style: {
          padding: "12px",
          color: "#888",
          fontSize: "13px",
          lineHeight: "1.4",
        },
      },
      "No cloud attachments yet. Use “Attach from Nextcloud” in the composer toolbar to upload large files. A share link is inserted automatically when you send.",
    );
  }

  return h(
    "div",
    {
      style: {
        padding: "8px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      },
    },
    pendingAttachments.map((a) =>
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
          {
            style: {
              fontSize: "13px",
              fontWeight: 500,
              wordBreak: "break-all",
            },
          },
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
              {
                style: {
                  fontSize: "11px",
                  color: "#666",
                  fontFamily: "monospace",
                },
              },
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
                  style: {
                    fontSize: "11px",
                    color: "var(--color-primary, #3b82f6)",
                  },
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
      const ready = pendingAttachments.filter((a) => a.status === "ready");
      if (ready.length === 0) return;

      const next = {
        ...email,
        htmlBody: (email.htmlBody || "") + buildHtmlBlock(ready),
        textBody: (email.textBody || "") + buildTextBlock(ready),
      };

      pendingAttachments = pendingAttachments.filter(
        (a) => a.status !== "ready",
      );
      notify();

      return next;
    }),
  );

  api.log.info("Nextcloud Attachments plugin activated");

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      pendingAttachments = [];
      listeners.clear();
      pluginApi = null;
    },
  };
}
