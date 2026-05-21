/**
 * Email Stats Plugin — sidebar widget + lifecycle hooks.
 *
 * v2 architecture (slot iframes have full api access):
 *   - The `hooks` export runs inside the BACKGROUND iframe and bumps the
 *     persisted lifetime counters in plugin storage.
 *   - The `slots['sidebar-widget']` component runs in its own iframe and now
 *     reads the same storage namespace via `require('@plugin-host')`. It
 *     polls on mount + every few seconds, and also re-reads when the iframe
 *     regains focus, so updates from the background hook appear with at most
 *     one poll-interval lag.
 *
 * Settings (trackOpens / trackSent) are honoured inside the hook handlers
 * rather than skipping registration, because hook registration is static
 * under the new contract.
 */

const { createElement: h, useEffect, useState, useCallback } = require('react');
const slotApi = require('@plugin-host');

// ─── Slot component ──────────────────────────────────────────

const POLL_MS = 3000;

function StatsWidget() {
  const [stats, setStats] = useState({ opened: 0, sent: 0, received: 0 });
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const stored = await slotApi.storage.get('lifetime');
      if (stored && typeof stored === 'object') {
        setStats({
          opened: Number(stored.opened) || 0,
          sent: Number(stored.sent) || 0,
          received: Number(stored.received) || 0,
        });
      }
    } catch (err) {
      slotApi.log.warn('email-stats: could not read storage', err);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, POLL_MS);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const today = new Date().toLocaleDateString();
  const row = (label, value) => h(
    'div',
    {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        padding: '2px 0',
      },
    },
    h('span', { style: { color: '#64748b' } }, label),
    h('span', { style: { fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, value),
  );

  return h(
    'div',
    { style: { padding: '12px', fontSize: '13px', lineHeight: 1.4 } },
    h(
      'div',
      { style: { fontWeight: 600, marginBottom: '8px' } },
      `Email Stats — ${today}`,
    ),
    !loaded
      ? h('div', { style: { color: '#94a3b8' } }, 'Loading…')
      : h(
          'div',
          null,
          row('Opened', stats.opened),
          row('Sent', stats.sent),
          row('Received', stats.received),
        ),
  );
}

export const slots = {
  'sidebar-widget': {
    component: StatsWidget,
    order: 10,
  },
};

// ─── Hooks (background iframe) ──────────────────────────────

let pluginApi = null;
let lifetime = { opened: 0, sent: 0, received: 0 };

async function bump(field) {
  if (!pluginApi) return;
  lifetime[field]++;
  // Fire-and-forget; serialise to storage but don't block the hook on it.
  void pluginApi.storage.set('lifetime', lifetime);
}

export const hooks = {
  onEmailOpen() {
    if (pluginApi?.plugin.settings.trackOpens === false) return;
    void bump('opened');
  },
  onAfterEmailSend() {
    if (pluginApi?.plugin.settings.trackSent === false) return;
    void bump('sent');
  },
  onNewEmailReceived() {
    void bump('received');
  },
};

// ─── Activate ───────────────────────────────────────────────

export async function activate(api) {
  pluginApi = api;
  const stored = (await api.storage.get('lifetime')) || null;
  if (stored && typeof stored === 'object') {
    lifetime = {
      opened: Number(stored.opened) || 0,
      sent: Number(stored.sent) || 0,
      received: Number(stored.received) || 0,
    };
  }
  api.log.info(
    `Email Stats activated (lifetime: opened=${lifetime.opened} sent=${lifetime.sent} received=${lifetime.received})`,
  );
}
