// Turn whatever went wrong into one of a few cases the user can act on.

/**
 * Why a lookup or an action failed, in words the user can be shown (the
 * error's own message is for the model): gone, folder, calendar, denied or other.
 */
export function failureReason(err) {
  if (err && typeof err.reason === 'string') return err.reason;
  const text = String(err?.message ?? err ?? '');
  if (/no message with that id|not ?found|no longer exists|doesn't exist any more|was deleted/i.test(text)) return 'gone';
  if (/no folder|mailbox/i.test(text)) return 'folder';
  if (/calendar|event/i.test(text) && /refus|reject|invalid|fail/i.test(text)) return 'calendar';
  if (/permission|not allowed|forbidden|denied|refused/i.test(text)) return 'denied';
  return 'other';
}

export class AiError extends Error {
  /**
   * code: not_configured | declined | bad_key | forbidden | not_found |
   *       rate_limit | quota | busy | timeout | too_long | bad_request |
   *       blocked | unreachable | server | cancelled | empty
   */
  constructor(code, { status, retryAfter, detail, partial } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AiError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (detail) this.detail = detail;
    if (partial) this.partial = partial;
  }
}

/** Seconds from a Retry-After value (seconds or an HTTP date), or undefined. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(1, Math.ceil(Number(text)));
  const date = Date.parse(text);
  if (!Number.isNaN(date)) return Math.max(1, Math.ceil((date - now) / 1000));
  return undefined;
}

function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}

function bodyJson(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body !== 'string' || !body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** The service's own error text and type, if it sent one. */
function serviceError(body) {
  const json = bodyJson(body);
  const err = json?.error;
  if (err && typeof err === 'object') {
    return { type: String(err.code ?? err.type ?? ''), message: String(err.message ?? '') };
  }
  if (typeof err === 'string') return { type: '', message: err };
  return { type: '', message: '' };
}

const PROXY_ERRORS = {
  no_credential: 'not_configured',
  timeout: 'timeout',
  rate_limited: 'rate_limit',
  blocked_address: 'blocked',
  wrong_origin: 'blocked',
  redirect_off_origin: 'blocked',
  unreachable: 'unreachable',
  too_large: 'too_long',
};

/**
 * An AiError for a response that is not ok: { status, headers, body, proxyError }.
 * `endpoint`: where it went. The proxy finds no credential for a plain-http
 * address it may not reach (one the server's admin didn't allow), which is a
 * blocked address, not a missing setup.
 */
export function errorFromResponse(res, endpoint) {
  const status = res?.status ?? 0;
  const retryAfter = parseRetryAfter(header(res?.headers, 'retry-after'));
  if (res?.proxyError === 'no_credential' && /^http:\/\//i.test(String(endpoint?.baseUrl ?? ''))) {
    return new AiError('blocked', { status });
  }
  if (res?.proxyError) {
    return new AiError(PROXY_ERRORS[res.proxyError] ?? 'unreachable', { status, retryAfter });
  }
  const { type, message } = serviceError(res?.body);
  const detail = message.slice(0, 300) || undefined;
  if (status === 401) return new AiError('bad_key', { status, detail });
  if (status === 403) return new AiError('forbidden', { status, detail });
  if (status === 404) return new AiError('not_found', { status, detail });
  if (status === 408 || status === 504) return new AiError('timeout', { status });
  if (status === 413) return new AiError('too_long', { status, detail });
  if (status === 429) {
    if (/insufficient_quota|billing|credit/i.test(`${type} ${message}`)) return new AiError('quota', { status, detail });
    return new AiError('rate_limit', { status, retryAfter, detail });
  }
  if (status === 529 || /overloaded/i.test(type)) return new AiError('busy', { status, retryAfter });
  if (status === 400 || status === 422) {
    if (/context|too long|too many tokens|maximum.*tokens/i.test(message)) return new AiError('too_long', { status, detail });
    if (/credit balance|billing/i.test(message)) return new AiError('quota', { status, detail });
    return new AiError('bad_request', { status, detail });
  }
  if (status === 503) return new AiError('busy', { status, retryAfter });
  return new AiError('server', { status, detail });
}

/** An AiError for an `error` event inside a streamed answer. */
export function errorFromStream(error, partial) {
  const type = String(error?.type ?? '');
  const detail = String(error?.message ?? '').slice(0, 300) || undefined;
  if (/rate_limit/.test(type)) return new AiError('rate_limit', { detail, partial });
  if (/overloaded/.test(type)) return new AiError('busy', { detail, partial });
  if (/authentication|invalid_api_key/.test(type)) return new AiError('bad_key', { detail, partial });
  if (/insufficient_quota/.test(type)) return new AiError('quota', { detail, partial });
  return new AiError('server', { detail, partial });
}

/** What to tell the user, in their language. t is api.i18n.t. */
export function messageFor(t, error, { host = '' } = {}) {
  const code = error instanceof AiError ? error.code : 'unreachable';
  if (code === 'rate_limit' && error.retryAfter) return t('error.rate_limit_wait', { seconds: error.retryAfter });
  const key = `error.${code}`;
  const text = t(key, { host });
  const base = text === key ? t('error.unreachable', { host }) : text;
  if ((code === 'bad_request' || code === 'not_found' || code === 'forbidden') && error.detail) {
    return `${base} ${t('error.service_said', { detail: error.detail })}`;
  }
  return base;
}
