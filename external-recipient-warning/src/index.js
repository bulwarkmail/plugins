/**
 * External Recipient Warning - guards the inbox in two directions:
 *
 *   1. Outgoing  → intercepts the send and asks the user to confirm before
 *                  delivering to addresses outside the safe-domain list.
 *   2. Incoming  → renders a banner on opened messages whose sender is
 *                  outside the safe-domain list, and (optionally) toasts
 *                  on arrival of a new external email.
 *
 * Safe-domain sources (merged, de-duplicated):
 *   1. Admin-managed list (api.admin.getConfig('safeDomains'))
 *      - settable via /api/admin/plugins/external-recipient-warning/config
 *   2. Per-user list from plugin settings (safeDomainsCsv)
 *   3. Sender identity's own domain (outgoing only), when
 *      treatIdentityDomainAsSafe is enabled
 *
 * Demonstrates:
 *   - api.hooks.onBeforeEmailSend     (intercept hook, return false to cancel)
 *   - api.hooks.onNewEmailReceived    (observer hook, optional toast)
 *   - api.ui.registerEmailBanner      (slot - renders inside the email viewer)
 *   - api.admin.getConfig             (read admin-managed config)
 *   - api.plugin.settings             (per-user settings schema)
 *   - api.i18n.addTranslations / t()  (localised dialog strings)
 *
 * Note: onBeforeEmailSend has a 5s host-side timeout. The modal therefore
 * auto-resolves to "cancel" after 4.5s if the user has not responded, which
 * is fail-closed for a security feature - the user can simply click Send
 * again.
 */

const STYLE_ID = "plugin-external-recipient-warning-style";
const HOOK_TIMEOUT_BUDGET_MS = 4500;

const STYLES = `
.erw-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 100000;
  font-family: inherit;
  animation: erw-fade-in 0.12s ease-out;
}
.erw-modal {
  background: #ffffff;
  color: #0f172a;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 20px;
  max-width: 520px;
  width: 92%;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  animation: erw-pop 0.14s ease-out;
}
.erw-title {
  font-size: 16px; font-weight: 600;
  margin: 0 0 10px 0;
  display: flex; align-items: center; gap: 8px;
  color: inherit;
}
.erw-icon {
  display: inline-flex; width: 22px; height: 22px;
  color: #eab308;
  flex-shrink: 0;
}
.erw-body {
  font-size: 13px; line-height: 1.5;
  margin: 0 0 12px 0;
  color: #64748b;
}
.erw-list {
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
.erw-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  word-break: break-all;
}
.erw-tag {
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
.erw-domain {
  font-weight: 600;
  color: #0f172a;
}
.erw-actions {
  display: flex; gap: 8px;
  justify-content: flex-end;
}
.erw-btn {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px; font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s, filter 0.15s;
}
.erw-btn:focus-visible {
  outline: 2px solid #94a3b8;
  outline-offset: 2px;
}
.erw-btn-cancel {
  background: transparent;
  border-color: #e2e8f0;
  color: #0f172a;
}
.erw-btn-cancel:hover { background: #f1f5f9; }
.erw-btn-send {
  background: #f59e0b;
  color: #ffffff;
}
.erw-btn-send:hover { filter: brightness(0.95); }

/* Dark mode (host applies .dark on <html>; built-in themes follow the same convention) */
.dark .erw-modal,
.erw-modal.erw-dark {
  background: #18181b;
  color: #fafafa;
  border-color: #27272a;
}
.dark .erw-title,
.erw-modal.erw-dark .erw-title { color: #fafafa; }
.dark .erw-body,
.erw-modal.erw-dark .erw-body { color: #a1a1aa; }
.dark .erw-list,
.erw-modal.erw-dark .erw-list {
  background: #0a0a0a;
  color: #fafafa;
  border-color: #27272a;
}
.dark .erw-tag,
.erw-modal.erw-dark .erw-tag {
  background: #27272a;
  color: #d4d4d8;
}
.dark .erw-domain,
.erw-modal.erw-dark .erw-domain { color: #fafafa; }
.dark .erw-icon,
.erw-modal.erw-dark .erw-icon { color: #ca8a04; }
.dark .erw-btn-cancel,
.erw-modal.erw-dark .erw-btn-cancel {
  border-color: #27272a;
  color: #fafafa;
}
.dark .erw-btn-cancel:hover,
.erw-modal.erw-dark .erw-btn-cancel:hover { background: #27272a; }
.dark .erw-btn:focus-visible,
.erw-modal.erw-dark .erw-btn:focus-visible { outline-color: #d4d4d4; }

@keyframes erw-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes erw-pop {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}

/* ─── Incoming-mail banner ─────────────────────────────── */
.erw-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 24px;
  margin: 0;
  background: rgba(245, 158, 11, 0.12);
  border-bottom: 1px solid rgba(245, 158, 11, 0.25);
  color: #92400e;
  min-width: 0;
}
.erw-banner-icon-wrap {
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: rgba(245, 158, 11, 0.25);
  color: #b45309;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.erw-banner-icon-wrap svg {
  width: 20px;
  height: 20px;
}
.erw-banner-content {
  flex: 1;
  min-width: 0;
}
.erw-banner-eyebrow {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(146, 64, 14, 0.7);
  line-height: 1.4;
}
.erw-banner-body {
  font-size: 14px;
  font-weight: 600;
  color: #92400e;
  word-break: break-word;
  line-height: 1.3;
}
.erw-banner-from {
  display: block;
  font-size: 13px;
  font-weight: 400;
  color: rgba(146, 64, 14, 0.85);
  word-break: break-word;
  margin-top: 2px;
}
.dark .erw-banner,
.erw-banner.erw-dark {
  background: rgba(217, 119, 6, 0.15);
  border-bottom-color: rgba(217, 119, 6, 0.35);
  color: #fbbf24;
}
.dark .erw-banner-icon-wrap,
.erw-banner.erw-dark .erw-banner-icon-wrap {
  background: rgba(217, 119, 6, 0.3);
  color: #fbbf24;
}
.dark .erw-banner-eyebrow,
.erw-banner.erw-dark .erw-banner-eyebrow {
  color: rgba(251, 191, 36, 0.7);
}
.dark .erw-banner-body,
.erw-banner.erw-dark .erw-banner-body {
  color: #fbbf24;
}
.dark .erw-banner-from,
.erw-banner.erw-dark .erw-banner-from {
  color: rgba(251, 191, 36, 0.85);
}
`;

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

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
  if (html.classList.contains("dark") || body?.classList?.contains("dark"))
    return true;

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

