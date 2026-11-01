// The admin's settings (configSchema), as the plugin reads them with
// api.config.get(): the fields that aren't secrets. The endpoint token and
// the Safe Browsing key stay on the server; the proxy adds them.

import { LOOKUP_MODES } from './lookup.js';
import { parseDomains } from './domains.js';

export const DEFAULT_CONFIG = Object.freeze({
  trustedDomains: [],
  lookup: 'off',
  endpointUrl: '',
  onFailure: 'open',
  onUnsafe: 'warn',
  skipTrusted: true,
});

/** An http(s) URL, else ''. */
function cleanUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

export function readConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    trustedDomains: parseDomains(c.trustedDomains),
    lookup: LOOKUP_MODES.includes(c.lookup) ? c.lookup : DEFAULT_CONFIG.lookup,
    endpointUrl: cleanUrl(c.endpointUrl),
    onFailure: c.onFailure === 'closed' ? 'closed' : 'open',
    onUnsafe: c.onUnsafe === 'block' ? 'block' : 'warn',
    skipTrusted: c.skipTrusted !== false && c.skipTrusted !== 'false',
  };
}
