// The agenda, drawn with the app's UI kit for the place the user picked:
//   - sidebar-section: events grouped under a line per day, one sidebar row
//     per event with a dot in its calendar's colour. The host draws the
//     section header (the title set with api.ui.setSectionTitle) and folds it.
//   - email-detail-sidebar: a heading, then per day a label and a list of rows.
//   - app-top-banner: a one-line info bar with the next events as chips.
// Built from a factory so tests can hand in React and a fake api.

import {
  Alert, Chip, ColorDot, EmptyState, Heading, InfoBar, List, ListRow, Loading, Page,
  SidebarEmpty, SidebarRow, Stack, Text,
} from '@plugin-host/ui';

export const DIRTY_KEY = 'agendaDirty'; // timestamp bumped by calendar hooks
/** Chips shown in the top banner. */
export const BANNER_EVENTS = 4;
/** What the calendar view uses for a calendar without a colour. */
export const DEFAULT_COLOR = '#3b82f6';

export const POSITION_TO_SLOT = {
  'Left sidebar': 'sidebar-section',
  'Email reading pane': 'email-detail-sidebar',
  'Top banner': 'app-top-banner',
};
export const DEFAULT_SLOT = 'sidebar-section';

export function slotForPosition(position) {
  return POSITION_TO_SLOT[position] || DEFAULT_SLOT;
}

function startOfDay(d) {
  const n = new Date(d);
  n.setHours(0, 0, 0, 0);
  return n;
}

/** `2026-10-22T07:30:00Z`, the UTC form calendar.getEvents takes (no milliseconds). */
function utcBound(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** Milliseconds in an ISO 8601 duration such as PT1H30M or P1D. */
export function durationMs(duration) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(duration || '');
  if (!m) return 0;
  const [, w = 0, d = 0, h = 0, min = 0, s = 0] = m;
  return (((+w * 7 + +d) * 24 + +h) * 3600 + +min * 60 + +s) * 1000;
}

/**
 * An event from api.calendar.getEvents as the agenda draws it. A timed
 * event's `start` is wall-clock time in its own zone, so its UTC start
 * places it; an all-day event starts at local midnight.
 */
export function toAgendaEvent(view, untitled = '', colors = new Map()) {
  const allDay = !!view.isAllDay;
  const start = !allDay && view.utcStart ? new Date(view.utcStart) : new Date(view.start);
  const end = !allDay && view.utcEnd ? new Date(view.utcEnd) : new Date(start.getTime() + durationMs(view.duration));
  return {
    id: view.id,
    title: (view.title || '').trim() || untitled,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
    status: view.status || null,
    location: view.location || null,
    color: colors.get(view.calendarId) || DEFAULT_COLOR,
  };
}

/** Calendar id → colour. If this fails the agenda still loads, every dot in the default colour. */
async function calendarColors(api) {
  try {
    const calendars = (await api.calendar.listCalendars()) || [];
    return new Map(calendars.filter((c) => c?.id && c.color).map((c) => [c.id, c.color]));
  } catch (err) {
    api.log.warn('calendar-agenda: listCalendars failed', err);
    return new Map();
  }
}

/**
 * Events still running or starting in the next `days` days, earliest first.
 * Reads through api.calendar (calendar:read), which covers shared calendars
 * and expands recurring series.
 */
export async function loadAgenda(api, { days, limit, now = new Date(), untitled = '' }) {
  const from = startOfDay(now);
  const to = new Date(now.getTime() + days * 86_400_000);
  const [views, colors] = await Promise.all([
    api.calendar.getEvents({ from: utcBound(from), to: utcBound(to) }),
    calendarColors(api),
  ]);
  return (views || [])
    .filter((v) => typeof v?.start === 'string' && !Number.isNaN(Date.parse(v.start)))
    .map((v) => toAgendaEvent(v, untitled, colors))
    .filter((ev) => Date.parse(ev.end) >= now.getTime())
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, limit);
}

/**
 * Sorted events in one group per local day. An event that began before today
 * and is still running goes under today.
 */
