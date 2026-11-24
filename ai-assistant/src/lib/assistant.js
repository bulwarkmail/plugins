// Glue between the api and the pure modules: the user's choices, the
// privacy notice before the first request, and running one task.

import { hostOf, resolveEndpoint, userKeysAllowed } from './config.js';
import { buildPrompt } from './prompts.js';
import { streamCompletion } from './client.js';
import { AiError } from './errors.js';

export const PREFS_KEY = 'prefs';

/**
 * The user's choices and their OK for a service go with the account to
 * every browser (Bulwark's settings sync; an older webmail ignores the
 * option and keeps them in this browser). The key itself is a credential on
 * the webmail server already.
 */
const SYNC = { sync: true };

/** Store a choice for every browser; in this browser only when the account's synced space is full. */
async function setSynced(api, key, value) {
  try {
    await api.storage.set(key, value, SYNC);
  } catch (err) {
    if (!/full/i.test(String(err?.message ?? err))) throw err;
    await api.storage.set(key, value);
  }
}

export const PROVIDER_LABELS = { openai: 'OpenAI-compatible', anthropic: 'Anthropic' };

export async function loadPrefs(api) {
  try {
    const value = await api.storage.get(PREFS_KEY);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export async function savePrefs(api, patch) {
  const next = { ...(await loadPrefs(api)), ...patch };
  await setSynced(api, PREFS_KEY, next);
  return next;
}

/** The admin config without secrets; {} when it can't be read. */
export async function loadConfig(api) {
  try {
    const config = await api.admin.getAllConfig();
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

/** Everything needed to decide where requests go. */
export async function loadSetup(api) {
  const [config, prefs] = await Promise.all([loadConfig(api), loadPrefs(api)]);
  let accounts = [];
  if (userKeysAllowed(config)) {
    try {
      accounts = (await api.proxy.accounts()) ?? [];
    } catch {
      accounts = [];
    }
  }
  return { config, prefs, accounts, endpoint: resolveEndpoint({ config, prefs, accounts }) };
}

/**
 * Where the user's OK for a service is kept. The version goes up when the
 * notice says more than before, so everyone reads the new one once (v2: 2.2,
 * which names everything that is sent).
 */
export const CONSENT_VERSION = 2;
export function consentKey(endpoint) {
  return `consent:v${CONSENT_VERSION}:${endpoint.provider}:${endpoint.origin}`;
}

/**
 * The privacy notice: which service, server and model, what goes with every
 * request, and what else goes with what is switched on. `parts`: keys of
 * further sentences (one per feature that sends more).
 */
export function privacyMessage(t, endpoint, { lookups = false, actions = false, parts = [] } = {}) {
  const lines = [
    t(endpoint.own ? 'privacy.message_own' : 'privacy.message', {
      provider: PROVIDER_LABELS[endpoint.provider],
      host: hostOf(endpoint.baseUrl),
      model: endpoint.model,
    }),
    t('privacy.always'),
  ];
  if (lookups) lines.push(t('privacy.lookups'));
  if (actions) lines.push(t('privacy.actions'));
  // Two areas may name the same sentence (pictures from attachments and from Files): once is enough.
  for (const key of new Set(parts)) lines.push(t(key));
  lines.push(t('privacy.until_asked'));
  return lines.join(' ');
}

/** Ask with the host's confirm dialog (not usable from inside a plugin dialog). `scope`: what privacyMessage names. */
export function confirmWithHost(api, scope = {}) {
  return (endpoint) => api.ui.confirm({
    title: api.i18n.t('privacy.title'),
    message: privacyMessage(api.i18n.t, endpoint, scope),
    confirmLabel: api.i18n.t('privacy.continue'),
    cancelLabel: api.i18n.t('common.cancel'),
  });
}

/**
 * Before the first request to a service, say which one it is and where the
 * text goes, and ask. Remembered per service and server. `ask(endpoint)`
 * resolves to true to go ahead.
 */
export async function ensureConsent(api, endpoint, ask = confirmWithHost(api)) {
  const key = consentKey(endpoint);
  if (await api.storage.get(key)) return true;
  const ok = (await ask(endpoint)) === true;
  if (ok) await setSynced(api, key, true);
  return ok;
}

/**
 * At start: hand the choices made in this browser before they synced to the
 * account. The host keeps the account's copy when it has one, so a browser
 * that never chose anything doesn't overwrite another one's choices.
 */
export async function syncChoices(api) {
  try {
    const keys = await api.storage.keys();
    for (const key of keys) {
      if (key !== PREFS_KEY && !key.startsWith(`consent:v${CONSENT_VERSION}:`)) continue;
      const value = await api.storage.get(key);
      if (value !== null && value !== undefined) await setSynced(api, key, value);
    }
  } catch { /* storage blocked: the choices stay in this browser */ }
}

/**
 * Run one task after a user action. Resolves to the answer; streams it to
 * onText. Rejects with AiError (not_configured, declined, cancelled, ...).
 */
export async function runTask(api, task, input, { onText, signal, setup, askConsent, timeouts = {} } = {}) {
  const { endpoint } = setup ?? await loadSetup(api);
  if (!endpoint) throw new AiError('not_configured');
  if (!(await ensureConsent(api, endpoint, askConsent))) throw new AiError('declined');
  if (signal?.aborted) throw new AiError('cancelled');
  const prompt = buildPrompt(task, { language: api.i18n.getLocale?.() ?? 'en', ...input });
  return streamCompletion(api, endpoint, prompt, { onText, signal, ...timeouts });
}
