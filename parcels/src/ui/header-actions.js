// Small inline header controls rendered beside the collapsible Deliveries heading.
import * as React from 'react';
import host from '@plugin-host';
import { listParcels } from '../lib/parcels.js';
import { getBackground } from '../lib/runtime.js';

const h = React.createElement;
const POLL_UI_MS = 15_000;

export function DeliveryHeaderActions() {
  const [busy, setBusy] = React.useState(false);
  const [lastChecked, setLastChecked] = React.useState(0);
  const t = (key) => host.i18n.t(key);

  const readLastChecked = React.useCallback(async () => {
    try {
      const parcels = await listParcels(host.storage);
      setLastChecked(Math.max(0, ...parcels.map((p) => p.lastPolledAt || 0)));
    } catch (err) {
      host.log.warn('parcels: could not read latest tracking time', err);
    }
  }, []);

  React.useEffect(() => {
    void readLastChecked();
    const timer = setInterval(() => { void readLastChecked(); }, POLL_UI_MS);
    return () => clearInterval(timer);
  }, [readLastChecked]);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await getBackground(host).refresh();
    } catch (err) {
      host.log.warn('parcels: manual refresh failed', err);
    } finally {
      await readLastChecked();
      setBusy(false);
    }
  };

  const label = busy ? t('card.refreshing') : t('card.refresh');
  const when = lastChecked ? new Date(lastChecked).toLocaleTimeString(host.i18n.getLocale(), {
    hour: 'numeric', minute: '2-digit',
  }) : '';

  return h('div', {
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', color: 'inherit' },
  },
  when ? h('span', { style: { fontSize: 11, opacity: 0.6 }, title: when }, when) : null,
  h('button', {
    type: 'button', title: label, 'aria-label': label, 'aria-busy': busy,
    disabled: busy, onClick: () => { void refresh(); },
    style: {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 25, height: 24, padding: 3, background: 'transparent',
      border: 'none', color: 'inherit', opacity: busy ? 0.5 : 0.8,
      borderRadius: 5, cursor: busy ? 'wait' : 'pointer',
    },
  }, h('svg', {
    width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true,
  },
  h('path', { d: 'M20 11a8 8 0 0 0-14.6-4.6L3 9' }),
  h('path', { d: 'M3 4v5h5' }),
  h('path', { d: 'M4 13a8 8 0 0 0 14.6 4.6L21 15' }),
  h('path', { d: 'M21 20v-5h-5' }))));
}
