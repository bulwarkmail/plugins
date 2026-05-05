/**
 * External Link Warning - intercepts clicks on external links and asks the
 * user to confirm before navigating to a domain that isn't on the trusted
 * list.
 *
 * Trusted-domain sources (merged, de-duplicated):
 *   1. Admin-managed list (api.admin.getConfig('trustedDomains'))
 *      - settable via /api/admin/plugins/external-link-warning/config
 *   2. Per-user list from plugin settings (trustedDomainsCsv)
 *   3. Locally-trusted domains added through the dialog's
 *      "Always trust ..." checkbox (kept in plugin storage)
 *
 * Demonstrates:
 *   - api.hooks.onBeforeExternalLink   (intercept hook, return false to cancel)
 *   - api.admin.getConfig              (read admin-managed config)
 *   - api.plugin.settings              (per-user settings schema)
 *   - api.storage                      (persisted "Always trust" choices)
 *   - api.i18n.addTranslations / t()   (localised dialog strings)
 */

const STYLE_ID = "plugin-external-link-warning-style";

const STYLES = `
.elw-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 100000;
  font-family: inherit;
  animation: elw-fade-in 0.12s ease-out;
}
.elw-modal {
  background: #ffffff;
  color: #0f172a;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 20px;
  max-width: 480px;
  width: 92%;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  animation: elw-pop 0.14s ease-out;
}
.elw-title {
  font-size: 16px; font-weight: 600;
  margin: 0 0 10px 0;
  display: flex; align-items: center; gap: 8px;
  color: inherit;
}
.elw-icon {
  display: inline-flex; width: 22px; height: 22px;
  color: #eab308;
  flex-shrink: 0;
}
.elw-body {
  font-size: 13px; line-height: 1.5;
  margin: 0 0 12px 0;
  color: #64748b;
}
.elw-domain {
  font-weight: 600;
  color: #0f172a;
}
.elw-url {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: #f1f5f9;
  color: #0f172a;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 8px 10px;
  word-break: break-all;
  margin: 0 0 14px 0;
  max-height: 120px;
  overflow: auto;
}
.elw-trust {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px;
  margin: 0 0 16px 0;
  cursor: pointer;
  user-select: none;
  color: inherit;
}
.elw-trust input { cursor: pointer; accent-color: #3b82f6; }
.elw-actions {
  display: flex; gap: 8px;
  justify-content: flex-end;
}
.elw-btn {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px; font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s, filter 0.15s;
}
.elw-btn:focus-visible {
  outline: 2px solid #94a3b8;
  outline-offset: 2px;
}
.elw-btn-cancel {
  background: transparent;
  border-color: #e2e8f0;
  color: #0f172a;
}
.elw-btn-cancel:hover { background: #f1f5f9; }
.elw-btn-continue {
  background: #3b82f6;
  color: #ffffff;
}
.elw-btn-continue:hover { filter: brightness(0.95); }

/* Dark mode (host applies .dark on <html>; built-in themes follow same convention) */
.dark .elw-modal,
.elw-modal.elw-dark {
  background: #18181b;
  color: #fafafa;
  border-color: #27272a;
}
.dark .elw-title,
.elw-modal.elw-dark .elw-title { color: #fafafa; }
.dark .elw-body,
.elw-modal.elw-dark .elw-body { color: #a1a1aa; }
.dark .elw-domain,
.elw-modal.elw-dark .elw-domain { color: #fafafa; }
.dark .elw-url,
.elw-modal.elw-dark .elw-url {
  background: #0a0a0a;
  color: #fafafa;
  border-color: #27272a;
}
.dark .elw-icon,
.elw-modal.elw-dark .elw-icon { color: #ca8a04; }
.dark .elw-btn-cancel,
.elw-modal.elw-dark .elw-btn-cancel {
  border-color: #27272a;
  color: #fafafa;
}
.dark .elw-btn-cancel:hover,
.elw-modal.elw-dark .elw-btn-cancel:hover { background: #27272a; }
.dark .elw-btn:focus-visible,
.elw-modal.elw-dark .elw-btn:focus-visible { outline-color: #d4d4d4; }

@keyframes elw-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes elw-pop {
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

  // Luminance fallback - covers themes that don't use the .dark class.
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

function hostnameFromHref(href) {
  try {
    const url = new URL(href, window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isTrusted(hostname, list) {
  if (!hostname) return false;
  for (const d of list) {
    if (!d) continue;
    if (hostname === d) return true;
    if (hostname.endsWith("." + d)) return true;
  }
  return false;
}

function showWarning({ href, hostname, allowTrust, t, onContinue, onTrust }) {
  ensureStyles();

  const overlay = document.createElement("div");
  overlay.className = "elw-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "elw-title");

  const modal = document.createElement("div");
  modal.className = "elw-modal";
  if (detectDark()) modal.classList.add("elw-dark");

  const title = document.createElement("h2");
  title.className = "elw-title";
  title.id = "elw-title";
  const iconSpan = document.createElement("span");
  iconSpan.className = "elw-icon";
  iconSpan.setAttribute("aria-hidden", "true");
  iconSpan.appendChild(buildWarningIcon());
  const titleText = document.createElement("span");
  titleText.textContent = t("title");
  title.appendChild(iconSpan);
  title.appendChild(titleText);

  const body = document.createElement("p");
  body.className = "elw-body";
  const bodyTpl = t("body");
  const [before, after] = bodyTpl.split("{domain}");
  body.appendChild(document.createTextNode(before ?? ""));
  const domainSpan = document.createElement("span");
  domainSpan.className = "elw-domain";
  domainSpan.textContent = hostname;
  body.appendChild(domainSpan);
  body.appendChild(document.createTextNode(after ?? ""));

  const url = document.createElement("div");
  url.className = "elw-url";
  url.textContent = href;

  let trustCheckbox = null;
  if (allowTrust) {
    const trustLabel = document.createElement("label");
    trustLabel.className = "elw-trust";
    trustCheckbox = document.createElement("input");
    trustCheckbox.type = "checkbox";
    const trustText = document.createElement("span");
    trustText.textContent = t("trust").replace("{domain}", hostname);
    trustLabel.appendChild(trustCheckbox);
    trustLabel.appendChild(trustText);
    modal.appendChild(trustLabel);
  }

  const actions = document.createElement("div");
  actions.className = "elw-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "elw-btn elw-btn-cancel";
  cancelBtn.type = "button";
  cancelBtn.textContent = t("cancel");

  const continueBtn = document.createElement("button");
  continueBtn.className = "elw-btn elw-btn-continue";
  continueBtn.type = "button";
  continueBtn.textContent = t("continue");

  actions.appendChild(cancelBtn);
  actions.appendChild(continueBtn);

  modal.insertBefore(title, modal.firstChild);
  modal.insertBefore(body, title.nextSibling);
  modal.insertBefore(url, body.nextSibling);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const previouslyFocused = document.activeElement;

  function close() {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      previouslyFocused.focus();
    }
  }

  function commit() {
    const trusted = !!(trustCheckbox && trustCheckbox.checked);
    if (trusted) onTrust(hostname);
    onContinue();
    close();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Tab") {
      const focusables = [cancelBtn, continueBtn];
      if (trustCheckbox) focusables.unshift(trustCheckbox);
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
    if (e.target === overlay) close();
  });
  cancelBtn.addEventListener("click", close);
  continueBtn.addEventListener("click", commit);

  setTimeout(() => continueBtn.focus(), 0);
}

export function activate(api) {
  const disposables = [];

  api.i18n.addTranslations("en", {
    title: "Open external link?",
    body: "You're about to visit {domain}. This domain isn't on your trusted list — only continue if you recognise it.",
    cancel: "Cancel",
    continue: "Continue",
    trust: "Always trust {domain} on this device",
    trustedAdded: "Added to trusted domains",
  });
  api.i18n.addTranslations("de", {
    title: "Externen Link öffnen?",
    body: "Sie öffnen {domain}. Diese Domain ist nicht in Ihrer Vertrauensliste — fahren Sie nur fort, wenn Sie sie erkennen.",
    cancel: "Abbrechen",
    continue: "Fortfahren",
    trust: "{domain} auf diesem Gerät immer vertrauen",
    trustedAdded: "Zu vertrauenswürdigen Domains hinzugefügt",
  });

  let cachedAdminDomains = [];
  let adminFetched = false;
  let adminFetchPromise = null;

  function fetchAdminDomains() {
    if (adminFetched) return Promise.resolve(cachedAdminDomains);
    if (adminFetchPromise) return adminFetchPromise;
    adminFetchPromise = (async () => {
      try {
        const value = await api.admin.getConfig("trustedDomains");
        cachedAdminDomains = parseDomains(value);
      } catch (err) {
        api.log.warn("Could not load admin trusted-domains list", err);
        cachedAdminDomains = [];
      } finally {
        adminFetched = true;
      }
      return cachedAdminDomains;
    })();
    return adminFetchPromise;
  }

  function getLocalDomains() {
    const raw = api.storage.get("localTrusted");
    return Array.isArray(raw) ? raw : [];
  }

  function addLocalTrust(domain) {
    const list = getLocalDomains();
    if (!list.includes(domain)) {
      list.push(domain);
      api.storage.set("localTrusted", list);
      api.toast.success(api.i18n.t("trustedAdded"));
    }
  }

  async function getTrustedList() {
    const userDomains = parseDomains(api.plugin.settings.trustedDomainsCsv);
    const adminDomains = await fetchAdminDomains();
    const local = getLocalDomains();
    return [...new Set([...adminDomains, ...userDomains, ...local])];
  }

  // Pre-warm so the first click doesn't race against the network.
  fetchAdminDomains().catch(() => {});

  disposables.push(
    api.hooks.onBeforeExternalLink(async (ctx) => {
      const hostname = hostnameFromHref(ctx.href);
      if (!hostname) return; // not http(s) - leave alone (mailto:, tel:, etc.)

      const trusted = await getTrustedList();
      if (isTrusted(hostname, trusted)) return; // pass through

      // We can't await user input inside the intercept (5s hook timeout),
      // so cancel native navigation and re-open manually after confirmation.
      showWarning({
        href: ctx.href,
        hostname,
        allowTrust: api.plugin.settings.rememberLocalChoices !== false,
        t: (k) => api.i18n.t(k),
        onContinue: () => {
          const target = ctx.target || "_blank";
          window.open(ctx.href, target, "noopener,noreferrer");
        },
        onTrust: addLocalTrust,
      });
      return false;
    }),
  );

  api.log.info("External Link Warning plugin activated");

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      document.querySelectorAll(".elw-overlay").forEach((el) => el.remove());
    },
  };
}
