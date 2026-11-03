// Area "everywhere" of the 2.2 work: what it adds to the panel (shapes in
// src/lib/areas/README.md). Next to Calendar, Contacts, Files and Settings
// (the webmail's app-side-panel) the panel names what the view shows (a
// chip, and the data in the prompt) and offers what fits there; wherever
// nothing is open (those views, and the reader with no message) it offers
// Catch me up.

import { useCallback, useRef, useState } from 'react';
import { areaAllowed } from '../../../lib/config.js';
import { has } from '../../../lib/caps.js';
import { userZone } from '../../../lib/clock.js';
import { LAST_VISIT_KEY, briefParts, briefRequest, gatherBrief, viewBlock, viewOf } from '../../../lib/areas/everywhere.js';
import { NOTHING } from './nothing.js';

/** The chip of what the view shows, or null. */
export function viewChip(t, view, context = {}) {
  const c = context ?? {};
  if (view === 'calendar' && c.event) return { key: 'view-event', icon: 'calendar-event', label: t('view.chip.event'), detail: c.event.title || '…' };
  if (view === 'contacts' && c.contact) return { key: 'view-contact', icon: 'user', label: t('view.chip.contact'), detail: c.contact.fullName || c.contact.emails?.[0] || '…' };
  if (view === 'contacts' && c.selectedCount > 0) return { key: 'view-contacts', icon: 'users', label: t('view.chip.contacts', { count: c.selectedCount }) };
  if (view === 'files' && Array.isArray(c.files) && c.files.length) {
    const count = c.fileCount ?? c.files.length;
    return count === 1
      ? { key: 'view-files', icon: c.files[0].type === 'directory' ? 'folder' : 'file', label: t('view.chip.file'), detail: c.files[0].name }
      : { key: 'view-files', icon: 'files', label: t('view.chip.files', { count }), title: c.files.map((f) => f.name).join(', ') };
  }
  if (view === 'files' && c.folder?.path && c.folder.path !== '/') return { key: 'view-folder', icon: 'folder', label: t('view.chip.folder'), detail: c.folder.path };
  if (view === 'settings' && c.page?.label) return { key: 'view-page', icon: 'settings', label: t('view.chip.page'), detail: c.page.label };
  return null;
}

/** The quick entries that fit what the view shows: [{ id, label, icon, prompt }]. */
export function viewQuick(t, view, context = {}, { files = false } = {}) {
  const c = context ?? {};
  if (view === 'calendar') return [{ id: 'view-week', icon: 'calendar-week', label: t('view.quick.week'), prompt: t('view.quick.week_prompt') }];
  if (view === 'contacts' && c.contact) {
    const name = c.contact.fullName || c.contact.emails?.[0] || '';
    const who = c.contact.emails?.[0] && c.contact.fullName ? `${c.contact.fullName} (${c.contact.emails[0]})` : name;
    return name ? [{ id: 'view-mails', icon: 'mail', label: t('view.quick.mails', { name }), prompt: t('view.quick.mails_prompt', { who }) }] : [];
  }
  if (view === 'files' && files && (c.fileCount ?? c.files?.length) === 1 && c.files?.[0]?.type === 'file') {
    return [{ id: 'view-file', icon: 'file-text', label: t('view.quick.file'), prompt: t('view.quick.file_prompt', { name: c.files[0].name }) }];
  }
  if (view === 'settings' && c.page?.label) return [{ id: 'view-page', icon: 'help-circle', label: t('view.quick.page'), prompt: t('view.quick.page_prompt', { page: c.page.label }) }];
  return [];
}

/** Called on every render of the panel, in a fixed order with the other areas. */
export function useArea(chat, props) {
  const { api, t, mode, email, setup, prefs, person, locale, bridge } = chat;
  const view = mode === 'reader' ? viewOf(props) : null;
  const allowed = !!setup?.endpoint && areaAllowed(setup.config ?? {}, 'everywhere');
  // Catch me up reads mail, the calendar and tasks: only with lookups on.
  const briefAllowed = allowed && prefs?.catchUp !== false && prefs?.lookups !== false;
  const briefOn = briefAllowed && mode === 'reader' && !email;
  const [gathering, setGathering] = useState(false);

  const zone = userZone(api, person?.timeZone);
  const live = useRef({ zone, person, prefs, locale });
  live.current = { zone, person, prefs, locale };
  const catchUp = useCallback(async () => {
    if (gathering) return;
    setGathering(true);
    try {
      const now = live.current;
      const startedAt = Date.now();
      const stored = await Promise.resolve(api.storage.get(LAST_VISIT_KEY)).catch(() => null);
      const brief = await gatherBrief(api, {
        zone: now.zone,
        lastVisit: Number.isFinite(stored) ? stored : undefined,
        ownEmails: now.person?.emails ?? [],
        waiting: now.prefs?.briefWaiting !== false,
      });
      const { instruction, data } = briefRequest(brief, now.zone);
      // The user's turn is the instruction alone; the mail and events go
      // into this request's system prompt as data and are not kept.
      await bridge.current.send?.({
        label: t('brief.label'),
        sent: instruction,
        data,
        finish: (text) => {
          // Caught up: the next Catch me up starts from here.
          void Promise.resolve(api.storage.set(LAST_VISIT_KEY, startedAt)).catch(() => {});
          return `${text}\n${briefParts(brief, text, { t, zone: now.zone, locale: now.locale })}`;
        },
      });
    } finally {
      setGathering(false);
    }
  }, [api, bridge, gathering, t]);

  if (!allowed) return NOTHING;
  // The privacy notice names what this area may send wherever it is asked
  // for first (it is asked once per service, maybe in Mail or the composer).
  const privacyParts = [
    ...(prefs?.everywhere !== false && has(api, 'sidePanel') ? ['view.privacy'] : []),
    ...(briefAllowed ? ['brief.privacy'] : []),
  ];
  if (mode !== 'reader' || (!view && !briefOn)) return { privacyParts };

  const context = props?.context ?? {};
  const brief = briefOn ? [{ id: 'catch-up', icon: 'list-details', label: t('brief.label'), run: () => { void catchUp(); } }] : [];
  const quick = view
    ? viewQuick(t, view, context, { files: has(api, 'files') }).map(({ prompt, ...q }) => ({ ...q, run: () => bridge.current.sendText?.(prompt) }))
    : [];
  const chip = view ? viewChip(t, view, context) : null;
  return {
    chips: chip ? [chip] : [],
    promptBlocks: view ? [viewBlock(view, context, zone)] : [],
    quick: [...brief, ...quick],
    empty: view || brief.length ? { text: view ? t(`view.empty.${view}`) : undefined, actions: brief.map((b) => ({ ...b, busy: gathering })) } : null,
    privacyParts,
  };
}
