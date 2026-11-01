// The company's own link check: a JSON endpoint the admin names.
//
//   POST <endpointUrl>
//   Content-Type: application/json
//   Authorization: Bearer <token>        (only when the admin set a token)
//
//   {"url": "https://example.com/login?x=1", "host": "example.com"}
//
// Answer, HTTP 200:
//
//   {"verdict": "safe" | "unsafe" | "unknown", "reason": "...", "cacheSeconds": 600}
//
// `reason` (optional) is shown to the user with an unsafe verdict.
// `cacheSeconds` (optional, at most 3600) keeps the answer in memory for
// that long. Any other answer, an HTTP error or no answer within the
// plugin's time budget counts as "couldn't check".
//
// The endpoint receives the full URL. The request goes from the Bulwark
// server through the plugin proxy, which adds the token.

import { LookupError } from './safebrowsing.js';
import { latin1Bytes, sha256, toBase64 } from './sha256.js';
import { createCache } from './cache.js';

export const VERDICTS = ['safe', 'unsafe', 'unknown'];
const MAX_CACHE_SECONDS = 3600;
const MAX_REASON = 300;

/** The endpoint's JSON answer as `{ verdict, reason?, cacheSeconds }`; throws LookupError otherwise. */
export function parseAnswer(body) {
  let value = body;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new LookupError('The link check sent no JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LookupError('The link check sent no JSON object');
  if (!VERDICTS.includes(value.verdict)) throw new LookupError(`The link check sent an unknown verdict ${JSON.stringify(value.verdict)}`);
  const reason = typeof value.reason === 'string' ? value.reason.trim().slice(0, MAX_REASON) : '';
  const seconds = Number(value.cacheSeconds);
  const cacheSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_CACHE_SECONDS) : 0;
  return { verdict: value.verdict, ...(reason ? { reason } : {}), cacheSeconds };
}

/**
 * `request(url, init)` posts through api.proxy and resolves to
 * `{ ok, status, body, proxyError? }` with the body as text.
 * `check(endpointUrl, href, host)` resolves to `{ verdict, reason? }` or
 * throws LookupError.
 */
export function createEndpoint({ request, now = Date.now } = {}) {
  const cache = createCache({ now });

  async function check(endpointUrl, href, host, { signal } = {}) {
    // Keyed by a hash of the URL, so the cache holds no readable list of links.
    const key = toBase64(sha256(latin1Bytes(unescape(encodeURIComponent(`${endpointUrl}\n${href}`)))));
    const cached = cache.get(key);
    if (cached) return cached;
    let res;
    try {
      res = await request(endpointUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ url: href, host }),
        responseType: 'text',
        signal,
      });
    } catch (err) {
      throw new LookupError(`The link check failed: ${err?.message ?? err}`);
    }
    if (!res || res.proxyError || !res.ok) throw new LookupError(`The link check answered ${res?.proxyError ?? res?.status}`);
    const { cacheSeconds, ...result } = parseAnswer(res.body);
    cache.set(key, result, cacheSeconds * 1000);
    return result;
  }

  return { check, clear() { cache.clear(); } };
}
