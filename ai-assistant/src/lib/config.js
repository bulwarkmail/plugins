// Which AI service a request goes to: the one the administrator set up, or
// the user's own key when the administrator allows that and the user
// connected one. Plain data in, plain data out, so it is easy to test.

export const PROVIDERS = ['openai', 'anthropic'];

/** Used when neither the administrator nor the user picked a model. */
export const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
};

/** Suggested API address when a user connects their own key. */
export const OFFICIAL_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

/** Credential ids declared in manifest.json. */
export const ADMIN_CREDENTIALS = { openai: 'openai', anthropic: 'anthropic' };
export const OWN_CREDENTIALS = { openai: 'own-openai', anthropic: 'own-anthropic' };

/** An http(s) URL without a trailing slash, or null. */
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return trimmed;
}

export function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

function cleanModel(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

/** The services the administrator set up, in a fixed order. */
export function adminProviders(config = {}) {
  const out = [];
  for (const provider of PROVIDERS) {
    const baseUrl = normalizeBaseUrl(config[`${provider}BaseUrl`]);
    if (!baseUrl) continue;
    out.push({ provider, baseUrl, model: cleanModel(config[`${provider}Model`]) });
  }
  return out;
}

/**
 * The admin's switch for each 2.2 area (configSchema allow*). Context,
 * actions, Files, chat tools and every view are on unless switched off;
 * settings changes are off unless switched on (allowSettingsChanges).
 */
export const AREA_SWITCHES = {
  context: 'allowContext',
  actions: 'allowMoreActions',
  files: 'allowFiles',
  chat: 'allowChatTools',
  everywhere: 'allowEverywhere',
};

const flag = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value === true || value === 'true');

/** Whether the admin left an area on. */
export function areaAllowed(config = {}, area) {
  const key = AREA_SWITCHES[area];
  return key ? flag(config[key], true) : false;
}

/** Whether the admin allows the assistant to change users' settings (off by default). */
export function settingsChangesAllowed(config = {}) {
  return areaAllowed(config, 'actions') && flag(config.allowSettingsChanges, false);
}

/** Whether users may let the assistant remember notes (on unless switched off). */
export function memoryAllowed(config = {}) {
  return areaAllowed(config, 'chat') && flag(config.allowMemory, true);
}

/** Most messages one batch may change: the admin's batchLimit, 1 to 200 (default 50). */
export function batchLimit(config = {}) {
  const n = Number(config.batchLimit);
  return Number.isFinite(n) && n >= 1 ? Math.min(200, Math.floor(n)) : 50;
}

/** Whether a provider's model may get images: the admin's choice, else a guess from the address (images: 'auto' | 'yes' | 'no'). */
export function imagesAllowed(config = {}, endpoint = null) {
  if (!endpoint) return false;
  const choice = config[`${endpoint.provider}Images`];
  if (choice === 'yes') return true;
  if (choice === 'no') return false;
  if (endpoint.provider === 'anthropic') return true;
  // OpenAI's own service reads images, apart from a few text-only models;
  // other OpenAI-compatible servers (Ollama, vLLM, ...) can't be told apart.
  const official = /^https:\/\/api\.openai\.com(\/|$)/i.test(endpoint.baseUrl ?? '');
  return official && !/^(o3-mini|gpt-oss|gpt-3\.5)/i.test(endpoint.model ?? '');
}

/** Whether users may connect their own key (admin setting, off by default). */
export function userKeysAllowed(config = {}) {
  return config.allowUserKeys === true || config.allowUserKeys === 'true';
}

/**
 * The endpoint to use, or null when nothing is set up.
 *
 * config:   the plugin's admin config (non-secret fields)
 * prefs:    the user's choices ({ provider, model, useOwn, own: { provider, baseUrl, model } })
 * accounts: api.proxy.accounts()
 */
export function resolveEndpoint({ config = {}, prefs = {}, accounts = [] } = {}) {
  if (userKeysAllowed(config) && prefs.useOwn && prefs.own && PROVIDERS.includes(prefs.own.provider)) {
    const provider = prefs.own.provider;
    const credentialId = OWN_CREDENTIALS[provider];
    const account = accounts.find((a) => a && a.credentialId === credentialId && a.connected);
    if (account) {
      const wanted = normalizeBaseUrl(prefs.own.baseUrl) || OFFICIAL_BASE_URLS[provider];
      // The key is only ever sent to the server the user approved in the
      // host's dialog; keep the path the user typed, on that server.
      const path = new URL(wanted).pathname.replace(/\/+$/, '');
      const baseUrl = originOf(wanted) === account.origin ? wanted : `${account.origin}${path}`;
      return {
        provider,
        credentialId,
        baseUrl,
        origin: account.origin,
        model: cleanModel(prefs.own.model) || DEFAULT_MODELS[provider],
        own: true,
      };
    }
  }
  const list = adminProviders(config);
  if (list.length === 0) return null;
  const wanted = PROVIDERS.includes(prefs.provider) ? prefs.provider : config.defaultProvider;
  const pick = list.find((p) => p.provider === wanted) ?? list[0];
  return {
    provider: pick.provider,
    credentialId: ADMIN_CREDENTIALS[pick.provider],
    baseUrl: pick.baseUrl,
    origin: originOf(pick.baseUrl),
    model: cleanModel(prefs.model) || pick.model || DEFAULT_MODELS[pick.provider],
    own: false,
  };
}
