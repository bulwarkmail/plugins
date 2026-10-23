// Deliveries (sidebar-section slot): the parcels on their way, one row each
// like a folder row. The host draws the section header ("Deliveries", set
// with api.ui.setSectionTitle). A row opens the parcel in a dialog (status,
// Track, Mark received); the last row adds a tracking number by hand.

import * as React from 'react';
import host from '@plugin-host';
import { SidebarEmpty, SidebarRow, Stack } from '@plugin-host/ui';
import { applyOutcome, getParcel, listParcels, saveParcel, visibleParcels } from '../lib/parcels.js';
import { createTracker } from '../lib/tracking.js';
import { getBackground } from '../lib/runtime.js';
import { carrierLabel, shortNumber, shortStatus, shownStatus, statusIcon, statusLabel } from '../lib/view.js';

const h = React.createElement;
const t = (key, vars) => host.i18n.t(key, vars);
const RELOAD_MS = 15_000;
const COLLAPSED = 5;
const DIALOG_WIDTH = 440;
let tracker = null;
const getTracker = () => (tracker ??= createTracker(host));

/** Title of the parcel's dialog and label of its row. */
export function parcelName(parcel) {
  return parcel.subject || `${carrierLabel(t, parcel)} ${parcel.number}`;
}

/** Row labels; parcels from the same mail share a subject, so those get the carrier in front. */
export function rowLabels(parcels) {
  const count = new Map();
  for (const p of parcels) if (p.subject) count.set(p.subject, (count.get(p.subject) ?? 0) + 1);
  return parcels.map((p) => (p.subject && count.get(p.subject) > 1 ? `${carrierLabel(t, p)} · ${p.subject}` : parcelName(p)));
}

function Item({ parcel, label, onOpen }) {
  const carrier = carrierLabel(t, parcel);
  const status = shownStatus(parcel);
  const tooltip = [parcel.subject, `${carrier} ${shortNumber(parcel.number)}`, status ? statusLabel(t, status) : ''].filter(Boolean).join('\n');
  // The wrapper only carries data for the e2e tests; it has no styling.
  return h('div', { 'data-parcel': parcel.number, 'data-status': status || '' },
    h(SidebarRow, { icon: statusIcon(parcel), label, detail: shortStatus(t, parcel), title: tooltip, onClick: onOpen }));
}

export function DeliveriesWidget() {
  const [parcels, setParcels] = React.useState(null);
  const [expanded, setExpanded] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      setParcels(visibleParcels(await listParcels(host.storage)));
    } catch (err) {
      host.log.warn('parcels: could not read parcels', err);
      setParcels([]);
    }
  }, []);

  const refreshAll = React.useCallback(async () => {
    try {
      await getBackground(host).visit();
    } catch (err) {
      host.log.warn('parcels: could not refresh deliveries', err);
    } finally {
      await reload();
    }
  }, [reload]);

  React.useEffect(() => {
    void reload();
    void refreshAll(); // One check when entering webmail (five-minute floor).
    const timer = setInterval(() => { void reload(); }, RELOAD_MS);
    const onFocus = () => { void refreshAll(); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [reload, refreshAll]);

  const openParcel = (p) => async () => {
    try {
      await host.ui.openDialog({ title: parcelName(p), slot: 'plugin-dialog', extraProps: { mode: 'parcel', number: p.number }, width: DIALOG_WIDTH });
    } catch (err) {
      host.log.warn('parcels: could not open the parcel', err);
    }
    await reload();
  };

  const add = async () => {
    let result = null;
    try {
      result = await host.ui.openDialog({ title: t('widget.add'), slot: 'plugin-dialog', extraProps: { mode: 'add' }, width: DIALOG_WIDTH });
    } catch (err) {
      host.log.warn('parcels: could not open the add dialog', err);
    }
    await reload();
    const number = result && typeof result.added === 'string' ? result.added : null;
    if (!number) return;
    // The user asked for it: look it up right away.
    try {
      const stored = await getParcel(host.storage, number);
      if (!stored) return;
      const outcome = await getTracker().track(stored);
      const current = (await getParcel(host.storage, number)) ?? stored;
      await saveParcel(host.storage, applyOutcome({ ...current, received: false }, outcome, Date.now()).parcel);
    } catch (err) {
      host.log.warn('parcels: lookup failed', err);
    }
    await reload();
  };

  if (!parcels) return null;
  const shown = expanded ? parcels : parcels.slice(0, COLLAPSED);
  const labels = rowLabels(shown);
  // Stack: the kit's reset reaches the rows' buttons only inside a kit element.
  return h(Stack, { gap: 0 },
    parcels.length ? null : h(SidebarEmpty, null, t('widget.empty')),
    shown.map((p, i) => h(Item, { key: p.number, parcel: p, label: labels[i], onOpen: openParcel(p) })),
    parcels.length > COLLAPSED
      ? h(SidebarRow, {
        icon: 'dots',
        label: expanded ? t('widget.showLess') : t('widget.showAll', { count: parcels.length }),
        onClick: () => setExpanded(!expanded),
      })
      : null,
    h(SidebarRow, { icon: 'plus', label: t('widget.add'), onClick: () => { void add(); } }));
}
