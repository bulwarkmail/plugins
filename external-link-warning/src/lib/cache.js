// A small expiring cache, in memory only. Verdicts never go to api.storage:
// that is localStorage and would keep a list of the links a user clicked on
// the device.

export function createCache({ now = Date.now, max = 5000 } = {}) {
  const entries = new Map();

  const prune = () => {
    const t = now();
    for (const [key, entry] of entries) if (entry.expires <= t) entries.delete(key);
    // Still too many: drop the oldest.
    while (entries.size > max) entries.delete(entries.keys().next().value);
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      if (!(ttlMs > 0)) return;
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttlMs });
      if (entries.size > max) prune();
    },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}
