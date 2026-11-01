/**
 * External Link Warning: asks before a link opens a domain that isn't on
 * the trusted list, and (2.0) checks links with the company's own link
 * check service and/or Google Safe Browsing first.
 *
 * Trusted domains (merged): the admin's list (configSchema trustedDomains),
 * the user's own (settings trustedDomainsCsv), and domains the user chose
 * to always trust on this device (plugin storage).
 *
 * The checks (configSchema lookup, see src/lib/lookup.js):
 *   - the company endpoint gets the full URL (src/lib/endpoint.js);
 *   - Google gets 4-byte hash prefixes only (src/lib/safebrowsing.js), and
 *     is off while the host's no-third-party mode is on.
 * Both go through the host's plugin proxy, which adds the token or key; the
 * plugin never sees them and reads only the admin's non-secret settings
 * (api.config.get). Verdicts are cached in memory only.
 *
 * The host's link hook fails open (a handler that throws or times out lets
 * the link open), so every refusal here is "return false and show the
 * dialog ourselves", and a link the user accepts is opened with
 * api.ui.openExternalUrl, which the host doesn't send back through this
 * plugin's own hook.
 */

import { hostnameFromHref, isTrusted, normaliseHref, parseDomains } from './lib/domains.js';
import { readConfig, DEFAULT_CONFIG } from './lib/config.js';
import { runChecks } from './lib/lookup.js';
import { createEndpoint } from './lib/endpoint.js';
import { createSafeBrowsing } from './lib/safebrowsing.js';
import { decide, dialogFor } from './lib/decide.js';
import { EN } from './lib/strings.js';
import { VerdictDialog } from './ui/verdict-dialog.js';

/** Admin settings are read again after this long (on the next click). */
const CONFIG_TTL_MS = 5 * 60 * 1000;
/** Which credentials the admin set up, read again after this long. */
const READY_TTL_MS = 60 * 1000;

export const CREDENTIALS = { google: 'safebrowsing', endpoint: 'linkcheck', endpointOpen: 'linkcheck-open' };

let pluginApi = null;
let localTrusted = [];
let config = { ...DEFAULT_CONFIG };
let configAt = 0;
let configPromise = null;
let ready = null;
let readyAt = 0;
let endpoint = null;
let google = null;