function parseDomains(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((d) => normaliseDomain(String(d))).filter(Boolean);
  }
  return String(input)
    .split(/[\s,;]+/)
    .map(normaliseDomain)
    .filter(Boolean);
}

function normaliseDomain(raw) {
  let d = String(raw).trim().toLowerCase();
  if (!d) return "";
  d = d.replace(/^\*\./, "");
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/\/.*$/, "");
  return d;
}

function domainOf(address) {
  if (!address) return "";
  const at = String(address).lastIndexOf("@");
  if (at < 0) return "";
  return String(address).slice(at + 1).trim().toLowerCase();
}

function isSafeDomain(domain, list) {
  if (!domain) return false;
  for (const d of list) {
    if (!d) continue;
    if (domain === d) return true;
    if (domain.endsWith("." + d)) return true;
  }
  return false;
}

function classifyRecipients(email, safeDomains, includeCcBcc) {
  const buckets = [{ field: "To", list: email.to || [] }];
  if (includeCcBcc) {
    buckets.push({ field: "Cc", list: email.cc || [] });
    buckets.push({ field: "Bcc", list: email.bcc || [] });
  }

  const externals = [];
  for (const { field, list } of buckets) {
    for (const addr of list) {
      const domain = domainOf(addr);
      if (!domain) continue;
      if (!isSafeDomain(domain, safeDomains)) {
        externals.push({ field, address: addr, domain });
      }
    }
  }
  return externals;
}

