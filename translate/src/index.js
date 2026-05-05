/**
 * Translate Plugin — translate received emails via a free public API.
 *
 * Adds an "email-banner" slot that offers to translate the open email into the
 * user's preferred language. Translation is proxied through the host route
 * /api/translate so API keys and rate limits stay server-side.
 *
 * Demonstrates:
 *   - api.ui.registerEmailBanner    (per-email banner)
 *   - api.email.getBody             (read full body of the open email)
 *   - api.http.post('/api/translate', ...)
 *   - api.plugin.settings           (target language, provider, auto-mode)
 *   - api.i18n                      (localised UI strings)
 */

function getReact() {
  return globalThis.__PLUGIN_EXTERNALS__?.React;
}
const h = (...args) => getReact().createElement(...args);
const useState = (...args) => getReact().useState(...args);
const useEffect = (...args) => getReact().useEffect(...args);
const useCallback = (...args) => getReact().useCallback(...args);

const STYLE_ID = "plugin-translate-style";

const STYLES = `
.tx-banner {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 12px;
  margin: 8px 0;
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 8px;
  background: var(--muted, #f8fafc);
  color: inherit;
  font-size: 13px;
  line-height: 1.5;
}
.tx-banner-row {
  display: flex; align-items: center; gap: 8px;
  flex-wrap: wrap;
}
.tx-banner-icon {
  display: inline-flex; width: 16px; height: 16px;
  flex-shrink: 0; opacity: 0.75;
}
.tx-banner-text { flex: 1; min-width: 0; }
.tx-banner-meta {
  font-size: 12px; opacity: 0.75;
}
.tx-btn {
  appearance: none;
  font: inherit;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px; font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border, #e2e8f0);
  background: var(--background, #ffffff);
  color: inherit;
  transition: background 0.15s, opacity 0.15s;
}
.tx-btn:hover:not(:disabled) { background: var(--accent, #f1f5f9); }
.tx-btn:disabled { opacity: 0.6; cursor: progress; }
.tx-btn-primary {
  background: var(--primary, #3b82f6);
  color: var(--primary-foreground, #ffffff);
  border-color: transparent;
}
.tx-btn-primary:hover:not(:disabled) { filter: brightness(0.95); background: var(--primary, #3b82f6); }
.tx-result {
  border-top: 1px dashed var(--border, #e2e8f0);
  padding-top: 8px;
  white-space: pre-wrap;
  word-wrap: break-word;
}
.tx-error {
  color: var(--destructive, #b91c1c);
  font-size: 12px;
}
`;

