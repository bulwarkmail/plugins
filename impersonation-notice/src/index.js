/**
 * Impersonation Notice
 *
 * Renders a persistent top-of-app banner whenever the active session is a
 * Stalwart master-user impersonation. Detection is purely on the username:
 * Stalwart's impersonation syntax is "<target>%<master>", so any session
 * username containing '%' is treated as impersonated.
 *
 * v2 status: improved. Slot iframes now have full api access, so:
 *   - The banner reads admin-managed config (returnUrl, returnLabel, colours,
 *     actorRoleLabel) directly via api.admin.getConfig at mount time.
 *   - The "Back to platform" button uses api.ui.openExternalUrl instead of
 *     window.open.
 *   - The admin page is still NOT exported, because the host hasn't mounted
 *     the 'admin-plugin-page' slot type yet. Admins configure via the
 *     existing plugin-config table (configSchema in the manifest).
 */

const { createElement: h, useEffect, useState } = require('react');
const slotApi = require('@plugin-host');

const DEFAULT_RETURN_LABEL = 'Back to platform';
const DEFAULT_ACTOR_ROLE_LABEL = 'as Platform Admin';
const DEFAULT_BG_LIGHT = '#3b82f6';
const DEFAULT_FG = '#ffffff';

function looksLikeImpersonation(username) {
  return typeof username === 'string' && username.includes('%');
}

function parseImpersonatedMailbox(username) {
  if (!looksLikeImpersonation(username)) return null;
  return username.split('%')[0] || null;
}

function pickString(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

// ─── Banner slot component ────────────────────────────────────

function ImpersonationBanner(props) {
  const username = props?.username;
  const mailbox = parseImpersonatedMailbox(username);
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState({
    returnUrl: pickString(props?.returnUrl, ''),
    returnLabel: DEFAULT_RETURN_LABEL,
    actorRoleLabel: DEFAULT_ACTOR_ROLE_LABEL,
    bg: DEFAULT_BG_LIGHT,
    fg: DEFAULT_FG,
  });

  // Pull admin-managed labels/colours from plugin config. The host's
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
            bg: pickString(all.bannerBackground, DEFAULT_BG_LIGHT),
            fg: pickString(all.bannerForeground, DEFAULT_FG),
          }));
        }
      } catch (err) {
        slotApi.log.warn('impersonation-notice: could not read admin config', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Drop the impersonation session as soon as the tab is closed/refreshed.
  // The fetch fires from the slot's null origin to the same-site host; it's
  // best-effort and uses keepalive so the browser flushes it on unload.
  useEffect(() => {
    if (!mailbox) return;
    const drop = () => {
      try {
        fetch('/api/auth/session?all=true', {
          method: 'DELETE',
          credentials: 'same-origin',
          keepalive: true,
        });
      } catch { /* ignore */ }
    };
    window.addEventListener('pagehide', drop);
    window.addEventListener('beforeunload', drop);
    return () => {
      window.removeEventListener('pagehide', drop);
      window.removeEventListener('beforeunload', drop);
    };
  }, [mailbox]);

  if (!mailbox) return null;

  async function handleReturn() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch('/api/auth/session?all=true', {
        method: 'DELETE',
        credentials: 'same-origin',
        keepalive: true,
      });
    } catch {
      /* ignore */
    }
    if (cfg.returnUrl) {
      try {
        await slotApi.ui.openExternalUrl(cfg.returnUrl, '_blank');
      } catch (err) {
        slotApi.log.warn('impersonation-notice: openExternalUrl failed', err);
      }
    }
    setBusy(false);
  }

  return h(
    'div',
    {
      role: 'status',
      'aria-live': 'polite',
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '8px 16px',
        fontSize: '13px',
        fontWeight: 500,
        lineHeight: 1.4,
        width: '100%',
        boxSizing: 'border-box',
        background: cfg.bg,
        color: cfg.fg,
      },
    },
    h(
      'div',
      {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          minWidth: 0,
        },
      },
      h(
        'span',
        { 'aria-hidden': 'true', style: { fontSize: '14px', flexShrink: 0 } },
        '⚠',
      ),
      h(
        'span',
        {
          style: {
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        },
        'You are viewing ',
        h('strong', { style: { fontWeight: 700 } }, mailbox),
        ' ' + cfg.actorRoleLabel,
      ),
    ),
    cfg.returnUrl
      ? h(
          'button',
          {
            type: 'button',
            onClick: handleReturn,
            disabled: busy,
            style: {
              flexShrink: 0,
              font: 'inherit',
              fontWeight: 500,
              border: '1px solid currentColor',
              background: 'transparent',
              color: 'inherit',
              padding: '4px 12px',
              borderRadius: '6px',
              cursor: busy ? 'progress' : 'pointer',
              opacity: busy ? 0.6 : 0.95,
            },
          },
          '← ' + cfg.returnLabel,
        )
      : null,
  );
}

// shouldShow runs in the background iframe. It accepts the host's
// extraProps so it can early-bail before mounting an empty slot iframe.
function shouldShow(extraProps) {
  return looksLikeImpersonation(extraProps?.username);
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
