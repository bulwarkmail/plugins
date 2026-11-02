// The background frame: registers the checker, keeps the admin config and
// the user's choices current, and answers the host's checks and actions.
//
// Keeping current:
// - the admin config (api.config.get) and whether an access token is set
//   (api.proxy.accounts) are read at start and again when older than a
//   minute;
// - the user's choices are in api.storage, which the settings section
//   writes too. The host has no change event for storage, so this frame
//   reads the `rev` key every few seconds and before each check. A new
//   value reloads the choices, updates the send warning and asks the host
//   to check again (served from the cache, no request).

import { CREDENTIALS, endpointFor, readAdmin } from './config.js';
import { LT_LANGUAGES } from './languages.js';
import { createCache } from './cache.js';
import { createBudget, ignoreKey, runCheck } from './checker.js';
import { addToDictionary, disableRule, loadAll, loadRev } from './prefs.js';
import { wordMatcher } from './words.js';

export const CHECKER_ID = 'languagetool';
export const POLL_MS = 5000;
export const CONFIG_TTL_MS = 60_000;
const MAX_COMPOSERS = 50;

export function createBackground(api, {
  pollMs = POLL_MS,
  configTtlMs = CONFIG_TTL_MS,
  now = () => Date.now(),
  setInterval: every = (fn, ms) => setInterval(fn, ms),
  clearInterval: stop = (id) => clearInterval(id),
} = {}) {
  const cache = createCache();
  const budget = createBudget();
  const ignores = new Map();
  let handle = null;
  let timer = null;
  let admin = readAdmin({});
  let tokenSet = false;
  let configAt = -Infinity;
  let configSig = '';
  let prefsState = { prefs: null, dictionary: [], rev: undefined };
  let words = wordMatcher([]);
  let warn = false;

  const t = (key, vars) => api.i18n?.t?.(key, vars) ?? key;
  const features = () => api.host?.features ?? {};
  const endpoint = () => endpointFor(admin, { tokenSet, noThirdPartyTraffic: features().noThirdPartyTraffic === true });

  /** Read the admin config when it is stale; true when it changed. */
  async function refreshConfig(force = false) {
    if (!force && now() - configAt < configTtlMs) return false;
    configAt = now();
    const [raw, accounts] = await Promise.all([
      Promise.resolve().then(() => api.config.get()).catch(() => null),
      Promise.resolve().then(() => api.proxy.accounts()).catch(() => null),
    ]);
    if (raw && typeof raw === 'object') admin = readAdmin(raw);
    if (Array.isArray(accounts)) tokenSet = accounts.some((a) => a?.credentialId === CREDENTIALS.serverToken && a.connected);
    const sig = JSON.stringify([admin, tokenSet]);
    const changed = configSig !== '' && sig !== configSig;
    configSig = sig;
    return changed;
  }

  /** Read the user's choices when `rev` moved; true when they changed. */
  async function refreshPrefs(force = false) {
    if (!force) {
      const rev = await loadRev(api);
      if (rev === prefsState.rev) return false;
    }
    const before = prefsState.rev;
    prefsState = await loadAll(api);
    words = wordMatcher(prefsState.dictionary, admin.words);
    await applyWarn();
    return before !== undefined && prefsState.rev !== before;
  }

  async function applyWarn() {
    const want = prefsState.prefs?.warnBeforeSend === true;
    if (!handle || want === warn) return;
    try {
      await handle.update({ warnBeforeSend: want });
      warn = want;
    } catch (err) {
      api.log?.warn?.('Could not change the send warning', err?.message ?? err);
    }
  }

  function recheck() {
    if (handle) void Promise.resolve().then(() => handle.recheck()).catch(() => {});
  }

  /** Apply changes made elsewhere: the settings section, the admin. */
  async function sync() {
    const configChanged = await refreshConfig();
    if (configChanged) words = wordMatcher(prefsState.dictionary, admin.words);
    const prefsChanged = await refreshPrefs();
    if (configChanged || prefsChanged) recheck();
  }

  function ignoredFor(composerId) {
    let set = ignores.get(composerId);
    if (!set) {
      set = new Set();
      ignores.set(composerId, set);
      while (ignores.size > MAX_COMPOSERS) ignores.delete(ignores.keys().next().value);
    }
    return set;
  }

  async function check(request) {
    try {
      await sync();
    } catch { /* keep the last known settings */ }
    return runCheck(request, {
      api, admin, prefs: prefsState.prefs, dictionary: prefsState.dictionary, words, endpoint: endpoint(),
      cache, budget, now, t, ignored: ignores.get(request?.composerId),
    });
  }

  async function onAction(event) {
    const a = event?.annotation;
    if (!a || typeof a.text !== 'string' || !a.text) return;
    switch (event.action) {
      case 'ignore':
        if (typeof event.composerId === 'string') ignoredFor(event.composerId).add(ignoreKey(a.ruleId, a.text));
        return;
      case 'dictionary': {
        const { added, rev } = await addToDictionary(api, a.text);
        if (!added) return;
        await refreshPrefs(true);
        prefsState.rev = rev ?? prefsState.rev;
        recheck();
        return;
      }
      case 'disable-rule': {
        // With the admin's lock the user's own list isn't used: nothing to add.
        if (!admin.userMayChange || !a.ruleId) return;
        const { added, rev } = await disableRule(api, { id: a.ruleId, label: a.ruleLabel });
        if (!added) return;
        await refreshPrefs(true);
        prefsState.rev = rev ?? prefsState.rev;
        recheck();
        return;
      }
      default:
    }
  }

  async function activate() {
    await refreshConfig(true).catch(() => {});
    await refreshPrefs(true).catch(() => {});
    warn = prefsState.prefs?.warnBeforeSend === true;
    // Registered also when no server is set up: every check then says so
    // ("unavailable", with the reason), and the admin's later setup works
    // without the user reloading.
    handle = await api.composer.registerChecker({
      id: CHECKER_ID,
      label: 'LanguageTool',
      kinds: ['spelling', 'grammar', 'style', 'other'],
      debounceMs: 800,
      languages: LT_LANGUAGES,
      warnBeforeSend: warn,
      check,
      onAction,
    });
    api.host?.onFeaturesChange?.(() => recheck());
    timer = every(() => { void sync().catch(() => {}); }, pollMs);
    return handle;
  }

  function dispose() {
    if (timer !== null) stop(timer);
    timer = null;
  }

  return { activate, check, onAction, sync, dispose, get handle() { return handle; }, get admin() { return admin; } };
}