let pluginApi = null;

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function stripHtml(html) {
  if (!html) return "";
  if (typeof DOMParser === "undefined") return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, head").forEach((el) => el.remove());
    return (doc.body?.textContent || "").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

function pickPlainText(body, maxChars) {
  if (!body) return "";
  const raw = body.text && body.text.trim() ? body.text : stripHtml(body.html || "");
  const trimmed = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function buildIcon() {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  const paths = [
    "m5 8 6 6",
    "m4 14 6-6 2-3",
    "M2 5h12",
    "M7 2h1",
    "m22 22-5-10-5 10",
    "M14 18h6",
  ];
  for (const d of paths) {
    const p = document.createElementNS(svgNS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

function IconSpan() {
  return h("span", {
    className: "tx-banner-icon",
    "aria-hidden": "true",
    ref: (node) => {
      if (!node || node.firstChild) return;
      node.appendChild(buildIcon());
    },
  });
}

async function translate({ text, target, provider }) {
  const res = await pluginApi.http.post("/api/translate", {
    text,
    target,
    source: "auto",
    provider,
  });
  if (!res.ok) {
    const err = res.data && typeof res.data === "object" && "error" in res.data
      ? String(res.data.error)
      : `HTTP ${res.status}`;
    throw new Error(err);
  }
  return res.data;
}

function TranslateBanner({ email }) {
  const t = (k, p) => pluginApi.i18n.t(k, p);
  const settings = pluginApi.plugin.settings || {};
  const target = String(settings.targetLanguage || "en").toLowerCase();
  const provider = String(settings.provider || "mymemory").toLowerCase();
  const maxChars = Math.max(200, Math.min(5000, Number(settings.maxChars) || 4000));
  const auto = !!settings.autoTranslateForeign;

  const [state, setState] = useState({ status: "idle" });

  const run = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const body = await pluginApi.email.getBody(email.id);
      if (!body) throw new Error(t("noBody"));
      const source = pickPlainText(body, maxChars);
      if (!source) throw new Error(t("noBody"));

      const result = await translate({ text: source, target, provider });
      const detected = typeof result === "object" && result && "detectedSource" in result
        ? result.detectedSource
        : undefined;

      // No-op if the detected language already matches target.
      if (detected && detected.toLowerCase().split("-")[0] === target.split("-")[0]) {
        setState({
          status: "skipped",
          detected,
        });
        return;
      }

      setState({
        status: "done",
        translated: String(result.translatedText || ""),
        detected,
        truncated: source.length >= maxChars,
      });
    } catch (err) {
      setState({ status: "error", error: err && err.message ? err.message : String(err) });
    }
  }, [email.id, target, provider, maxChars, t]);

  // Auto-translate when enabled. Re-run if user opens a different email.
  useEffect(() => {
    setState({ status: "idle" });
    if (auto) run();
  }, [email.id, auto, run]);

  const showRetry = state.status === "done" || state.status === "error" || state.status === "skipped";

  return h(
    "div",
    { className: "tx-banner" },
    h(
      "div",
      { className: "tx-banner-row" },
      h(IconSpan, null),
      h(
        "div",
        { className: "tx-banner-text" },
        state.status === "idle" && t("offerTranslate", { target: target.toUpperCase() }),
        state.status === "loading" && t("loading"),
        state.status === "skipped" && t("alreadyInTarget", { target: target.toUpperCase() }),
        state.status === "done" &&
          h(
            "span",
            { className: "tx-banner-meta" },
            t("translatedFromTo", {
              source: state.detected ? state.detected.toUpperCase() : t("auto"),
              target: target.toUpperCase(),
            }),
            state.truncated ? " · " + t("truncated") : "",
          ),
        state.status === "error" && h("span", { className: "tx-error" }, state.error),
      ),
      state.status === "idle" &&
        h(
          "button",
          { className: "tx-btn tx-btn-primary", type: "button", onClick: run },
          t("translateBtn"),
        ),
      state.status === "loading" &&
        h(
          "button",
          { className: "tx-btn tx-btn-primary", type: "button", disabled: true },
          t("translatingBtn"),
        ),
      showRetry &&
        h(
          "button",
          { className: "tx-btn", type: "button", onClick: run },
          t("retryBtn"),
        ),
    ),
    state.status === "done" && h("div", { className: "tx-result" }, state.translated),
  );
}

export function activate(api) {
  pluginApi = api;
  ensureStyles();

  api.i18n.addTranslations("en", {
    offerTranslate: "Translate this message into {target}?",
    translateBtn: "Translate",
    translatingBtn: "Translating…",
    retryBtn: "Translate again",
    loading: "Translating…",
    translatedFromTo: "Translated from {source} to {target}",
    alreadyInTarget: "Already in {target}",
    truncated: "long message truncated",
    noBody: "No translatable text in this message",
    auto: "auto",
  });
  api.i18n.addTranslations("de", {
    offerTranslate: "Diese Nachricht in {target} übersetzen?",
    translateBtn: "Übersetzen",
    translatingBtn: "Wird übersetzt …",
    retryBtn: "Erneut übersetzen",
    loading: "Wird übersetzt …",
    translatedFromTo: "Übersetzt von {source} nach {target}",
    alreadyInTarget: "Bereits in {target}",
    truncated: "lange Nachricht gekürzt",
    noBody: "Kein übersetzbarer Text in dieser Nachricht",
    auto: "auto",
  });
  api.i18n.addTranslations("fr", {
    offerTranslate: "Traduire ce message en {target} ?",
    translateBtn: "Traduire",
    translatingBtn: "Traduction…",
    retryBtn: "Retraduire",
    loading: "Traduction…",
    translatedFromTo: "Traduit de {source} vers {target}",
    alreadyInTarget: "Déjà en {target}",
    truncated: "message long tronqué",
    noBody: "Aucun texte traduisible dans ce message",
    auto: "auto",
  });

  const disposable = api.ui.registerEmailBanner({
    shouldShow: () => true,
    render: TranslateBanner,
  });

  api.log.info("Translate plugin activated");

  return {
    dispose: () => {
      disposable.dispose();
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      pluginApi = null;
    },
  };
}
