// The api object for UI code. In the background instance activate() sets it;
// in a slot iframe it is the host module `@plugin-host`.

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

export function t(key, vars) {
  return getApi().i18n.t(key, vars);
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || ''); }
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return d.toLocaleDateString(getApi().i18n.getLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
