// What went wrong with a request, as the status the host shows: "paused"
// when LanguageTool (or the webmail's proxy) asks to wait, "unavailable"
// for everything else. Each case has its own short message key.

export const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 10 * 60_000;

/** Retry-After in ms: seconds or an HTTP date; `fallback` when missing or odd. */
export function retryAfterMs(value, now = Date.now(), fallback = DEFAULT_PAUSE_MS) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).trim();
  let ms;
  if (/^\d+(\.\d+)?$/.test(s)) ms = Number(s) * 1000;
  else {
    const at = Date.parse(s);
    ms = Number.isNaN(at) ? NaN : at - now;
  }
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  return Math.min(Math.max(ms, 1000), MAX_PAUSE_MS);
}

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

function bodyText(body) {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    try { return JSON.stringify(body); } catch { return ''; }
  }
  return '';
}

const PROXY_ERRORS = {
  no_credential: 'error.not_set_up',
  blocked_address: 'error.blocked',
  timeout: 'error.timeout',
  unreachable: 'error.unreachable',
  wrong_origin: 'error.wrong_url',
  redirect_off_origin: 'error.wrong_url',
  too_many_redirects: 'error.wrong_url',
  bad_url: 'error.wrong_url',
  too_large: 'error.too_long',
  disabled: 'error.not_set_up',
  store_unavailable: 'error.unreachable',
};

/**
 * The failure in a proxy answer: { status, key, vars, retryAfterMs }, or
 * null when the answer is a usable 2xx.
 */
export function classifyResponse(res, { now = Date.now() } = {}) {
  if (!res || typeof res !== 'object') return { status: 'unavailable', key: 'error.network' };
  const code = Number(res.status) || 0;
  const text = bodyText(res.body);
  const proxyError = typeof res.proxyError === 'string' ? res.proxyError : '';
  if (code === 429 || proxyError === 'rate_limited') {
    return { status: 'paused', key: 'error.rate_limited', retryAfterMs: retryAfterMs(header(res.headers, 'retry-after'), now) };
  }
  // The webmail's "no third-party traffic" mode answers 403 with this code.
  if (code === 403 && /no-third-party-traffic/.test(text)) return { status: 'unavailable', key: 'error.third_party' };
  if (proxyError) return { status: 'unavailable', key: PROXY_ERRORS[proxyError] ?? 'error.unreachable' };
  if (code >= 200 && code < 300) return null;
  if (code === 400 || code === 413) {
    if (/language code|not a language|language.*not supported|unsupported language|no.*language.*(found|known)/i.test(text)) {
      return { status: 'unavailable', key: 'error.language' };
    }
    if (code === 413 || /exceeds the limit|text is too long|too long/i.test(text)) return { status: 'unavailable', key: 'error.too_long' };
    return { status: 'unavailable', key: 'error.request', vars: { status: code } };
  }
  if (code === 401 || code === 403) return { status: 'unavailable', key: 'error.auth' };
  if (code === 404 || code === 405) return { status: 'unavailable', key: 'error.wrong_url' };
  if (code === 502 || code === 503 || code === 504) return { status: 'unavailable', key: 'error.server', vars: { status: code } };
  return { status: 'unavailable', key: 'error.server', vars: { status: code || '?' } };
}

/** The JSON answer of a 2xx, or null when it doesn't look like LanguageTool's. */
export function parseCheckBody(body) {
  let json = body;
  if (typeof body === 'string') {
    try { json = JSON.parse(body); } catch { return null; }
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.matches)) return null;
  return json;
}
