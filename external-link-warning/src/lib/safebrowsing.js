// Google Safe Browsing v5, hashes:search in No-Storage Real-Time mode
// (https://developers.google.com/safe-browsing/reference/No.Storage.Real.Time.Mode).
//
// What Google gets: the first 4 bytes of the SHA-256 hash of each host and
// path expression of the link (at most 30), sent by the Bulwark server
// through the plugin proxy, which adds the API key. Never the URL itself,
// and never the user's address: the request comes from the server.
//
// Google answers with every full hash it lists under those prefixes; the
// link is unsafe when one of them is the full hash of one of its own
// expressions. Answers are cached in memory for the cacheDuration Google
// gives, at most 24 hours.

import { expressions } from './canonical.js';
import { fromBase64, latin1Bytes, sha256, toBase64 } from './sha256.js';
import { createCache } from './cache.js';

export const SAFE_BROWSING_ORIGIN = 'https://safebrowsing.googleapis.com';
export const ADVISORY_URL = 'https://developers.google.com/safe-browsing/v4/advisory';

/** The threat types a warning names; any other type in an answer is ignored. */
export const THREAT_TYPES = ['SOCIAL_ENGINEERING', 'MALWARE', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'];

const MAX_CACHE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MS = 5 * 60 * 1000;

/** A check that couldn't be done (network, HTTP error, bad answer). */
export class LookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LookupError';
  }
}

/** "300s" or "1.5s" (a protobuf Duration in JSON) in milliseconds; null when it isn't one. */
export function parseDuration(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

/** The expressions of a URL with their full hashes and 4-byte prefixes, all base64. */
export function hashesFor(href) {
  return expressions(href).map((expression) => {
    const full = sha256(latin1Bytes(expression));
    return { expression, full: toBase64(full), prefix: toBase64(full.subarray(0, 4)) };
  });
}

/** The threat types of one fullHashDetails list that count for opening a link. */
function enforceableThreats(details) {
  if (!Array.isArray(details)) return [];
  const out = [];
  for (const detail of details) {
    if (!detail || !THREAT_TYPES.includes(detail.threatType)) continue;
    const attributes = Array.isArray(detail.attributes) ? detail.attributes : [];
    // CANARY: not for enforcement. FRAME_ONLY: for frames, not for a page
    // the user opens.
    if (attributes.includes('CANARY') || attributes.includes('FRAME_ONLY')) continue;
    if (!out.includes(detail.threatType)) out.push(detail.threatType);
  }
  return out;
}

/**
 * `request(url, { signal })` does the GET (through api.proxy) and resolves to
 * `{ ok, status, body, proxyError? }` with the parsed JSON body.
 * `check(href)` resolves to `{ verdict: 'safe' | 'unsafe', threats }` or
 * throws LookupError.
 */
export function createSafeBrowsing({ request, now = Date.now } = {}) {
  // Full hash -> the threat types listed for it (possibly none that count).
  const listed = createCache({ now });
  // Prefix -> true: asked recently; a full hash under it that isn't listed is safe.
  const asked = createCache({ now });

  const verdictOf = (hashes) => {
    const threats = [];
    for (const { full } of hashes) {
      for (const threat of listed.get(full) ?? []) if (!threats.includes(threat)) threats.push(threat);
    }
    return { verdict: threats.length ? 'unsafe' : 'safe', threats };
  };

  async function check(href, { signal } = {}) {
    const hashes = hashesFor(href);
    if (hashes.length === 0) return { verdict: 'safe', threats: [] };
    const prefixes = [...new Set(hashes.map((h) => h.prefix))].filter((p) => !asked.get(p));
    if (prefixes.length === 0) return verdictOf(hashes);

    const query = prefixes.map((p) => `hashPrefixes=${encodeURIComponent(p)}`).join('&');
    let res;
    try {
      res = await request(`${SAFE_BROWSING_ORIGIN}/v5/hashes:search?${query}&alt=json`, { signal });
    } catch (err) {
      throw new LookupError(`Safe Browsing request failed: ${err?.message ?? err}`);
    }
    if (!res || res.proxyError || !res.ok) {
      throw new LookupError(`Safe Browsing answered ${res?.proxyError ?? res?.status}`);
    }
    const body = res.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LookupError('Safe Browsing sent no JSON object');
    if (body.fullHashes !== undefined && !Array.isArray(body.fullHashes)) throw new LookupError('Safe Browsing sent a bad answer');

    const ttl = Math.min(parseDuration(body.cacheDuration) ?? DEFAULT_CACHE_MS, MAX_CACHE_MS);
    // This answer decides this click even when Google says not to cache it.
    const answer = new Map();
    for (const entry of body.fullHashes ?? []) {
      const bytes = fromBase64(entry?.fullHash);
      if (!bytes || bytes.length !== 32) continue;
      const key = toBase64(bytes);
      answer.set(key, [...new Set([...(answer.get(key) ?? []), ...enforceableThreats(entry.fullHashDetails)])]);
    }
    for (const [key, threats] of answer) listed.set(key, threats, ttl);
    for (const prefix of prefixes) asked.set(prefix, true, ttl);
    const threats = [];
    for (const { full } of hashes) {
      for (const threat of answer.get(full) ?? listed.get(full) ?? []) if (!threats.includes(threat)) threats.push(threat);
    }
    return { verdict: threats.length ? 'unsafe' : 'safe', threats };
  }

  return { check, clear() { listed.clear(); asked.clear(); } };
}