export function groupByDay(events, now = new Date()) {
  const today = startOfDay(now).getTime();
  const groups = [];
  for (const ev of events) {
    const day = new Date(Math.max(startOfDay(new Date(ev.start)).getTime(), today));
    const last = groups[groups.length - 1];
    if (last && last.day.getTime() === day.getTime()) last.events.push(ev);
    else groups.push({ key: day.getTime(), day, events: [ev] });
  }
  return groups;
}

export function makeFormat(api, now = () => new Date()) {
  const t = (key, vars) => api.i18n.t(key, vars);
  const locale = () => api.i18n.dateLocale || api.i18n.locale || (api.i18n.getLocale && api.i18n.getLocale()) || undefined;
  // Days are grouped by the browser's midnight (startOfDay), so labels use the
  // browser's zone too. In the host's zone setting a heading or an all-day
  // event could show the day before or after the one it is grouped under.
  const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

  function dayLabel(date) {
    const diffDays = Math.round((startOfDay(date).getTime() - startOfDay(now()).getTime()) / 86_400_000);
    if (diffDays === 0) return t('day.today');
    if (diffDays === 1) return t('day.tomorrow');
    if (typeof api.i18n?.formatDate === 'function') {
      return api.i18n.formatDate(date, { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone() });
    }
    return date.toLocaleDateString(locale(), { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function timeLabel(ev) {
    if (ev.allDay) return t('event.all_day');
    if (typeof api.i18n?.formatTime === 'function') {
      return api.i18n.formatTime(ev.start, { hour: '2-digit', minute: '2-digit', timeZone: zone() });
    }
    return new Date(ev.start).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  }

  /** "14:00" today, "Tomorrow 09:30", "Wed, Oct 16" for an all-day event. */
  function when(ev) {
    const start = new Date(ev.start);
    const today = Math.round((startOfDay(start).getTime() - startOfDay(now()).getTime()) / 86_400_000) === 0;
    if (today) return timeLabel(ev);
    return ev.allDay ? dayLabel(start) : `${dayLabel(start)} ${timeLabel(ev)}`;
  }

  return { t, dayLabel, timeLabel, when };
}

export function makeAgenda(React, api, { slot = DEFAULT_SLOT, now } = {}) {
  const { createElement: h, useCallback, useEffect, useRef, useState } = React;
  const fmt = makeFormat(api, now);
  const { t } = fmt;

  // A cancelled event keeps its row, struck through. Fall back to "(No title)" if title is blank.
  const titleTextOf = (ev) => ev.title || t('event.untitled');
  const titleOf = (ev) => (ev.status === 'cancelled' ? h('del', null, titleTextOf(ev)) : titleTextOf(ev));
  const tooltip = (ev) => [titleTextOf(ev), fmt.when(ev), ev.location].filter(Boolean).join(' · ');

  function useAgenda() {
    const [events, setEvents] = useState([]);
    const [state, setState] = useState('loading'); // loading | ready | error | unauth
    const [error, setError] = useState('');
    const lastDirtyRef = useRef(null);
    const inFlightRef = useRef(false);

    const settings = api.plugin?.settings || {};
    const days = Number(settings.daysAhead) || 7;
    const limit = Number(settings.maxEvents) || 50;
    const refreshMs = Math.max(1, Number(settings.refreshMinutes) || 10) * 60_000;

    const fetchAgenda = useCallback(async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        setEvents(await loadAgenda(api, { days, limit, now: now ? now() : new Date() }));
        setState('ready');
      } catch (err) {
        const text = String((err && err.message) || err);
        if (/no active session/.test(text)) {
          setState('unauth');
          return;
        }
        api.log.warn('calendar-agenda: fetch failed', err);
        setError(text);
        setState('error');
      } finally {
        inFlightRef.current = false;
      }
    }, [days, limit]);

    useEffect(() => {
      void fetchAgenda();
      const pollId = setInterval(() => { void fetchAgenda(); }, refreshMs);
      // Refetch when calendar data changes (background hooks bump the
      // marker) or when the iframe regains focus.
      const dirtyId = setInterval(async () => {
        try {
          const mark = await api.storage.get(DIRTY_KEY);
          if (mark && mark !== lastDirtyRef.current) {
            lastDirtyRef.current = mark;
            void fetchAgenda();
          }
        } catch { /* ignore */ }
      }, 4000);
      const onFocus = () => { void fetchAgenda(); };
      window.addEventListener('focus', onFocus);
      return () => {
        clearInterval(pollId);
        clearInterval(dirtyId);
        window.removeEventListener('focus', onFocus);
      };
    }, [fetchAgenda, refreshMs]);

    let message = null;
    if (state === 'loading') message = t('state.loading');
    else if (state === 'unauth') message = t('state.unauth');
    else if (state === 'error') message = t('state.error', { error });
    else if (events.length === 0) message = t('state.empty', { days });
    return { events, state, message };
  }

  // The calendar's colour, in a 16 px box so it lines up with the folder icons.
  const dot = (ev) => h('span', {
    style: { display: 'inline-flex', width: '16px', justifyContent: 'center', verticalAlign: 'middle', marginInlineEnd: '8px', lineHeight: 0 },
  }, h(ColorDot, { color: ev.color }));

  // In a chip the dot needs no icon column, just a gap before the title.
  const chipDot = (ev) => h('span', {
    style: { display: 'inline-flex', verticalAlign: 'middle', marginInlineEnd: '6px', lineHeight: 0 },
  }, h(ColorDot, { color: ev.color }));

  // "TODAY", "TOMORROW", "FRI, OCT 24" above that day's events.
  const dayHeading = (date, padding) => h('div', {
    role: 'heading', 'aria-level': 4,
    style: { padding, textTransform: 'uppercase', letterSpacing: '0.04em' },
  }, h(Text, { size: 'xs', tone: 'muted', weight: 'semibold' }, fmt.dayLabel(date)));

  const groups = (events) => groupByDay(events, now ? now() : new Date());

  function SidebarAgenda() {
    const { events, message } = useAgenda();
    if (message) return h(SidebarEmpty, null, message);
    return h(React.Fragment, null, ...groups(events).map((g) => h('div', { key: g.key, 'data-day': '' },
      dayHeading(g.day, '8px 12px 2px 32px'),
      ...g.events.map((ev) => h(SidebarRow, {
        key: ev.id,
        label: h(React.Fragment, null, dot(ev), titleOf(ev)),
        detail: fmt.timeLabel(ev),
        title: tooltip(ev),
      })))));
  }

  function PanelAgenda() {
    const { events, state, message } = useAgenda();
    let body;
    if (state === 'loading') body = h(Loading, { label: message });
    else if (state === 'error') body = h(Alert, { tone: 'danger', icon: 'alert-triangle' }, message);
    else if (message) body = h(EmptyState, { compact: true, icon: 'calendar', title: message });
    else {
      body = h(Stack, { gap: 3 }, ...groups(events).map((g) => h(Stack, { key: g.key, gap: 1 },
        dayHeading(g.day, '0'),
        h(List, { label: fmt.dayLabel(g.day) }, ...g.events.map((ev) => h(ListRow, {
          key: ev.id,
          icon: h(ColorDot, { color: ev.color }),
          title: titleOf(ev),
          subtitle: [fmt.timeLabel(ev), ev.location].filter(Boolean).join(' · '),
        }))))));
    }
    return h(Page, null, h(Stack, { gap: 3 }, h(Heading, { level: 3 }, t('header.title')), body));
  }

  function BannerAgenda() {
    const { events, message } = useAgenda();
    return h(InfoBar, { compact: true, tone: 'primary', icon: 'calendar', eyebrow: t('header.title'), title: message || undefined },
      ...(message ? [] : events.slice(0, BANNER_EVENTS).map((ev) => h(Chip, {
        key: ev.id, label: h(React.Fragment, null, chipDot(ev), titleOf(ev)), detail: fmt.when(ev), title: tooltip(ev),
      }))),
      !message && events.length > BANNER_EVENTS ? h(Text, { key: 'more', size: 'xs', tone: 'muted' }, `+${events.length - BANNER_EVENTS}`) : null);
  }

  if (slot === 'email-detail-sidebar') return PanelAgenda;
  if (slot === 'app-top-banner') return BannerAgenda;
  return SidebarAgenda;
}