function showWarning({ externals, t, onSend, onCancel }) {
  ensureStyles();

  const overlay = document.createElement("div");
  overlay.className = "erw-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "erw-title");

  const modal = document.createElement("div");
  modal.className = "erw-modal";
  if (detectDark()) modal.classList.add("erw-dark");

  const title = document.createElement("h2");
  title.className = "erw-title";
  title.id = "erw-title";
  const iconSpan = document.createElement("span");
  iconSpan.className = "erw-icon";
  iconSpan.setAttribute("aria-hidden", "true");
  iconSpan.appendChild(buildWarningIcon());
  const titleText = document.createElement("span");
  titleText.textContent = t("title");
  title.appendChild(iconSpan);
  title.appendChild(titleText);

  const body = document.createElement("p");
  body.className = "erw-body";
  body.textContent = t("body").replace(
    "{count}",
    String(externals.length),
  );

  const list = document.createElement("ul");
  list.className = "erw-list";
  for (const ext of externals) {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "erw-tag";
    tag.textContent = ext.field;
    const text = document.createElement("span");
    const at = ext.address.lastIndexOf("@");
    if (at >= 0) {
      text.appendChild(
        document.createTextNode(ext.address.slice(0, at + 1)),
      );
      const dom = document.createElement("span");
      dom.className = "erw-domain";
      dom.textContent = ext.address.slice(at + 1);
      text.appendChild(dom);
    } else {
      text.textContent = ext.address;
    }
    li.appendChild(tag);
    li.appendChild(text);
    list.appendChild(li);
  }

  const actions = document.createElement("div");
  actions.className = "erw-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "erw-btn erw-btn-cancel";
  cancelBtn.type = "button";
  cancelBtn.textContent = t("cancel");

  const sendBtn = document.createElement("button");
  sendBtn.className = "erw-btn erw-btn-send";
  sendBtn.type = "button";
  sendBtn.textContent = t("sendAnyway");

  actions.appendChild(cancelBtn);
  actions.appendChild(sendBtn);

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

  function decideSend() {
    if (settled) return;
    onSend();
    close();
  }
  function decideCancel() {
    if (settled) return;
    onCancel();
    close();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      decideCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      decideSend();
    } else if (e.key === "Tab") {
      const focusables = [cancelBtn, sendBtn];
      const i = focusables.indexOf(document.activeElement);
      const next = e.shiftKey
        ? focusables[(i - 1 + focusables.length) % focusables.length]
        : focusables[(i + 1) % focusables.length];
      next.focus();
      e.preventDefault();
    }
  }

  document.addEventListener("keydown", onKey, true);

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) decideCancel();
  });
  cancelBtn.addEventListener("click", decideCancel);
  sendBtn.addEventListener("click", decideSend);

  // Default focus to Cancel - confirming destructive sends should require
  // intent, not muscle memory.
  setTimeout(() => cancelBtn.focus(), 0);

  // Hook timeout safety net: if the user is idle, resolve as cancelled
  // before the 5s host timeout fires (which would log an error and could
  // auto-disable the plugin).
  const timeoutHandle = setTimeout(decideCancel, HOOK_TIMEOUT_BUDGET_MS);
}

// React access (provided by the host) - lazy so externals are guaranteed set.
function getReact() {
  return globalThis.__PLUGIN_EXTERNALS__?.React;
}

function buildBannerIcon() {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.appendChild(svgEl("path", {
    d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
  }));
  svg.appendChild(svgEl("line", { x1: "12", y1: "9", x2: "12", y2: "13" }));
  svg.appendChild(svgEl("line", { x1: "12", y1: "17", x2: "12.01", y2: "17" }));
  return svg.outerHTML;
}

function formatSenderInline(s) {
  if (!s) return "";
  if (s.name && s.email) return `${s.name} <${s.email}>`;
  return s.email || s.name || "";
}

function externalSenders(email, safeDomains) {
  if (!email || !Array.isArray(email.from)) return [];
  const externals = [];
  for (const sender of email.from) {
    const addr = sender?.email;
    const domain = domainOf(addr);
    if (!domain) continue;
    if (!isSafeDomain(domain, safeDomains)) {
      externals.push({ name: sender.name || "", email: addr, domain });
    }
  }
  return externals;
}

// Authentication results that count as a failure worth surfacing.
// We treat anything that isn't an explicit `pass` (or neutral / no-record)
// as suspicious — including temperror/permerror, since phishing setups
// commonly exploit broken DNS to make verification fall over.
//
// `policy` (DKIM) means the message was rejected by local policy.
// `softfail` (SPF) is the typical signal of mail relayed via an
// unauthorised server — exactly what spoofing looks like.
const SPF_BAD = new Set(["fail", "softfail", "temperror", "permerror"]);
const DKIM_BAD = new Set(["fail", "policy", "temperror", "permerror"]);
const IPREV_BAD = new Set(["fail", "temperror", "permerror"]);

// DMARC needs more nuance: a `none` result against a domain whose own
// policy is `reject` or `quarantine` means the message did not align
// with a strict DMARC policy — strong spoofing signal even though the
// raw result string is "none".
function dmarcFailed(dmarc) {
  if (!dmarc) return false;
  if (dmarc.result === "fail" || dmarc.result === "permerror" || dmarc.result === "temperror") return true;
  if (dmarc.result === "none" && (dmarc.policy === "reject" || dmarc.policy === "quarantine")) return true;
  return false;
}

