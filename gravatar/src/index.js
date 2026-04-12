/**
 * Gravatar Avatars Plugin — resolves Gravatar profile pictures for email contacts.
 *
 * Demonstrates:
 * - onAvatarResolve transform hook (avatar resolution pipeline)
 * - Web Crypto API for SHA-256 hashing (no external dependencies)
 * - In-memory caching with session-level storage fallback
 * - Configurable Gravatar parameters via plugin settings
 */

// ─── SHA-256 via Web Crypto API ───────────────────────────────
// Gravatar uses SHA-256 of the lowercased, trimmed email address.

async function sha256hex(str) {
  const encoded = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Gravatar URL builder ──────────────────────────────────────

function gravatarUrl(hash, { size, rating, defaultStyle }) {
  const params = new URLSearchParams({
    s: String(size),
    r: rating,
    d: defaultStyle,
  });
  return `https://gravatar.com/avatar/${hash}?${params}`;
}

// ─── Existence check for 404 mode ─────────────────────────────
// When defaultStyle is "404", Gravatar returns HTTP 404 for unknown addresses.
// We do a HEAD request so the browser never tries to render a broken image.

async function gravatarExists(url) {
  try {
    // Append &d=404 to force a 404 response if no profile exists
    const checkUrl = url.includes("?") ? `${url}&d=404` : `${url}?d=404`;
    const res = await fetch(checkUrl, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Plugin Activation ────────────────────────────────────────

export function activate(api) {
  const settings = api.plugin.settings;
  const size = typeof settings.size === "number" ? settings.size : 160;
  const rating = settings.rating || "g";
  const defaultStyle = settings.defaultStyle || "404";

  // Per-session in-memory cache: email → resolved URL (string) or null (no Gravatar)
  const cache = new Map();

  const avatarResolve = api.hooks.onAvatarResolve(
    async (currentUrl, context) => {
      const email = context?.email;
      if (!email) return undefined;

      const normalized = email.trim().toLowerCase();

      // Return cached result (including explicit null = "no Gravatar for this address")
      if (cache.has(normalized)) {
        return cache.get(normalized) ?? undefined;
      }

      const hash = await sha256hex(normalized);
      const url = gravatarUrl(hash, { size, rating, defaultStyle });

      if (defaultStyle === "404") {
        // Only use the URL if the profile actually exists
        const exists = await gravatarExists(url);
        if (!exists) {
          cache.set(normalized, null);
          return undefined;
        }
      }

      cache.set(normalized, url);
      return url;
    },
  );

  api.log.info(
    `Gravatar plugin activated (size=${size}, rating=${rating}, default=${defaultStyle})`,
  );

  return {
    dispose: () => {
      avatarResolve.dispose();
      cache.clear();
      api.log.info("Gravatar plugin deactivated");
    },
  };
}
