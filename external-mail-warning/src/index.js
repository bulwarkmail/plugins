/**
 * External Mail Warning — guards the inbox in two directions:
 *
 *   1. Outgoing → onBeforeEmailSend asks the user to confirm via
 *      api.ui.confirm before sending to recipients outside the safe-domain
 *      list.
 *   2. Incoming → an `email-banner` slot flags messages from external
 *      senders (and optionally messages with failed SPF/DKIM/DMARC).
 *
 * Safe-domain sources (merged, de-duplicated):
 *   - Admin-managed list (api.admin.getConfig('safeDomains'))
 *   - Per-user list from plugin settings (safeDomainsCsv)
 *   - The domains of all the user's sending identities (and, outgoing, the
 *     From address's domain), when treatIdentityDomainAsSafe is enabled
 *
 * With no safe domains at all, incoming mail is not flagged as external
 * (every sender would be); only failed authentication raises the banner.
 *
 * Migration notes vs. the pre-sandbox plugin:
 *   - The custom CSS-in-JS modal is GONE — replaced by api.ui.confirm.
 *   - The banner is the kit's reader InfoBar (src/lib/banner.js).
 *     shouldShow runs in the
 *     background iframe and decides whether to mount the banner iframe.
 *
 * v2 status: improved. Slot iframes now have full api access, so the banner
 * reads the admin-managed safe-domains list directly via
 * api.admin.getConfig('safeDomains') and computes its "external" set
 * accurately, instead of treating every From: address as external.
 *
 * Retired: Bulwark 1.19 and later warn about external mail themselves
 * (Organisation > Security in the admin panel). The plugin steps back per
 * switch (api.host.features): no send confirm while Bulwark's recipient
 * warning is on, no banner and no toast while its sender label is on. See
 * src/lib/handover.js.
 */

const { createElement: h, useEffect, useState } = require('react');
const slotApi = require('@plugin-host');

import { SenderWarning } from './lib/banner.js';
import { coreConfirmsRecipients, coreLabelsSenders } from './lib/handover.js';

// ─── Domain helpers (shared by background + slot) ─────────────

function parseDomains(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((d) => normaliseDomain(String(d))).filter(Boolean);
  }
  return String(input)
    .split(/[\s,;]+/)
    .map(normaliseDomain)
    .filter(Boolean);
}