function authFailures(email) {
  const auth = email?.auth;
  if (!auth) return [];
  const fails = [];
  if (auth.spf && SPF_BAD.has(auth.spf.result)) fails.push("SPF");
  if (auth.dkim && DKIM_BAD.has(auth.dkim.result)) fails.push("DKIM");
  if (dmarcFailed(auth.dmarc)) fails.push("DMARC");
  if (auth.iprev && IPREV_BAD.has(auth.iprev.result)) fails.push("rDNS");
  return fails;
}

export function activate(api) {
  const disposables = [];

  api.i18n.addTranslations("en", {
    title: "Send to external recipients?",
    body: "{count} recipient(s) are outside your safe-domain list. Continue only if you intend to send to them.",
    cancel: "Cancel",
    sendAnyway: "Send anyway",
    cancelledToast: "Send cancelled",
    bannerLabelOne: "External sender",
    bannerLabelMany: "External senders",
    bannerAuthFailed: "{checks} failed",
    incomingToast: "New external email from {domain}",
  });
  api.i18n.addTranslations("de", {
    title: "An externe Empfänger senden?",
    body: "{count} Empfänger befinden sich außerhalb Ihrer Liste sicherer Domains. Nur fortfahren, wenn dies beabsichtigt ist.",
    cancel: "Abbrechen",
    sendAnyway: "Trotzdem senden",
    cancelledToast: "Senden abgebrochen",
    bannerLabelOne: "Externer Absender",
    bannerLabelMany: "Externe Absender",
    bannerAuthFailed: "{checks} fehlgeschlagen",
    incomingToast: "Neue externe E-Mail von {domain}",
  });

  // ─── Sync cache for the email banner ──────────────────────
  // The banner render is synchronous; admin config arrives asynchronously, so
  // we keep a snapshot and notify subscribers when the admin list lands.
  let cachedAdminDomains = [];
  let adminFetched = false;
  let adminFetchPromise = null;
  const cacheListeners = new Set();

  function notifyCacheListeners() {
    cacheListeners.forEach((fn) => {
      try { fn(); } catch { /* ignore */ }
    });
  }

  function fetchAdminDomains() {
    if (adminFetched) return Promise.resolve(cachedAdminDomains);
    if (adminFetchPromise) return adminFetchPromise;
    adminFetchPromise = (async () => {
      try {
        const value = await api.admin.getConfig("safeDomains");
        cachedAdminDomains = parseDomains(value);
      } catch (err) {
        api.log.warn("Could not load admin safe-domains list", err);
        cachedAdminDomains = [];
      } finally {
        adminFetched = true;
        notifyCacheListeners();
      }
      return cachedAdminDomains;
    })();
    return adminFetchPromise;
  }

  /** Synchronous merged list - admin (cached) + per-user. */
  function getSafeDomainsSync() {
    const userDomains = parseDomains(api.plugin.settings.safeDomainsCsv);
    return [
      ...new Set(
        [...cachedAdminDomains, ...userDomains]
          .map(normaliseDomain)
          .filter(Boolean),
      ),
    ];
  }

  // ─── Self-address tracker ─────────────────────────────────
  // Captured from outgoing sends so we can recognise the user's own messages
  // when they're viewed (e.g. in the Sent folder) and skip the banner.
  const myAddresses = new Set(
    (api.storage.get("myAddresses") || []).map((s) =>
      String(s).trim().toLowerCase(),
    ),
  );

  function rememberMyAddress(addr) {
    if (!addr) return;
    const norm = String(addr).trim().toLowerCase();
    if (!norm || myAddresses.has(norm)) return;
    myAddresses.add(norm);
    api.storage.set("myAddresses", [...myAddresses]);
    notifyCacheListeners();
  }

  function isFromSelf(email) {
    if (!email || !Array.isArray(email.from)) return false;
    return email.from.some((s) =>
      myAddresses.has(String(s?.email || "").trim().toLowerCase()),
    );
  }

  async function getSafeDomainsForOutgoing(senderEmail) {
    await fetchAdminDomains();
    const merged = getSafeDomainsSync();
    if (api.plugin.settings.treatIdentityDomainAsSafe !== false) {
      const own = domainOf(senderEmail);
      if (own && !merged.includes(own)) merged.push(own);
    }
    return merged;
  }

  // Pre-warm so the first send / first opened email doesn't race the network.
  fetchAdminDomains().catch(() => {});

  // ─── Outgoing: confirm modal ──────────────────────────────
  disposables.push(
    api.hooks.onBeforeEmailSend(async (email) => {
      if (!email) return;

      // Remember the sending address so the incoming banner can skip messages
      // the user themselves authored (Sent folder, self-Bcc, etc.).
      rememberMyAddress(email.fromEmail);

      const safe = await getSafeDomainsForOutgoing(email.fromEmail);
      const includeCcBcc = api.plugin.settings.warnOnCcBcc !== false;
      const externals = classifyRecipients(email, safe, includeCcBcc);
      if (externals.length === 0) return; // all recipients are safe - pass through

      return new Promise((resolve) => {
        showWarning({
          externals,
          t: (k) => api.i18n.t(k),
          onSend: () => resolve(undefined),
          onCancel: () => {
            api.toast.info(api.i18n.t("cancelledToast"));
            resolve(false);
          },
        });
      });
    }),
  );

  // ─── Incoming: email-viewer banner ────────────────────────
  if (api.plugin.settings.warnOnIncoming !== false) {
    function ExternalSenderBanner(props) {
      const React = getReact();
      if (!React) return null;
      const { useState, useEffect, createElement: h } = React;

      // Force a re-render when the admin list arrives.
      const [, bump] = useState(0);
      useEffect(() => {
        const fn = () => bump((n) => n + 1);
        cacheListeners.add(fn);
        return () => cacheListeners.delete(fn);
      }, []);

      // Skip the user's own outgoing messages.
      if (isFromSelf(props.email)) return null;

      const safe = getSafeDomainsSync();
      const externals = externalSenders(props.email, safe);
      const fails =
        api.plugin.settings.warnOnAuthFailure !== false
          ? authFailures(props.email)
          : [];

      // Trigger if either: sender is external OR authentication failed.
      if (externals.length === 0 && fails.length === 0) return null;

      const labelParts = [];
      if (externals.length > 0) {
        labelParts.push(
          api.i18n.t(
            externals.length === 1 ? "bannerLabelOne" : "bannerLabelMany",
          ),
        );
      }
      if (fails.length > 0) {
        labelParts.push(
          api.i18n.t("bannerAuthFailed").replace("{checks}", fails.join(", ")),
        );
      }
      const labelText = labelParts.join(" · ");

      // For from-text, prefer the externals list when present, otherwise show
      // the actual sender(s) so the user can see who failed authentication
      // even when their domain is "safe".
      const sendersForDisplay =
        externals.length > 0 ? externals : (props.email.from || []);
      const fromText = sendersForDisplay.map(formatSenderInline).join(", ");

      return h(
        "div",
        {
          className: "erw-banner" + (detectDark() ? " erw-dark" : ""),
          role: "note",
          title: fromText,
        },
        h("div", {
          className: "erw-banner-icon-wrap",
          "aria-hidden": "true",
          dangerouslySetInnerHTML: { __html: buildBannerIcon() },
        }),
        h(
          "div",
          { className: "erw-banner-content" },
          h("div", { className: "erw-banner-eyebrow" }, labelText),
          fromText && h("div", { className: "erw-banner-body" }, fromText),
        ),
      );
    }

    ensureStyles();
    disposables.push(
      api.ui.registerEmailBanner({
        shouldShow: () => true, // not invoked by the host today; kept for API spec
        render: ExternalSenderBanner,
      }),
    );
  }

  // ─── Incoming: optional toast on arrival ──────────────────
  if (api.plugin.settings.notifyOnIncomingExternal === true) {
    disposables.push(
      api.hooks.onNewEmailReceived((notif) => {
        if (!notif || !notif.from) return;
        const senderEmail = notif.from.email;
        if (myAddresses.has(String(senderEmail || "").trim().toLowerCase())) {
          return; // user's own message bouncing back
        }
        const domain = domainOf(senderEmail);
        if (!domain) return;
        const safe = getSafeDomainsSync();
        if (isSafeDomain(domain, safe)) return;
        api.toast.warning(
          api.i18n.t("incomingToast").replace("{domain}", domain),
        );
      }),
    );
  }

  api.log.info("External Recipient Warning plugin activated");

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      cacheListeners.clear();
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      document.querySelectorAll(".erw-overlay").forEach((el) => el.remove());
    },
  };
}
