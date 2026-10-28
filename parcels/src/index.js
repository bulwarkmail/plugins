// Package tracking: finds tracking numbers in mail, shows their live status
// in the reader, lists parcels on their way in the sidebar and notifies when
// a status changes. Logic lives in ./lib (plain modules, unit-tested); this
// file wires it to the host.

import host from '@plugin-host';
import { bannerShouldShow } from './lib/background.js';
import { getBackground } from './lib/runtime.js';
import { ParcelCard } from './ui/card.js';
import { PluginDialog } from './ui/dialog.js';
import { DeliveriesWidget } from './ui/widget.js';
import { DeliveryHeaderActions } from './ui/header-actions.js';

const bg = () => getBackground(host);

/** The sidebar section's header, drawn by the host, in the user's language. */
function setTitle() {
  // Without it (older hosts) the header shows the plugin's name.
  Promise.resolve()
    .then(() => host.ui.setSectionTitle(host.i18n.t('widget.title')))
    .catch((err) => host.log.warn('parcels: could not set the section title', err));
}

export default {
  slots: {
    'email-banner': { component: ParcelCard, shouldShow: bannerShouldShow },
    'sidebar-section': { component: DeliveriesWidget, order: 60 },
    'sidebar-section-actions': { component: DeliveryHeaderActions },
    'plugin-dialog': { component: PluginDialog },
  },
  hooks: {
    // Once a minute; each parcel is asked about at most every 30 minutes.
    onInterval: () => bg().tick(),
    onNewEmailReceived: (summary) => bg().onNewEmail(summary).then(() => undefined),
  },
  activate() {
    setTitle();
    host.i18n.onLocaleChange(setTitle);
    // A first round shortly after start, so parcels don't wait a minute.
    setTimeout(() => { void bg().tick(); }, 5_000);
  },
};
