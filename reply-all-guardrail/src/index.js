/**
 * Reply-All Guardrail — confirmation prompt before reply-all (and optionally
 * before any send) when the recipient count crosses a threshold.
 *
 * Threshold resolution:
 *   admin `forceThreshold` (when set) and per-user `threshold` are compared;
 *   the smaller value wins. This lets admins enforce a stricter floor without
 *   stopping users from tightening it further on their own machine.
 *
 * Self-exclusion:
 *   the user's sending addresses are captured from outgoing sends and stored
 *   under `myAddresses`. When `excludeSelf` is on, those addresses are not
 *   counted toward the threshold and are not listed in the dialog so the
 *   prompt reflects "other people".
 *
 * Hooks:
 *   - onBeforeReplyAll → counts From + To + Cc on the original message and
 *     prompts before the composer opens. Returning `false` cancels.
 *   - onBeforeEmailSend → counts To + Cc + Bcc on the outgoing email and
 *     prompts before the JMAP / S/MIME pipeline. Returning `false` cancels.
 *
 * The hook host enforces a 60 s timeout on intercept hooks. The modal
 * therefore auto-cancels at 55 s if the user does not respond — fail-closed.
 */

const STYLE_ID = "plugin-reply-all-guardrail-style";
const HOOK_TIMEOUT_BUDGET_MS = 55_000;

const STYLES = `
.rag-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 100000;
  font-family: inherit;
  animation: rag-fade-in 0.12s ease-out;
}
.rag-modal {
  background: #ffffff;
  color: #0f172a;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 20px;
  max-width: 520px;
  width: 92%;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  animation: rag-pop 0.14s ease-out;
}
.rag-title {
  font-size: 16px; font-weight: 600;
  margin: 0 0 10px 0;
  display: flex; align-items: center; gap: 8px;
  color: inherit;
}
.rag-icon {
  display: inline-flex; width: 22px; height: 22px;
  color: #eab308;
  flex-shrink: 0;
}
.rag-body {
  font-size: 13px; line-height: 1.5;
  margin: 0 0 12px 0;
  color: #64748b;
}
.rag-list {
  list-style: none;
  padding: 8px 10px;
  margin: 0 0 14px 0;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #0f172a;
  max-height: 180px;
  overflow: auto;
}
.rag-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  word-break: break-all;
}
.rag-tag {
  display: inline-block;
  flex-shrink: 0;
  font-family: inherit;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 4px;
  background: #e2e8f0;
  color: #475569;
}
.rag-domain {
  font-weight: 600;
  color: #0f172a;
}
.rag-actions {
  display: flex; gap: 8px;
  justify-content: flex-end;
}
.rag-btn {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px; font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s, filter 0.15s;
}
.rag-btn:focus-visible {
  outline: 2px solid #94a3b8;
  outline-offset: 2px;
}
.rag-btn-cancel {
  background: transparent;
  border-color: #e2e8f0;
  color: #0f172a;
}
.rag-btn-cancel:hover { background: #f1f5f9; }
.rag-btn-confirm {
  background: #f59e0b;
  color: #ffffff;
}
.rag-btn-confirm:hover { filter: brightness(0.95); }

.dark .rag-modal,
.rag-modal.rag-dark {
  background: #18181b;
  color: #fafafa;
  border-color: #27272a;
}
.dark .rag-body,
.rag-modal.rag-dark .rag-body { color: #a1a1aa; }
.dark .rag-list,
.rag-modal.rag-dark .rag-list {
  background: #0a0a0a;
  color: #fafafa;
  border-color: #27272a;
}
.dark .rag-tag,
.rag-modal.rag-dark .rag-tag {
  background: #27272a;
  color: #d4d4d8;
}
.dark .rag-domain,
.rag-modal.rag-dark .rag-domain { color: #fafafa; }
.dark .rag-icon,
.rag-modal.rag-dark .rag-icon { color: #ca8a04; }
.dark .rag-btn-cancel,
.rag-modal.rag-dark .rag-btn-cancel {
  border-color: #27272a;
  color: #fafafa;
}
.dark .rag-btn-cancel:hover,
.rag-modal.rag-dark .rag-btn-cancel:hover { background: #27272a; }
.dark .rag-btn:focus-visible,
.rag-modal.rag-dark .rag-btn:focus-visible { outline-color: #d4d4d4; }

@keyframes rag-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes rag-pop {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}
`;

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// Warning triangle — same icon family as the External Recipient Warning
// plugin, since this is the same kind of guardrail.
function buildWarningIcon() {
  const svg = svgEl("svg", {
    width: "22",
    height: "22",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.appendChild(
    svgEl("path", {
      d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
    }),
  );
  svg.appendChild(svgEl("line", { x1: "12", y1: "9", x2: "12", y2: "13" }));
  svg.appendChild(svgEl("line", { x1: "12", y1: "17", x2: "12.01", y2: "17" }));
  return svg;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function detectDark() {
  const html = document.documentElement;
  const body = document.body;
  if (html.classList.contains("dark") || body?.classList?.contains("dark")) return true;

  const colorScheme = getComputedStyle(html).colorScheme || "";
  if (/dark/i.test(colorScheme) && !/light/i.test(colorScheme)) return true;

  const bodyBg = body ? getComputedStyle(body).backgroundColor : "";
  const m = bodyBg.match(/\d+(?:\.\d+)?/g);
  if (m && m.length >= 3) {
    const [r, g, b] = m.slice(0, 3).map(Number);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum < 0.5) return true;
  }
  return false;
}

function normaliseEmail(addr) {
  if (!addr) return "";
  return String(addr).trim().toLowerCase();
}

/** Collect recipients from an outgoing email (To + Cc + Bcc) into per-field
 *  entries, deduplicated, optionally minus self. Used in the send guard. */
function collectOutgoingRecipients(email, excludeAddresses) {
  const seen = new Set();
  const out = [];
  for (const { field, list } of [
    { field: "To",  list: email.to  || [] },
    { field: "Cc",  list: email.cc  || [] },
    { field: "Bcc", list: email.bcc || [] },
  ]) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      const n = normaliseEmail(a);
      if (!n || excludeAddresses.has(n) || seen.has(n)) continue;
      seen.add(n);
      out.push({ field, address: String(a).trim() });
    }
  }
  return out;
}

