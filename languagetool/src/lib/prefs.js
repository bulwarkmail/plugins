// The user's choices and personal dictionary in api.storage: this browser,
// this account. The settings section and the background frame both read
// and write them. Every write also sets `rev` to a new value; the
// background frame looks at `rev` every few seconds (and before each
// check) and applies a change: new filters, the send warning, a recheck.

import { readPrefs } from './config.js';
import { addWord, removeWord } from './words.js';

export const KEYS = { prefs: 'prefs', dictionary: 'dictionary', rev: 'rev' };

let seq = 0;
const newRev = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${(seq++).toString(36)}`;

async function get(api, key) {
  try {
    return await api.storage.get(key);
  } catch {
    return null;
  }
}

export async function loadRev(api) {
  return (await get(api, KEYS.rev)) ?? null;
}

/** { prefs, dictionary, rev } as stored, cleaned. */
export async function loadAll(api) {
  const [prefs, dictionary, rev] = await Promise.all([get(api, KEYS.prefs), get(api, KEYS.dictionary), get(api, KEYS.rev)]);
  return {
    prefs: readPrefs(prefs),
    dictionary: Array.isArray(dictionary) ? dictionary.filter((w) => typeof w === 'string') : [],
    rev: rev ?? null,
  };
}

async function bump(api) {
  const rev = newRev();
  await api.storage.set(KEYS.rev, rev);
  return rev;
}

/** Merge `patch` into the stored choices; resolves to the new rev. */
export async function savePrefs(api, patch) {
  const current = readPrefs(await get(api, KEYS.prefs));
  await api.storage.set(KEYS.prefs, { ...current, ...patch });
  return bump(api);
}

/** Add a word to the personal dictionary; resolves to { added, rev }. */
export async function addToDictionary(api, word) {
  const { dictionary } = await loadAll(api);
  const next = addWord(dictionary, word);
  if (next === dictionary || next.length === dictionary.length) return { added: false, rev: null };
  await api.storage.set(KEYS.dictionary, next);
  return { added: true, rev: await bump(api) };
}

export async function removeFromDictionary(api, word) {
  const { dictionary } = await loadAll(api);
  await api.storage.set(KEYS.dictionary, removeWord(dictionary, word));
  return bump(api);
}

/** Turn a rule off for this user; resolves to { added, rev }. */
export async function disableRule(api, rule) {
  const { prefs } = await loadAll(api);
  if (!rule?.id || prefs.disabledRules.some((r) => r.id === rule.id)) return { added: false, rev: null };
  const rev = await savePrefs(api, { disabledRules: [...prefs.disabledRules, { id: rule.id, label: rule.label ?? '' }] });
  return { added: true, rev };
}

export async function enableRule(api, ruleId) {
  const { prefs } = await loadAll(api);
  return savePrefs(api, { disabledRules: prefs.disabledRules.filter((r) => r.id !== ruleId) });
}
