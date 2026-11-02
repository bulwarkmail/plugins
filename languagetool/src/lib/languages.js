// The languages LanguageTool checks, and how a language tag from Bulwark
// or the settings becomes a code LanguageTool takes.
//
// LanguageTool spells only in a variant: "en" checks grammar but no
// spelling, "en-GB" checks both. So English, German, Portuguese and Catalan
// always go out with a variant: the one the user or the admin prefers for
// that language, else a default.

/** Codes LanguageTool 6 answers to (GET /v2/languages), the ones we offer. */
export const LT_LANGUAGES = [
  'ar', 'ast-ES', 'be-BY', 'br-FR', 'ca-ES', 'ca-ES-valencia', 'crh-UA', 'da-DK',
  'de', 'de-AT', 'de-CH', 'de-DE', 'el-GR',
  'en', 'en-AU', 'en-CA', 'en-GB', 'en-NZ', 'en-US', 'en-ZA',
  'eo', 'es', 'es-AR', 'fa', 'fr', 'fr-BE', 'fr-CA', 'fr-CH', 'ga-IE', 'gl-ES',
  'it', 'ja-JP', 'km-KH', 'nb', 'nl', 'nl-BE', 'no', 'pl-PL',
  'pt', 'pt-AO', 'pt-BR', 'pt-MZ', 'pt-PT', 'ro-RO', 'ru-RU', 'sk-SK', 'sl-SI',
  'sv', 'ta-IN', 'tl-PH', 'uk-UA', 'zh-CN',
];

const KNOWN = new Set(LT_LANGUAGES);

/** Languages that need a variant for spelling, with the variant used when nobody chose one. */
export const VARIANT_DEFAULTS = { en: 'en-US', de: 'de-DE', pt: 'pt-PT', ca: 'ca-ES' };

/** The variants of a language that needs one, for the settings. */
export const VARIANTS = {
  en: ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-NZ', 'en-ZA'],
  de: ['de-DE', 'de-AT', 'de-CH'],
  pt: ['pt-PT', 'pt-BR', 'pt-AO', 'pt-MZ'],
  ca: ['ca-ES', 'ca-ES-valencia'],
};

/**
 * The language pickers: one entry for a language that needs a variant (the
 * variant is chosen separately), every code for the others.
 */
export const PICKER_LANGUAGES = [...new Set(LT_LANGUAGES.map((code) => (VARIANTS[baseOf(code)] ? baseOf(code) : code)))];

export function baseOf(code) {
  return String(code).split('-')[0].toLowerCase();
}

/** "de-de" → "de-DE", "ca-es-VALENCIA" → "ca-ES-valencia". */
export function normalizeTag(tag) {
  if (typeof tag !== 'string') return '';
  const parts = tag.trim().replace(/_/g, '-').split('-').filter(Boolean);
  if (!parts.length || !/^[A-Za-z]{2,3}$/.test(parts[0])) return '';
  return parts.map((p, i) => {
    if (i === 0) return p.toLowerCase();
    if (/^[A-Za-z]{2}$/.test(p)) return p.toUpperCase();
    return p.toLowerCase();
  }).join('-');
}

/** The first variant per language from a list such as "de-AT, en-GB", known ones only. */
export function cleanVariants(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const code = normalizeTag(raw);
    const base = baseOf(code);
    if (!code.includes('-') || !KNOWN.has(code) || seen.has(base)) continue;
    seen.add(base);
    out.push(code);
  }
  return out;
}

/**
 * The LanguageTool code for a tag, or null when LanguageTool doesn't check
 * that language. `variants` are the preferred variants (cleanVariants).
 */
export function toLtCode(tag, variants = []) {
  const code = normalizeTag(tag);
  if (!code) return null;
  const base = baseOf(code);
  const preferred = variants.find((v) => baseOf(v) === base);
  if (VARIANT_DEFAULTS[base]) {
    // A variant LanguageTool knows wins; the bare language or an unknown
    // region (en-IE) takes the preferred variant.
    if (code !== base && KNOWN.has(code)) return code;
    return preferred ?? VARIANT_DEFAULTS[base];
  }
  if (KNOWN.has(code)) return code;
  // Traditional Chinese and Nynorsk are not the languages LanguageTool checks.
  if (code === 'zh-TW' || code === 'zh-HK' || code.startsWith('zh-Hant') || base === 'nn') return null;
  if (KNOWN.has(base)) return base;
  // pl → pl-PL, ru → ru-RU: languages LanguageTool knows in one variant.
  const only = LT_LANGUAGES.filter((c) => baseOf(c) === base);
  return only.length ? only[0] : null;
}

/** Variants to send with language=auto: the chosen ones plus a default for each language that needs one. */
export function autoVariants(variants = []) {
  const out = cleanVariants(variants);
  for (const [base, fallback] of Object.entries(VARIANT_DEFAULTS)) {
    if (base === 'ca') continue;
    if (!out.some((v) => baseOf(v) === base)) out.push(fallback);
  }
  return out;
}

/**
 * The language a check goes out in.
 *
 * - The admin locked a fixed language: that one.
 * - The user chose a fixed language in the plugin: that one.
 * - Bulwark's writing language is set (not "auto"): that one.
 * - Otherwise the admin's default: a fixed language, or "auto" (detect).
 *
 * Returns { language, preferredVariants } (preferredVariants only with
 * "auto"; LanguageTool refuses it otherwise), or { unsupported: tag }.
 */
export function resolveLanguage({ writing = 'auto', admin = {}, prefs = {}, userMayChange = true } = {}) {
  const variants = cleanVariants(userMayChange && cleanVariants(prefs.variants).length ? prefs.variants : admin.variants);
  const adminLanguage = normalizeTag(admin.language) || 'auto';
  const userLanguage = userMayChange && prefs.language && prefs.language !== 'follow' ? normalizeTag(prefs.language) : '';
  let wanted;
  if (!userMayChange && adminLanguage !== 'auto') wanted = adminLanguage;
  else if (userLanguage) wanted = userLanguage;
  else if (writing && writing !== 'auto') wanted = writing;
  else wanted = adminLanguage;
  if (wanted === 'auto') return { language: 'auto', preferredVariants: autoVariants(variants) };
  const code = toLtCode(wanted, variants);
  return code ? { language: code } : { unsupported: wanted };
}

/** A mother tongue LanguageTool knows, or ''. */
export function cleanMotherTongue(value) {
  if (!value) return '';
  return toLtCode(value) ?? '';
}