/** Collect recipients that reply-all would fan out to: From + To + Cc on the
 *  original, deduplicated, minus self. */
function collectReplyAllRecipients(originalEmail, excludeAddresses) {
  const seen = new Set();
  const out = [];
  for (const { field, list } of [
    { field: "From", list: originalEmail.from || [] },
    { field: "To",   list: originalEmail.to   || [] },
    { field: "Cc",   list: originalEmail.cc   || [] },
  ]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const n = normaliseEmail(entry?.email);
      if (!n || excludeAddresses.has(n) || seen.has(n)) continue;
      seen.add(n);
      // Render as "Name <addr>" when a name is present, else bare address.
      const display = entry?.name
        ? `${entry.name} <${entry.email}>`
        : String(entry?.email || "");
      out.push({ field, address: display });
    }
  }
  return out;
}

function showConfirm({ recipients, mode, t, onConfirm, onCancel }) {
  ensureStyles();

  const overlay = document.createElement("div");
  overlay.className = "rag-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "rag-title");

  const modal = document.createElement("div");
  modal.className = "rag-modal";
  if (detectDark()) modal.classList.add("rag-dark");

  const title = document.createElement("h2");
  title.className = "rag-title";
  title.id = "rag-title";
  const iconSpan = document.createElement("span");
  iconSpan.className = "rag-icon";
  iconSpan.setAttribute("aria-hidden", "true");
  iconSpan.appendChild(buildWarningIcon());
  const titleText = document.createElement("span");
  titleText.textContent = t(mode === "reply-all" ? "titleReplyAll" : "titleSend", {
    count: recipients.length,
  });
  title.appendChild(iconSpan);
  title.appendChild(titleText);

  const body = document.createElement("p");
  body.className = "rag-body";
  body.textContent = t(mode === "reply-all" ? "bodyReplyAll" : "bodySend", {
    count: recipients.length,
  });

  const list = document.createElement("ul");
  list.className = "rag-list";
  for (const r of recipients) {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "rag-tag";
    tag.textContent = r.field;
    const text = document.createElement("span");
    const at = r.address.lastIndexOf("@");
    if (at >= 0) {
      text.appendChild(document.createTextNode(r.address.slice(0, at + 1)));
      const dom = document.createElement("span");
      dom.className = "rag-domain";
      dom.textContent = r.address.slice(at + 1).replace(/>$/, "");
      text.appendChild(dom);
      // Re-append a closing ">" if this was a "Name <addr>" string.
      if (r.address.endsWith(">")) text.appendChild(document.createTextNode(">"));
    } else {
      text.textContent = r.address;
    }
    li.appendChild(tag);
    li.appendChild(text);
    list.appendChild(li);
  }

  const actions = document.createElement("div");
  actions.className = "rag-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "rag-btn rag-btn-cancel";
  cancelBtn.type = "button";
  cancelBtn.textContent = t("cancel");

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "rag-btn rag-btn-confirm";
  confirmBtn.type = "button";
  confirmBtn.textContent = t(mode === "reply-all" ? "confirmReplyAll" : "confirmSend");

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  modal.appendChild(title);
  modal.appendChild(body);
  modal.appendChild(list);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const previouslyFocused = document.activeElement;

  let settled = false;
  function close() {
    if (settled) return;
    settled = true;
    document.removeEventListener("keydown", onKey, true);
    clearTimeout(timeoutHandle);
    overlay.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      previouslyFocused.focus();
    }
  }

  function decideConfirm() { if (!settled) { onConfirm(); close(); } }
  function decideCancel()  { if (!settled) { onCancel();  close(); } }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      decideCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      decideConfirm();
    } else if (e.key === "Tab") {
      const items = [cancelBtn, confirmBtn];
      const i = items.indexOf(document.activeElement);
      const next = e.shiftKey
        ? items[(i - 1 + items.length) % items.length]
        : items[(i + 1) % items.length];
      next.focus();
      e.preventDefault();
    }
  }

  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) decideCancel();
  });
  cancelBtn.addEventListener("click", decideCancel);
  confirmBtn.addEventListener("click", decideConfirm);

  // Default focus on Cancel — confirming a mass send should require intent.
  setTimeout(() => cancelBtn.focus(), 0);

  // Resolve before the host's intercept budget expires.
  const timeoutHandle = setTimeout(decideCancel, HOOK_TIMEOUT_BUDGET_MS);
}

