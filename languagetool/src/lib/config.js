// The administrator's settings (configSchema) and the user's own choices,
// read into one shape. Plain data in, plain data out.

import { cleanMotherTongue, cleanVariants, normalizeTag, toLtCode } from './languages.js';

export const PUBLIC_ORIGIN = 'https://api.languagetool.org';

/** Credential ids declared in manifest.json. */
export const CREDENTIALS = {
  /** The admin's server, no token (a self-hosted LanguageTool needs none). */
  server: 'server',
  /** The admin's server with the access token as a bearer header. */
  serverToken: 'server-token',
  /** api.languagetool.org; never gets the token. */
  public: 'public',
};

/** Comma, semicolon or line separated list, trimmed, without duplicates. */
export function list(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]/);
  const out = [];
  for (const raw of items) {
    const item = String(raw ?? '').trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

const bool = (value, fallback) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : fallback);

/** The server address without /v2/check, or null when it isn't an http(s) URL. */
export function normalizeServerUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v2(\/check)?$/i, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

/** The admin config as the plugin uses it, defaults filled in. */
export function readAdmin(config = {}) {
  const language = normalizeTag(config.defaultLanguage);
  return {
    serverUrl: normalizeServerUrl(config.serverUrl),
    allowPublic: bool(config.allowPublicApi, false),
    level: config.level === 'picky' ? 'picky' : 'default',
    language: language && language !== 'auto' && toLtCode(language) ? language : 'auto',
    variants: cleanVariants(config.preferredVariants),
    disabledRules: list(config.disabledRules),
    disabledCategories: list(config.disabledCategories).map((c) => c.toUpperCase()),
    words: list(String(config.wordList ?? '').split('\n')),
    userMayChange: bool(config.userMayChange, true),
  };
}

/**
 * Where checks go: the admin's server, the public API when the admin
 * allows it, or nowhere. `tokenSet`: the admin entered an access token
 * (api.proxy.accounts says the token credential is ready).
 */
export function endpointFor(admin, { tokenSet = false, noThirdPartyTraffic = false } = {}) {
  if (admin.serverUrl) {
    return {
      credentialId: tokenSet ? CREDENTIALS.serverToken : CREDENTIALS.server,
      base: admin.serverUrl,
      host: hostOf(admin.serverUrl),
      isPublic: false,
    };
  }
  if (!admin.allowPublic) return { off: 'not_set_up' };
  if (noThirdPartyTraffic) return { off: 'third_party' };
  return { credentialId: CREDENTIALS.public, base: PUBLIC_ORIGIN, host: hostOf(PUBLIC_ORIGIN), isPublic: true };
}

/** The user's stored choices, cleaned. */
export function readPrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const language = p.language && p.language !== 'follow' ? normalizeTag(p.language) : '';
  return {
    language: language && toLtCode(language) ? language : 'follow',
    variants: cleanVariants(p.variants),
    motherTongue: cleanMotherTongue(p.motherTongue),
    picky: typeof p.picky === 'boolean' ? p.picky : null,
    warnBeforeSend: p.warnBeforeSend === true,
    disabledRules: Array.isArray(p.disabledRules)
      ? p.disabledRules.filter((r) => r && typeof r.id === 'string' && r.id).map((r) => ({ id: r.id, label: typeof r.label === 'string' ? r.label : '' }))
      : [],
  };
}

/** Picky or default: the user's choice when they may choose, else the admin's. */
export function effectiveLevel(admin, prefs) {
  if (admin.userMayChange && typeof prefs.picky === 'boolean') return prefs.picky ? 'picky' : 'default';
  return admin.level;
}

/** Rule ids the user turned off, when they may. */
export function userDisabledRules(admin, prefs) {
  return admin.userMayChange ? prefs.disabledRules.map((r) => r.id) : [];
}
