// Turns what went wrong talking to Immich into a message key the user can
// read: a revoked API key, a missing key permission, a rate limit, a
// timeout. Never a stack trace or an HTTP dump.

export class ImmichError extends Error {
  /**
   * @param {string} key  i18n key, e.g. 'error.token'
   * @param {Record<string, string|number>} [vars]
   * @param {number} [status] HTTP status, when there was one
   */
  constructor(key, vars = {}, status = 0) {
    super(key);
    this.name = 'ImmichError';
    this.key = key;
    this.vars = vars;
    this.status = status;
  }
}

function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}

/** Short text from an Immich error body ({ message: string | string[] }), or ''. */
export function detailOf(body) {
  if (body == null) return '';
  if (typeof body === 'string') {
    const text = body.trim();
    if (/^[{[]/.test(text)) {
      try { return detailOf(JSON.parse(text)); } catch { /* not JSON after all */ }
    }
    if (/^<(!doctype|html)/i.test(text)) return '';
    return oneLine(text);
  }
  if (typeof body === 'object') {
    const msg = Array.isArray(body.message) ? body.message.filter((m) => typeof m === 'string').join('; ') : body.message;
    if (typeof msg === 'string' && msg) return oneLine(msg);
    if (typeof body.error === 'string') return oneLine(body.error);
  }
  return '';
}

function retryAfter(headers) {
  const seconds = Number(headers?.['retry-after']);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
}

/** An ImmichError for a proxy result that was not ok. */
export function errorFromResponse(res) {
  if (res.proxyError) {
    switch (res.proxyError) {
      case 'no_credential': return new ImmichError('error.not_connected', {}, res.status);
      case 'rate_limited': return new ImmichError('error.rate_limit', { seconds: retryAfter(res.headers) || 60 }, 429);
      case 'timeout': return new ImmichError('error.timeout', {}, 504);
      case 'unreachable': return new ImmichError('error.unreachable', {}, 502);
      case 'blocked_address': return new ImmichError('error.blocked', {}, 403);
      case 'too_large': return new ImmichError('error.too_large', {}, 413);
      case 'wrong_origin': return new ImmichError('error.wrong_server', {}, 403);
      default: return new ImmichError('error.proxy', { detail: detailOf(res.body) }, res.status);
    }
  }
  const status = res.status;
  const detail = detailOf(res.body);
  if (status === 401) return new ImmichError('error.token', {}, status);
  // A scoped API key without the permission: Immich names the one missing.
  if (status === 403) return new ImmichError('error.forbidden', { detail: detail || `HTTP ${status}` }, status);
  if (status === 404) return new ImmichError('error.not_found', {}, status);
  if (status === 413) return new ImmichError('error.too_large', {}, status);
  if (status === 429) return new ImmichError('error.rate_limit', { seconds: retryAfter(res.headers) || 60 }, status);
  if (status === 502 || status === 503 || status === 504) return new ImmichError('error.unavailable', {}, status);
  if (status >= 500) return new ImmichError('error.server', {}, status);
  if (status >= 400) return new ImmichError('error.rejected', { detail: detail || `HTTP ${status}` }, status);
  return new ImmichError('error.unexpected', { detail: `HTTP ${status}` }, status);
}

/** Any thrown value as an ImmichError (host API failures, timeouts, bugs). */
export function toImmichError(err) {
  if (err instanceof ImmichError) return err;
  const message = err && typeof err.message === 'string' ? err.message : String(err);
  if (/timed out|timeout/i.test(message)) return new ImmichError('error.timeout');
  if (/cancel|abort/i.test(message)) return new ImmichError('error.cancelled');
  if (/larger than|exceeds/i.test(message)) return new ImmichError('error.too_large');
  if (/permission|not allowed|not granted/i.test(message)) return new ImmichError('error.permission');
  if (/network|failed to fetch/i.test(message)) return new ImmichError('error.unreachable');
  return new ImmichError('error.unexpected', { detail: oneLine(message.split(/\r?\n/)[0]) });
}

/** The message for an error, in the user's language. */
export function errorText(t, err) {
  const e = toImmichError(err);
  return t(e.key, e.vars);
}