export function activate(api) {
  const disposables = [];

  api.i18n.addTranslations("en", {
    titleReplyAll: "Reply to all {count} recipients?",
    titleSend: "Send to {count} recipients?",
    bodyReplyAll:
      "Replying to all would deliver this message to {count} recipients. Confirm only if you intend to reach all of them.",
    bodySend:
      "{count} recipients are about to receive this message. Confirm only if you intend to send to all of them.",
    cancel: "Cancel",
    confirmReplyAll: "Reply all",
    confirmSend: "Send anyway",
    cancelledToast: "Send cancelled",
  });
  api.i18n.addTranslations("de", {
    titleReplyAll: "Allen {count} Empfängern antworten?",
    titleSend: "An {count} Empfänger senden?",
    bodyReplyAll:
      "Eine Antwort an alle würde diese Nachricht an {count} Empfänger senden. Nur fortfahren, wenn dies beabsichtigt ist.",
    bodySend:
      "{count} Empfänger erhalten diese Nachricht gleich. Nur fortfahren, wenn dies beabsichtigt ist.",
    cancel: "Abbrechen",
    confirmReplyAll: "Allen antworten",
    confirmSend: "Trotzdem senden",
    cancelledToast: "Senden abgebrochen",
  });

  // ─── Self-address tracker ──────────────────────────────────
  // Captured from outgoing sends so reply-all doesn't count the user themselves.
  const myAddresses = new Set(
    (api.storage.get("myAddresses") || []).map(normaliseEmail).filter(Boolean),
  );
  function rememberMyAddress(addr) {
    const n = normaliseEmail(addr);
    if (!n || myAddresses.has(n)) return;
    myAddresses.add(n);
    api.storage.set("myAddresses", [...myAddresses]);
  }

  // ─── Threshold resolution (admin floor + user setting) ─────
  // Cached with a short TTL so admin updates propagate without a full reload.
  const ADMIN_TTL_MS = 30_000;
  let cachedAdminThreshold = null;
  let cachedAdminAt = 0;
  let adminFetchPromise = null;

  function fetchAdminThreshold() {
    const fresh = Date.now() - cachedAdminAt < ADMIN_TTL_MS;
    if (fresh) return Promise.resolve(cachedAdminThreshold);
    if (adminFetchPromise) return adminFetchPromise;
    adminFetchPromise = (async () => {
      try {
        const v = await api.admin.getConfig("forceThreshold");
        const n = Number(v);
        cachedAdminThreshold = Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
      } catch (err) {
        api.log.warn("Could not load admin forceThreshold", err);
        cachedAdminThreshold = null;
      } finally {
        cachedAdminAt = Date.now();
        adminFetchPromise = null;
      }
      return cachedAdminThreshold;
    })();
    return adminFetchPromise;
  }
  // Pre-warm so the first send doesn't race the network.
  fetchAdminThreshold().catch(() => {});

  function effectiveThreshold() {
    const userRaw = Number(api.plugin.settings.threshold);
    const userN = Number.isFinite(userRaw) && userRaw >= 1 ? Math.floor(userRaw) : 5;
    if (cachedAdminThreshold !== null && cachedAdminThreshold < userN) {
      return cachedAdminThreshold;
    }
    return userN;
  }

  function excludeSet() {
    return api.plugin.settings.excludeSelf === false ? new Set() : myAddresses;
  }

  // ─── onBeforeReplyAll: confirm before composer opens ───────
  disposables.push(
    api.hooks.onBeforeReplyAll(async (ctx) => {
      if (!ctx?.originalEmail) return;
      await fetchAdminThreshold();

      const recipients = collectReplyAllRecipients(ctx.originalEmail, excludeSet());
      const threshold = effectiveThreshold();
      if (recipients.length < threshold) return;

      return new Promise((resolve) => {
        showConfirm({
          recipients,
          mode: "reply-all",
          t: (k, params) => api.i18n.t(k, params),
          onConfirm: () => resolve(undefined),
          onCancel: () => {
            api.toast.info(api.i18n.t("cancelledToast"));
            resolve(false);
          },
        });
      });
    }),
  );

  // ─── onBeforeEmailSend: optional second-line guard ─────────
  disposables.push(
    api.hooks.onBeforeEmailSend(async (email) => {
      if (!email) return;
      // Always learn the user's send-addresses, even when the gate is off,
      // so excludeSelf works the moment the user enables it.
      rememberMyAddress(email.fromEmail);
      if (api.plugin.settings.warnOnSend === false) return;

      await fetchAdminThreshold();
      const recipients = collectOutgoingRecipients(email, excludeSet());
      const threshold = effectiveThreshold();
      if (recipients.length < threshold) return;

      return new Promise((resolve) => {
        showConfirm({
          recipients,
          mode: "send",
          t: (k, params) => api.i18n.t(k, params),
          onConfirm: () => resolve(undefined),
          onCancel: () => {
            api.toast.info(api.i18n.t("cancelledToast"));
            resolve(false);
          },
        });
      });
    }),
  );

  api.log.info("Reply-All Guardrail plugin activated");

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      document.querySelectorAll(".rag-overlay").forEach((el) => el.remove());
    },
  };
}
