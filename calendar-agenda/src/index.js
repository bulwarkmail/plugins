/**
 * Calendar Agenda Plugin — upcoming-events agenda.
 *
 *   - The slot component (src/lib/agenda.js) runs in its own iframe and reads
 *     upcoming events with api.calendar.getEvents (calendar:read), which
 *     covers shared calendars and expands recurring series.
 *   - The `hooks` export runs in the BACKGROUND iframe and stamps a "dirty"
 *     marker into plugin storage whenever calendar data changes, so the
 *     agenda refetches promptly instead of waiting for the next poll.
 *
 * In the left sidebar it is a `sidebar-section`: the host draws the header
 * (titled "Agenda" with api.ui.setSectionTitle) and remembers whether it is
 * folded, like Folders and Tags. In the side panel beside the mail it is a
 * `side-panel`, with its title and calendar icon set with api.ui.setSidePanel.
 */

const React = require('react');
const slotApi = require('@plugin-host');

import { DIRTY_KEY, makeAgenda, slotForPosition } from './lib/agenda.js';

// ─── Position → slot wiring ─────────────────────────────────
//
// Slot *offers* count toward host layout even when a `shouldShow` gate hides
// the iframe (e.g. the email viewer reserves its sidebar whenever any plugin
// offers `email-detail-sidebar`), so we register ONLY the slot the
// `position` setting selects. The `slots` export is evaluated at module
// load, where `@plugin-host` already exposes the resolved settings (in both
// the background and slot iframes). Changing `position` reloads the plugin.

const activeSlot = slotForPosition(slotApi?.plugin?.settings?.position);

export const slots = {
  [activeSlot]: {
    component: makeAgenda(React, slotApi, { slot: activeSlot }),
    order: 15,
  },
};

// ─── Hooks (background iframe) ──────────────────────────────

let pluginApi = null;

function markDirty() {
  if (!pluginApi) return;
  void pluginApi.storage.set(DIRTY_KEY, Date.now());
}

export const hooks = {
  onAfterEventCreate() { markDirty(); },
  onAfterEventUpdate() { markDirty(); },
  onAfterEventDelete() { markDirty(); },
  onEventsImport() { markDirty(); },
  onEventRsvp() { markDirty(); },
  onCalendarChange() { markDirty(); },
  onICalSubscriptionChange() { markDirty(); },
};

// ─── Activate ───────────────────────────────────────────────

function setTitle(api) {
  if (activeSlot === 'sidebar-section') {
    Promise.resolve(api.ui.setSectionTitle(api.i18n.t('header.title'))).catch((err) => {
      api.log.warn('calendar-agenda: setSectionTitle failed', err);
    });
  } else if (activeSlot === 'side-panel') {
    Promise.resolve(api.ui.setSidePanel?.({
      title: api.i18n.t('header.title'),
      icon: 'calendar',
    })).catch((err) => {
      api.log.warn('calendar-agenda: setSidePanel failed', err);
    });
  }
}

export async function activate(api) {
  pluginApi = api;
  setTitle(api);
  api.i18n.onLocaleChange?.(() => setTitle(api));
  api.log.info('Calendar Agenda plugin activated');
}
