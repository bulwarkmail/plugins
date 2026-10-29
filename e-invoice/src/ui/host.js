// The api object for UI code. In the background instance activate() sets
// it; in a slot frame it is the host module `@plugin-host`.

let current = null;

export function setApi(api) {
  current = api;
}

export function getApi() {
  if (current) return current;
  // eslint-disable-next-line no-undef -- provided by the sandbox (CommonJS bundle)
  current = require('@plugin-host');
  return current;
}

export function i18n() {
  const api = getApi();
  return { t: (k, v) => api.i18n.t(k, v), has: (k) => api.i18n.has(k), locale: api.i18n.getLocale() };
}