function tr(key, vars) {
  const i18n = pluginApi && pluginApi.i18n;
  if (i18n && typeof i18n.has === 'function' && i18n.has(key)) return i18n.t(key, vars);
  return String(EN[key] || key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
}

function warn(message, err) {
  try { pluginApi?.log?.warn(message, err); } catch { /* ignore */ }
}

function loadConfig() {
  if (configPromise) return configPromise;
  configPromise = (async () => {
    try {
      const raw = await pluginApi.config.get();
      config = readConfig(raw);
      configAt = Date.now();
    } catch (err) {
      // Keep what we had (the defaults at first): no lookups, the trusted list empty.
      warn('Could not read the admin settings', err);
    } finally {
      configPromise = null;
    }
    return config;
  })();
  return configPromise;
}

/** The admin settings: awaited the first time, refreshed in the background later. */
async function currentConfig() {
  if (!configAt) return loadConfig();
  if (Date.now() - configAt > CONFIG_TTL_MS) void loadConfig();
  return config;
}

/** Which checks the admin set up: the endpoint (with or without a token) and the key. */
async function readiness() {
  if (ready && Date.now() - readyAt < READY_TTL_MS) return ready;
  const list = await pluginApi.proxy.accounts();
  const configured = (id) => Array.isArray(list) && list.some((a) => a && a.credentialId === id && a.connected === true);
  ready = {
    endpointCredential: configured(CREDENTIALS.endpoint) ? CREDENTIALS.endpoint : configured(CREDENTIALS.endpointOpen) ? CREDENTIALS.endpointOpen : null,
    google: configured(CREDENTIALS.google),
  };
  readyAt = Date.now();
  return ready;
}

function proxyRequest(credentialId, responseType) {
  return (url, init = {}) => pluginApi.proxy.fetch(credentialId, url, { ...init, responseType: init.responseType ?? responseType });
}

function services() {
  return {
    ready: async () => {
      const r = await readiness();
      return { endpoint: !!r.endpointCredential, google: r.google };
    },
    endpoint: {
      check: async (url, href, host, opts) => {
        const r = await readiness();
        return endpoint(r.endpointCredential).check(url, href, host, opts);
      },
    },
    google: { check: (href, opts) => google.check(href, opts) },
  };
}

async function trustedList(cfg) {
  const userDomains = parseDomains(pluginApi.plugin.settings.trustedDomainsCsv);
  return [...new Set([...cfg.trustedDomains, ...userDomains, ...localTrusted])];
}

async function addLocalTrust(domain) {
  if (!domain || localTrusted.includes(domain)) return;
  localTrusted.push(domain);
  await pluginApi.storage.set('localTrusted', localTrusted);
  pluginApi.toast.success(tr('trustedAdded', { host: domain }));
}

/** What a click on `ctx` leads to (see decide.js). */
export async function decideFor(ctx, host) {
  const cfg = await currentConfig();
  const trusted = isTrusted(host, await trustedList(cfg));
  const check = trusted && cfg.skipTrusted
    ? { verdict: 'off' }
    : await runChecks({
      href: ctx.href,
      host,
      config: cfg,
      features: pluginApi.host?.features,
      services: services(),
      log: warn,
    });
  return decide({ host, text: ctx.text, trusted, check, config: cfg });
}

/** Show the dialog for a decision and open the link when the user says so. */
async function present(decision, ctx, host) {
  const dialog = dialogFor(decision, { host, href: ctx.href, text: ctx.text }, tr);
  if (!dialog) return;
  if (dialog.type === 'alert') {
    await pluginApi.ui.alert(dialog.options);
    return;
  }
  let open = false;
  if (dialog.type === 'confirm') open = (await pluginApi.ui.confirm(dialog.options)) === true;
  else open = (await pluginApi.ui.openDialog(dialog.options)) === 'open';
  if (!open) return;

  // "Always trust" only for a domain warning, never after an unsafe verdict.
  if (decision.kind === 'warn' && pluginApi.plugin.settings.rememberLocalChoices !== false) {
    const always = await pluginApi.ui.confirm({
      title: tr('trust.title', { host }),
      message: tr('trust.message', { host }),
      confirmLabel: tr('trust.confirm', { host }),
      cancelLabel: tr('trust.cancel'),
    });
    if (always) await addLocalTrust(host);
  }
  await pluginApi.ui.openExternalUrl(ctx.href, '_blank');
}

// ─── Activate ─────────────────────────────────────────────────

export async function activate(api) {
  pluginApi = api;
  config = { ...DEFAULT_CONFIG };
  configAt = 0;
  ready = null;
  readyAt = 0;
  const endpoints = new Map();
  endpoint = (credentialId) => {
    if (!endpoints.has(credentialId)) endpoints.set(credentialId, createEndpoint({ request: proxyRequest(credentialId, 'text') }));
    return endpoints.get(credentialId);
  };
  google = createSafeBrowsing({ request: proxyRequest(CREDENTIALS.google, 'json') });

  const stored = await api.storage.get('localTrusted');
  localTrusted = Array.isArray(stored) ? stored.slice() : [];

  // Pre-warm so the first click doesn't wait for the settings.
  loadConfig().catch(() => {});

  api.log.info('External Link Warning plugin activated');
}

// ─── Hooks ────────────────────────────────────────────────────

export const hooks = {
  async onBeforeExternalLink(raw) {
    if (!pluginApi || !raw?.href) return undefined;
    // One address end to end: the one the browser opens (WHATWG URL) is
    // what is checked, shown and opened. Bulwark 1.20 hands it over in this
    // form already; this keeps an older host from opening something else.
    const href = normaliseHref(raw.href);
    if (!href) return undefined; // mailto:, tel:, relative links: not ours
    const ctx = { ...raw, href };
    const host = hostnameFromHref(href);
    if (!host) return undefined;

    let decision;
    try {
      decision = await decideFor(ctx, host);
    } catch (err) {
      // Something of ours broke: the domain warning, never a silent open.
      warn('Link check failed', err);
      decision = { kind: config.onFailure === 'closed' ? 'closed' : 'warn', line: 'failed', mismatch: '' };
    }
    if (decision.kind === 'open') return undefined;

    // Stop the host's navigation and run the dialog on our own: awaiting it
    // here would leave the decision to the host's hook timeout.
    present(decision, ctx, host).catch((err) => warn('External link dialog failed', err));
    return false;
  },
};

// ─── Slots ────────────────────────────────────────────────────

export const slots = {
  'plugin-dialog': { component: VerdictDialog },
};
