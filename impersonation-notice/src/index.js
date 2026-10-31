/**
 * Impersonation Notice
 *
 * Renders a persistent top-of-app banner whenever the active session is a
 * Stalwart master-user impersonation. The host says so with the
 * `impersonated` slot prop; older hosts don't pass it, so a username in
 * Stalwart's impersonation syntax "<target>%<master>" counts as well.
 *
 * v2 status: improved. Slot iframes now have full api access, so:
 *   - The banner reads admin-managed config (returnUrl, returnLabel,
 *     actorRoleLabel) directly via api.admin.getConfig at mount time.
 *   - The "Back to platform" button uses api.ui.openExternalUrl instead of
 *     window.open, and signs out through api.user.logout (auth:emit): the
 *     sandbox cannot call /api/auth/session itself.
 *   - The username comes from the app-top-banner slot props, which the host
 *     only passes with account:read.
 *   - The strip is the app's info bar (src/lib/banner.js), coloured by the
 *     app's theme. The old colour settings are gone: a fixed colour ignored
 *     dark and custom themes.
 *   - The admin page is still NOT exported, because the host hasn't mounted
 *     the 'admin-plugin-page' slot type yet. Admins configure via the
 *     existing plugin-config table (configSchema in the manifest).
 */

const { createElement: h, useEffect, useState } = require('react');
const slotApi = require('@plugin-host');

import { ImpersonationBar } from './lib/banner.js';

const DEFAULT_RETURN_LABEL = 'Back to platform';
const DEFAULT_ACTOR_ROLE_LABEL = 'as Platform Admin';

function looksLikeImpersonation(username) {
  return typeof username === 'string' && username.includes('%');
}

// Bulwark 1.11.1 and later sign an impersonated session in with the plain
// mailbox, so the username has no '%' any more. Hosts that know about the
// impersonation pass `impersonated: true` next to the username; the '%'
// check stays for older hosts and for people who sign in with the
// master-user syntax themselves.
function isImpersonated(props) {
  return props?.impersonated === true || looksLikeImpersonation(props?.username);
}

function parseImpersonatedMailbox(props) {
  if (!isImpersonated(props)) return null;
  const username = typeof props?.username === 'string' ? props.username : '';
  return username.split('%')[0] || null;
}

function pickString(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

// ─── Banner slot component ────────────────────────────────────

function ImpersonationBanner(props) {
  const mailbox = parseImpersonatedMailbox(props);
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState({
    returnUrl: pickString(props?.returnUrl, ''),
    returnLabel: DEFAULT_RETURN_LABEL,
    actorRoleLabel: DEFAULT_ACTOR_ROLE_LABEL,
  });

  // Pull admin-managed labels from plugin config. The host's
  // extraProps may also include a returnUrl override (legacy); admin config
  // wins because it is the canonical source.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await slotApi.admin.getAllConfig().catch(() => null);
        if (cancelled) return;
        if (all && typeof all === 'object') {
          setCfg((prev) => ({
            returnUrl: pickString(all.returnUrl, prev.returnUrl),
            returnLabel: pickString(all.returnLabel, DEFAULT_RETURN_LABEL),
            actorRoleLabel: pickString(all.actorRoleLabel, DEFAULT_ACTOR_ROLE_LABEL),
          }));
        }
      } catch (err) {
        slotApi.log.warn('impersonation-notice: could not read admin config', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!mailbox) return null;

  async function handleReturn() {
    if (busy) return;
    setBusy(true);
    // Open the platform first, while the click still counts as a user
    // gesture for the new tab, and before signing out tears this banner
    // down along with the rest of the app.
    if (cfg.returnUrl) {
      try {
        await slotApi.ui.openExternalUrl(cfg.returnUrl, '_blank');
      } catch (err) {
        slotApi.log.warn('impersonation-notice: openExternalUrl failed', err);
      }
    }
    try {
      await slotApi.user.logout();
    } catch (err) {
      slotApi.log.warn('impersonation-notice: logout failed', err);
      setBusy(false);
    }
  }

  return h(ImpersonationBar, {
    mailbox,
    actorRoleLabel: cfg.actorRoleLabel,
    returnLabel: cfg.returnLabel,
    showReturn: !!cfg.returnUrl,
    busy,
    onReturn: handleReturn,
  });
}

// shouldShow runs in the background iframe. It accepts the host's
// extraProps so it can early-bail before mounting an empty slot iframe.
function shouldShow(extraProps) {
  return parseImpersonatedMailbox(extraProps) !== null;
}

export const slots = {
  'app-top-banner': {
    component: ImpersonationBanner,
    shouldShow,
    order: 50,
  },
};

// ─── Activate ─────────────────────────────────────────────────

export async function activate(api) {
  api.log.info('Impersonation Notice plugin activated');
}
