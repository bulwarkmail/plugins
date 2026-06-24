/**
 * Libravatar Avatars Plugin
 *
 * Resolves Libravatar profile pictures via the `onAvatarResolve` transform
 * hook. Libravatar is a federated, privacy-friendly Gravatar alternative.
 * Hashing uses Web Crypto. The cache lives in plugin storage with separate
 * hit / miss TTLs.
 *
 * Modelled on the bundled Gravatar plugin. Differences:
 *   - Endpoint is seccdn.libravatar.org (the public delegation CDN).
 *   - No content-rating parameter — Libravatar has no rating system.
 *   - Federation note: a browser-sandboxed plugin can't do the Libravatar
 *     DNS-SRV delegation lookup, so this targets the central CDN, which
 *     still serves avatars for domains that delegate to it.
 */

const CACHE_KEY = 'cache.v1';
const CACHE_TTL_HIT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_TTL_MISS_MS = 24 * 60 * 60 * 1000; // 1 day
const HEAD_TIMEOUT_MS = 3000;
const MAX_CACHE_ENTRIES = 500;

const VALID_DEFAULTS = new Set([
  '404', 'mm', 'identicon', 'monsterid', 'wavatar', 'retro', 'robohash', 'pagan',
]);

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  return trimmed;
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

function buildAvatarUrl(hash, { size, defaultStyle }) {
  const params = new URLSearchParams({
    s: String(size),
    d: defaultStyle,
  });
  return `https://seccdn.libravatar.org/avatar/${hash}?${params.toString()}`;
}

function buildExistenceUrl(hash) {
  return `https://seccdn.libravatar.org/avatar/${hash}?s=1&d=404`;
}

async function libravatarExists(hash) {
  try {
    const res = await fetch(buildExistenceUrl(hash), {
      method: 'HEAD',
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function readSettings(raw) {
  const rawSize = typeof raw.size === 'number' ? raw.size : 160;
  const size = Math.min(512, Math.max(16, Math.round(rawSize)));
  const defaultStyle = VALID_DEFAULTS.has(raw.defaultStyle) ? raw.defaultStyle : '404';
  return { size, defaultStyle };
}

function loadCacheFromStored(stored) {
  const cache = new Map();
  if (!stored || typeof stored !== 'object') return cache;
  const now = Date.now();
  for (const [email, entry] of Object.entries(stored)) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof entry.expires === 'number' &&
      entry.expires > now &&
      (entry.url === null || typeof entry.url === 'string')
    ) {
      cache.set(email, entry);
    }
  }
  return cache;
}

function trimCache(cache) {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const sorted = [...cache.entries()].sort((a, b) => a[1].expires - b[1].expires);
  const dropCount = sorted.length - MAX_CACHE_ENTRIES;
  for (let i = 0; i < dropCount; i++) cache.delete(sorted[i][0]);
}

// ─── Module state, populated by activate() ────────────────────

let pluginApi = null;
let settings = readSettings({});
const cache = new Map();
const inFlight = new Map();

function rememberAndPersist(email, url) {
  const ttl = url ? CACHE_TTL_HIT_MS : CACHE_TTL_MISS_MS;
  cache.set(email, { url, expires: Date.now() + ttl });
  trimCache(cache);
  // Fire-and-forget; serialise to storage but don't block the resolver.
  void pluginApi.storage.set(CACHE_KEY, Object.fromEntries(cache));
}

async function resolveFor(email) {
  const cached = cache.get(email);
  if (cached && cached.expires > Date.now()) {
    return cached.url;
  }

  const existing = inFlight.get(email);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const hash = await sha256Hex(email);
      const url = buildAvatarUrl(hash, settings);
      const resolved =
        settings.defaultStyle === '404'
          ? (await libravatarExists(hash)) ? url : null
          : url;
      rememberAndPersist(email, resolved);
      return resolved;
    } finally {
      inFlight.delete(email);
    }
  })();

  inFlight.set(email, promise);
  return promise;
}

// ─── Activate ─────────────────────────────────────────────────

export async function activate(api) {
  pluginApi = api;
  settings = readSettings(api.plugin.settings || {});

  const stored = await api.storage.get(CACHE_KEY);
  const loaded = loadCacheFromStored(stored);
  cache.clear();
  for (const [k, v] of loaded) cache.set(k, v);

  api.log.info(
    `Libravatar activated (size=${settings.size}, default=${settings.defaultStyle}, cached=${cache.size})`,
  );
}

// ─── Hooks ────────────────────────────────────────────────────

export const hooks = {
  async onAvatarResolve(currentUrl, ctx) {
    if (currentUrl) return undefined; // defer to a higher-priority plugin
    const email = normalizeEmail(ctx?.email);
    if (!email) return undefined;
    const url = await resolveFor(email);
    return url ?? undefined;
  },
};