function normaliseDomain(raw) {
  let d = String(raw).trim().toLowerCase();
  if (!d) return '';
  d = d.replace(/^\*\./, '');
  d = d.replace(/^https?:\/\//, '');
  d = d.replace(/\/.*$/, '');
  return d;
}

// The bare address from "Name <addr>" (how the host formats recipients) or
// a plain "addr".
function addressOf(value) {
  const s = String(value || '').trim();
  const m = s.match(/<([^<>]*)>\s*$/);
  return (m ? m[1] : s).trim();
}

function domainOf(address) {
  const addr = addressOf(address);
  const at = addr.lastIndexOf('@');
  if (at < 0) return '';
  return addr.slice(at + 1).trim().toLowerCase();
}

// Domains of the user's own sending identities. Treated as safe by default
// (treatIdentityDomainAsSafe), so the user's own organisation is never
// "external" even before anyone fills in a safe-domain list.
async function loadIdentityDomains(api) {
  try {
    const identities = await api.user.getIdentities();
    const emails = (Array.isArray(identities) ? identities : [])
      .map((i) => String(i?.email || '').trim().toLowerCase())
      .filter(Boolean);
    return {
      emails,
      domains: [...new Set(emails.map(domainOf).filter(Boolean))],
    };
  } catch (err) {
    api.log.warn('Could not load sending identities', err);
    return { emails: [], domains: [] };
  }
}

function isSafeDomain(domain, list) {
  if (!domain) return false;
  for (const d of list) {
    if (!d) continue;
    if (domain === d) return true;
    if (domain.endsWith('.' + d)) return true;
  }
  return false;
}

function classifyRecipients(email, safeDomains, includeCcBcc) {
  const buckets = [{ field: 'To', list: email.to || [] }];
  if (includeCcBcc) {
    buckets.push({ field: 'Cc', list: email.cc || [] });
    buckets.push({ field: 'Bcc', list: email.bcc || [] });
  }
  const externals = [];
  for (const { field, list } of buckets) {
    for (const addr of list) {
      const domain = domainOf(addr);
      if (!domain) continue;
      if (!isSafeDomain(domain, safeDomains)) {
        externals.push({ field, address: addr, domain });
      }
    }
  }
  return externals;
}

function externalSenders(email, safeDomains) {
  if (!email || !Array.isArray(email.from)) return [];
  const out = [];
  for (const sender of email.from) {
    const addr = sender?.email;
    const domain = domainOf(addr);
    if (!domain) continue;
    if (!isSafeDomain(domain, safeDomains)) {
      out.push({ name: sender.name || '', email: addr, domain });
    }
  }
  return out;
}

// Auth-result analysis: any non-pass is suspicious. See original plugin
// header for the rationale on each set.
const SPF_BAD = new Set(['fail', 'softfail', 'temperror', 'permerror']);
const DKIM_BAD = new Set(['fail', 'policy', 'temperror', 'permerror']);
const IPREV_BAD = new Set(['fail', 'temperror', 'permerror']);

function dmarcFailed(dmarc) {
  if (!dmarc) return false;
  if (dmarc.result === 'fail' || dmarc.result === 'permerror' || dmarc.result === 'temperror') return true;
  if (dmarc.result === 'none' && (dmarc.policy === 'reject' || dmarc.policy === 'quarantine')) return true;
  return false;
}

function authFailures(email) {
  const auth = email?.auth;
  if (!auth) return [];
  const fails = [];
  if (auth.spf && SPF_BAD.has(auth.spf.result)) fails.push('SPF');
  if (auth.dkim && DKIM_BAD.has(auth.dkim.result)) fails.push('DKIM');
  if (dmarcFailed(auth.dmarc)) fails.push('DMARC');
  if (auth.iprev && IPREV_BAD.has(auth.iprev.result)) fails.push('rDNS');
  return fails;
}

// ─── Module state (background iframe) ─────────────────────────

let pluginApi = null;
let cachedAdminDomains = [];
let adminFetched = false;
let adminFetchPromise = null;
let myAddresses = new Set();
let identityDomains = [];

async function refreshIdentities() {
  const { emails, domains } = await loadIdentityDomains(pluginApi);
  identityDomains = domains;
  for (const e of emails) void rememberMyAddress(e);
}

function fetchAdminDomains() {
  if (adminFetched) return Promise.resolve(cachedAdminDomains);
  if (adminFetchPromise) return adminFetchPromise;
  adminFetchPromise = (async () => {
    try {
      const value = await pluginApi.admin.getConfig('safeDomains');
      cachedAdminDomains = parseDomains(value);
    } catch (err) {
      pluginApi.log.warn('Could not load admin safe-domains list', err);
      cachedAdminDomains = [];
    } finally {
      adminFetched = true;
    }
    return cachedAdminDomains;
  })();
  return adminFetchPromise;
}

function mergeSafeDomains(adminDomains, settings, ownDomains) {
  const userDomains = parseDomains(settings?.safeDomainsCsv);
  const own = settings?.treatIdentityDomainAsSafe !== false ? ownDomains : [];
  return [
    ...new Set(
      [...adminDomains, ...userDomains, ...own]
        .map(normaliseDomain)
        .filter(Boolean),
    ),
  ];
}

function getSafeDomainsSync() {
  return mergeSafeDomains(cachedAdminDomains, pluginApi?.plugin.settings, identityDomains);
}

async function getSafeDomainsForOutgoing(senderEmail) {
  await fetchAdminDomains();
  const merged = getSafeDomainsSync();
  if (pluginApi.plugin.settings.treatIdentityDomainAsSafe !== false) {
    const own = domainOf(senderEmail);
    if (own && !merged.includes(own)) merged.push(own);
  }
  return merged;
}

function isFromSelf(email) {
  if (!email || !Array.isArray(email.from)) return false;
  return email.from.some((s) =>
    myAddresses.has(addressOf(s?.email).toLowerCase()),
  );
}

async function rememberMyAddress(addr) {
  if (!addr) return;
  const norm = addressOf(addr).toLowerCase();
  if (!norm || myAddresses.has(norm)) return;
  myAddresses.add(norm);
  await pluginApi.storage.set('myAddresses', [...myAddresses]);
}

// ─── Slot: external-sender banner ─────────────────────────────
//
// The slot iframe has full api access in v2. We read the admin safe-domains
// list and the user's per-user list on mount so the banner can accurately
// label which senders are external (rather than treating every From: address
// as external like v1 did).

function useSafeDomains() {
  const [safeDomains, setSafeDomains] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const adminRaw = await slotApi.admin.getConfig('safeDomains').catch(() => null);
        const { domains } = await loadIdentityDomains(slotApi);
        const merged = mergeSafeDomains(parseDomains(adminRaw), slotApi.plugin?.settings, domains);
        if (!cancelled) setSafeDomains(merged);
      } catch (err) {
        slotApi.log.warn('external-mail-warning: safe-domain lookup failed', err);
        if (!cancelled) setSafeDomains([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return safeDomains;
}

function ExternalSenderBanner(props) {
  const email = props.email;
  const safeDomains = useSafeDomains();
  if (!email) return null;
  if (coreLabelsSenders(slotApi)) return null;

  // Until the lists resolve, default to "treat all as external" so we don't
  // flash a false-clean banner. shouldShow already gated us to confirmed-
  // external messages anyway. With no safe domains at all, nobody can be
  // told apart as external, so only auth failures are shown.
  const safeList = safeDomains || [];
  const externals = safeDomains && safeDomains.length === 0 ? [] : externalSenders(email, safeList);
  const fails = slotApi.plugin?.settings?.warnOnAuthFailure !== false ? authFailures(email) : [];
  if (externals.length === 0 && fails.length === 0) return null;

  return h(SenderWarning, { externals, fails });
}

// shouldShow runs in the background iframe; it gets the host's extraProps
// (which include the email). It can synchronously read the cached admin
// domain list and the user's settings.
function shouldShowBanner(extraProps) {
  if (!pluginApi) return false;
  if (coreLabelsSenders(pluginApi)) return false;
  if (pluginApi.plugin.settings.warnOnIncoming === false) return false;

  const email = extraProps?.email;
  if (!email) return false;
  if (isFromSelf(email)) return false;

  // With no safe domains known at all (no admin or user list, no identity
  // domains) every sender would count as external, so only auth failures
  // can raise the banner.
  const safe = getSafeDomainsSync();
  const externals = safe.length > 0 ? externalSenders(email, safe) : [];
  const fails =
    pluginApi.plugin.settings.warnOnAuthFailure !== false
      ? authFailures(email)
      : [];

  return externals.length > 0 || fails.length > 0;
}

export const slots = {
  'email-banner': {
    component: ExternalSenderBanner,
    shouldShow: shouldShowBanner,
    order: 50,
  },
};

// ─── Hooks ────────────────────────────────────────────────────

export const hooks = {
  async onBeforeEmailSend(email) {
    if (!email || !pluginApi) return;
    // Bulwark asks itself; asking here too would be a second dialog.
    if (coreConfirmsRecipients(pluginApi)) return;

    // Remember the sending address so we recognise our own messages later.
    void rememberMyAddress(email.fromEmail);

    const safe = await getSafeDomainsForOutgoing(email.fromEmail);
    const includeCcBcc = pluginApi.plugin.settings.warnOnCcBcc !== false;
    const externals = classifyRecipients(email, safe, includeCcBcc);
    if (externals.length === 0) return; // all safe, pass through

    const list = externals
      .map((e) => `[${e.field}] ${e.address}`)
      .join('\n');

    const proceed = await pluginApi.ui.confirm({
      title: 'Send to external recipients?',
      message:
        `${externals.length} recipient(s) are outside your safe-domain list:\n\n${list}\n\n` +
        `Continue only if you intend to send to them.`,
      confirmLabel: 'Send anyway',
      cancelLabel: 'Cancel',
      danger: true,
    });

    if (!proceed) {
      pluginApi.toast.info('Send cancelled');
      return false;
    }
  },

  onNewEmailReceived(notif) {
    if (!pluginApi) return;
    if (coreLabelsSenders(pluginApi)) return;
    if (pluginApi.plugin.settings.notifyOnIncomingExternal !== true) return;
    if (!notif || !notif.from) return;

    // `from` is a list of { name, email }; accept a single one too.
    const senders = Array.isArray(notif.from) ? notif.from : [notif.from];
    const email = { from: senders.map((s) => (typeof s === 'string' ? { email: s } : s)) };
    if (isFromSelf(email)) return;

    const safe = getSafeDomainsSync();
    if (safe.length === 0) return;
    const externals = externalSenders(email, safe);
    if (externals.length === 0) return;

    pluginApi.toast.warning(`New external email from ${externals[0].domain}`);
  },

  // Keep the identity domains current when identities are added or changed.
  onIdentitiesLoaded() {
    if (pluginApi) void refreshIdentities();
  },
};

// ─── Activate ─────────────────────────────────────────────────

export async function activate(api) {
  pluginApi = api;

  const stored = (await api.storage.get('myAddresses')) || [];
  myAddresses = new Set(
    (Array.isArray(stored) ? stored : []).map((s) => String(s).trim().toLowerCase()),
  );

  // Pre-warm so the first send / first opened email doesn't race the network.
  fetchAdminDomains().catch(() => {});
  // The banner's shouldShow is synchronous, so have the identity domains
  // ready before the first message opens.
  await refreshIdentities();

  api.log.info('External Mail Warning plugin activated');
}
