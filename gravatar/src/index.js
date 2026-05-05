/**
 * Gravatar Avatars Plugin
 *
 * Resolves Gravatar profile pictures via the onAvatarResolve transform hook.
 *
 * Highlights:
 * - SHA-256 hashing through Web Crypto API (no dependencies)
 * - Persistent cache with separate hit / miss TTLs so freshly created
 *   profiles are eventually picked up while misses don't keep retrying
 * - In-flight request coalescing — concurrent avatar renders for the same
 *   address share a single HEAD request
 * - Aborts the existence check well before the 5s hook timeout
 * - Defers to higher-priority avatar plugins instead of overriding them
 */

const CACHE_KEY = "cache.v1";
const CACHE_TTL_HIT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_TTL_MISS_MS = 24 * 60 * 60 * 1000; // 1 day
const HEAD_TIMEOUT_MS = 3000;
const MAX_CACHE_ENTRIES = 500;

const VALID_RATINGS = new Set(["g", "pg", "r", "x"]);
const VALID_DEFAULTS = new Set([
  "404", "mp", "identicon", "monsterid", "wavatar", "retro", "robohash",
]);

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  return trimmed;
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

function buildAvatarUrl(hash, { size, rating, defaultStyle }) {
  const params = new URLSearchParams({
    s: String(size),
    r: rating,
    d: defaultStyle,
  });
  return `https://gravatar.com/avatar/${hash}?${params.toString()}`;
}

function buildExistenceUrl(hash) {
  // d=404 forces a real 404 when no profile exists. s=1 keeps the
  // upstream response payload tiny.
  return `https://gravatar.com/avatar/${hash}?s=1&d=404`;
}

async function gravatarExists(hash) {
  try {
    const res = await fetch(buildExistenceUrl(hash), {
      method: "HEAD",
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function readSettings(raw) {
  const rawSize = typeof raw.size === "number" ? raw.size : 160;
  const size = Math.min(512, Math.max(16, Math.round(rawSize)));
  const rating = VALID_RATINGS.has(raw.rating) ? raw.rating : "g";
  const defaultStyle = VALID_DEFAULTS.has(raw.defaultStyle)
    ? raw.defaultStyle
    : "404";
  return { size, rating, defaultStyle };
}

function loadCache(api) {
  const stored = api.storage.get(CACHE_KEY);
  const cache = new Map();
  if (!stored || typeof stored !== "object") return cache;
  const now = Date.now();
  for (const [email, entry] of Object.entries(stored)) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.expires === "number" &&
      entry.expires > now &&
      (entry.url === null || typeof entry.url === "string")
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

export function activate(api) {
  const settings = readSettings(api.plugin.settings || {});
  const { size, rating, defaultStyle } = settings;

  const cache = loadCache(api);
  const inFlight = new Map();
  let disposed = false;

  function rememberAndPersist(email, url) {
    if (disposed) return;
    const ttl = url ? CACHE_TTL_HIT_MS : CACHE_TTL_MISS_MS;
    cache.set(email, { url, expires: Date.now() + ttl });
    trimCache(cache);
    api.storage.set(CACHE_KEY, Object.fromEntries(cache));
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
          defaultStyle === "404"
            ? (await gravatarExists(hash)) ? url : null
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

  const sub = api.hooks.onAvatarResolve(async (currentUrl, ctx) => {
    // Defer to any plugin that already produced an avatar.
    if (currentUrl) return undefined;
    const email = normalizeEmail(ctx?.email);
    if (!email) return undefined;
    const url = await resolveFor(email);
    return url ?? undefined;
  });

  api.log.info(
    `Gravatar activated (size=${size}, rating=${rating}, default=${defaultStyle}, cached=${cache.size})`,
  );

  return {
    dispose: () => {
      disposed = true;
      sub.dispose();
      cache.clear();
      inFlight.clear();
    },
  };
}
