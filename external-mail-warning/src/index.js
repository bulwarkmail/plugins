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
 *   - Sender identity's own domain (outgoing only), when
 *     treatIdentityDomainAsSafe is enabled
 *
 * Migration notes vs. the pre-sandbox plugin:
 *   - The custom CSS-in-JS modal is GONE — replaced by api.ui.confirm.
 *   - The banner is now a slot component. shouldShow runs in the
 *     background iframe and decides whether to mount the banner iframe.
 *
 * v2 status: improved. Slot iframes now have full api access, so the banner
 * reads the admin-managed safe-domains list directly via
 * api.admin.getConfig('safeDomains') and computes its "external" set
 * accurately, instead of treating every From: address as external.
 */

const { createElement: h, useEffect, useState } = require('react');
const slotApi = require('@plugin-host');

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

function domainOf(address) {
  if (!address) return '';
  const at = String(address).lastIndexOf('@');
  if (at < 0) return '';
  return String(address).slice(at + 1).trim().toLowerCase();
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

function getSafeDomainsSync() {
  const userDomains = parseDomains(pluginApi?.plugin.settings.safeDomainsCsv);
  return [
    ...new Set(
      [...cachedAdminDomains, ...userDomains]
        .map(normaliseDomain)
        .filter(Boolean),
    ),
  ];
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
    myAddresses.has(String(s?.email || '').trim().toLowerCase()),
  );
}

async function rememberMyAddress(addr) {
  if (!addr) return;
  const norm = String(addr).trim().toLowerCase();
  if (!norm || myAddresses.has(norm)) return;
  myAddresses.add(norm);
  await pluginApi.storage.set('myAddresses', [...myAddresses]);
}

function formatSenderInline(s) {
  if (!s) return '';
  if (s.name && s.email) return `${s.name} <${s.email}>`;
  return s.email || s.name || '';
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
        const userRaw = slotApi.plugin?.settings?.safeDomainsCsv;
        const merged = [
          ...new Set(
            [...parseDomains(adminRaw), ...parseDomains(userRaw)]
              .map(normaliseDomain)
              .filter(Boolean),
          ),
        ];
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

  // Until the admin list resolves, default to "treat all as external" so we
  // don't flash a false-clean banner. shouldShow already gated us to
  // confirmed-external messages anyway.
  const safeList = safeDomains || [];
  const externals = externalSenders(email, safeList);
  const fails = authFailures(email);

  const labelParts = [];
  if (externals.length > 0) {
    labelParts.push(externals.length === 1 ? 'External sender' : 'External senders');
  }
  if (fails.length > 0) {
    labelParts.push(`${fails.join(', ')} failed`);
  }
  const labelText = labelParts.join(' · ');
  const fromText = externals.map(formatSenderInline).join(', ');

  return h(
    'div',
    {
      role: 'note',
      title: fromText,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 24px',
        background: 'rgba(245, 158, 11, 0.12)',
        borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
        color: '#92400e',
      },
    },
    h(
      'div',
      {
        style: {
          width: '40px', height: '40px', borderRadius: '9999px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          background: 'rgba(245, 158, 11, 0.25)',
          color: '#b45309',
          fontWeight: 700,
        },
        'aria-hidden': 'true',
      },
      '!',
    ),
    h(
      'div',
      { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
      h(
        'div',
        {
          style: {
            fontSize: '10px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            opacity: 0.75,
          },
        },
        labelText,
      ),
      fromText
        ? h('div', { style: { fontSize: '14px', fontWeight: 600 } }, fromText)
        : null,
    ),
  );
}

// shouldShow runs in the background iframe; it gets the host's extraProps
// (which include the email). It can synchronously read the cached admin
// domain list and the user's settings.
function shouldShowBanner(extraProps) {
  if (!pluginApi) return false;
  if (pluginApi.plugin.settings.warnOnIncoming === false) return false;

  const email = extraProps?.email;
  if (!email) return false;
  if (isFromSelf(email)) return false;

  const safe = getSafeDomainsSync();
  const externals = externalSenders(email, safe);
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
    if (pluginApi.plugin.settings.notifyOnIncomingExternal !== true) return;
    if (!notif || !notif.from) return;

    const senderEmail = notif.from.email;
    if (myAddresses.has(String(senderEmail || '').trim().toLowerCase())) return;

    const domain = domainOf(senderEmail);
    if (!domain) return;

    const safe = getSafeDomainsSync();
    if (isSafeDomain(domain, safe)) return;

    pluginApi.toast.warning(`New external email from ${domain}`);
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

  api.log.info('External Mail Warning plugin activated');
}
