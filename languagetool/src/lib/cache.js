// LanguageTool's answers per paragraph, so a paragraph that didn't change
// is never sent again (also not after a recheck or in another composer).
//
// The key is the paragraph's text (hashed) and everything that changes
// LanguageTool's answer: server, language and variants, mother tongue,
// level and the admin's turned-off rules and categories. The user's
// dictionary, ignored issues and own turned-off rules are applied after
// the cache, so changing them costs no request. Least recently used
// entries go first.

export const MAX_ENTRIES = 1000;

/** cyrb53: a fast 53-bit string hash (not for security). */
export function hash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The part of the key that stands for the settings. */
export function settingsKey(s) {
  return JSON.stringify([
    s.base, s.language, s.preferredVariants ?? [], s.motherTongue ?? '', s.level,
    [...(s.disabledRules ?? [])].sort(), [...(s.disabledCategories ?? [])].sort(),
  ]);
}

export function createCache(max = MAX_ENTRIES) {
  const map = new Map();
  const keyOf = (settings, text) => `${settings}\u0001${hash(text)}:${text.length}`;
  return {
    get(settings, text) {
      const key = keyOf(settings, text);
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(settings, text, matches) {
      const key = keyOf(settings, text);
      map.delete(key);
      map.set(key, matches);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
}
