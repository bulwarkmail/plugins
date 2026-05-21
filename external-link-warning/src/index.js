/**
 * External Link Warning — intercepts clicks on external links and asks the
 * user to confirm before navigating to a domain that isn't on the trusted
 * list.
 *
 * Trusted-domain sources (merged, de-duplicated):
 *   1. Admin-managed list (api.admin.getConfig('trustedDomains'))
 *   2. Per-user list from plugin settings (trustedDomainsCsv)
 *   3. Locally-trusted domains added through the confirm dialog's
 *      "always trust" follow-up (kept in plugin storage)
 *
 * Migrated to the sandboxed contract:
 *   - The custom CSS-in-JS modal is GONE — we now use api.ui.confirm.
 *   - window.open is replaced with api.ui.openExternalUrl.
 *   - All storage / admin lookups are awaited.
 *   - The hook is registered statically via the `hooks` export.
 *
 * v2 status: kept. The pre-sandbox plugin offered an inline "Always trust on
 * this device" checkbox in its custom modal; api.ui.confirm is binary so we
 * deliberately keep the simplification — the per-user `rememberLocalChoices`
 * setting still controls whether confirmed domains are remembered locally.
 * Showing a second confirm dialog after every "Continue" felt worse than
 * the binary trade-off.
 */

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

function hostnameFromHref(href) {
  try {
    // No `window.location` reliable origin inside a background iframe; treat
    // the href as absolute. Relative URLs (without a scheme) are very rare in
    // email bodies and aren't external anyway, so we ignore them.
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isTrusted(hostname, list) {
  if (!hostname) return false;
  for (const d of list) {
    if (!d) continue;
    if (hostname === d) return true;
    if (hostname.endsWith('.' + d)) return true;
  }
  return false;
}

// ─── Module-level state, populated by activate() ──────────────

let pluginApi = null;
let cachedAdminDomains = [];
let adminFetched = false;
let adminFetchPromise = null;
let localTrusted = [];

function fetchAdminDomains() {
  if (adminFetched) return Promise.resolve(cachedAdminDomains);
  if (adminFetchPromise) return adminFetchPromise;
  adminFetchPromise = (async () => {
    try {
      const value = await pluginApi.admin.getConfig('trustedDomains');
      cachedAdminDomains = parseDomains(value);
    } catch (err) {
      pluginApi.log.warn('Could not load admin trusted-domains list', err);
      cachedAdminDomains = [];
    } finally {
      adminFetched = true;
    }
    return cachedAdminDomains;
  })();
  return adminFetchPromise;
}

async function getTrustedList() {
  const userDomains = parseDomains(pluginApi.plugin.settings.trustedDomainsCsv);
  const adminDomains = await fetchAdminDomains();
  return [...new Set([...adminDomains, ...userDomains, ...localTrusted])];
}

async function addLocalTrust(domain) {
  if (!domain || localTrusted.includes(domain)) return;
  localTrusted.push(domain);
  await pluginApi.storage.set('localTrusted', localTrusted);
  pluginApi.toast.success(pluginApi.i18n?.t?.('trustedAdded') || 'Added to trusted domains');
}

// ─── Activate ─────────────────────────────────────────────────

export async function activate(api) {
  pluginApi = api;

  const stored = await api.storage.get('localTrusted');
  localTrusted = Array.isArray(stored) ? stored.slice() : [];

  // Pre-warm so the first click doesn't race against the network.
  fetchAdminDomains().catch(() => {});

  api.log.info('External Link Warning plugin activated');
}

// ─── Hooks ────────────────────────────────────────────────────

export const hooks = {
  async onBeforeExternalLink(ctx) {
    if (!pluginApi || !ctx?.href) return;

    const hostname = hostnameFromHref(ctx.href);
    if (!hostname) return; // mailto:, tel:, relative URLs — leave alone

    const trusted = await getTrustedList();
    if (isTrusted(hostname, trusted)) return; // pass through

    const proceed = await pluginApi.ui.confirm({
      title: 'Open external link?',
      message:
        `You're about to visit ${hostname}.\n\n${ctx.href}\n\n` +
        `This domain isn't on your trusted list — only continue if you recognise it.`,
      confirmLabel: 'Continue',
      cancelLabel: 'Cancel',
    });

    if (!proceed) return false; // cancel the navigation

    // We accepted, so re-open in a fresh tab; the host already cancelled the
    // native click because we asynchronously awaited the confirm.
    await pluginApi.ui.openExternalUrl(ctx.href, ctx.target || '_blank');

    // If the user wants to remember this domain, the host-side confirm can't
    // round-trip an extra checkbox today. We optimistically add the domain
    // when the setting allows it — users who don't want this can disable
    // `rememberLocalChoices` in plugin settings. This is a UX simplification
    // relative to the pre-sandbox plugin.
    if (pluginApi.plugin.settings.rememberLocalChoices !== false) {
      await addLocalTrust(hostname);
    }

    return false; // suppress the host's own navigation (we already opened it)
  },
};
