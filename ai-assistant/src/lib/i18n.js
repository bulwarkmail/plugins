// The assistant's texts travel in its bundle, not in manifest.json: the
// webmail refuses a manifest over 512 KB, and 27 languages of texts don't
// fit there. Each frame hands them to api.i18n once, before the first t().

import { AREAS } from '../locales/index.js';

const done = new WeakSet();

/** Every text by language, all areas merged (tests use it as the fake api's translations). */
export function allStrings() {
  const out = {};
  for (const tables of Object.values(AREAS)) {
    for (const [lang, table] of Object.entries(tables)) out[lang] = { ...(out[lang] ?? {}), ...table };
  }
  return out;
}

/** Give the api the assistant's texts, once per api object. Returns the api. */
export function withStrings(api) {
  if (!api || typeof api !== 'object' || done.has(api)) return api;
  done.add(api);
  const add = api.i18n?.addTranslations;
  if (typeof add !== 'function') return api;
  for (const [lang, table] of Object.entries(allStrings())) add.call(api.i18n, lang, table);
  return api;
}
