/**
 * Calendar Agenda Plugin — upcoming-events agenda in the sidebar.
 *
 * Mirrors the Quick Notes architecture (slot iframe + background hooks):
 *   - The `slots['sidebar-widget']` component runs in its own iframe and pulls
 *     the agenda from the host sidecar `POST /api/calendar-agenda`, which
 *     resolves the calendar account server-side, queries upcoming
 *     CalendarEvents over JMAP, expands recurring series, and returns slim
 *     DTOs. Credentials never reach the sandbox.
 *   - The `hooks` export runs in the BACKGROUND iframe and stamps a "dirty"
 *     marker into plugin storage whenever calendar data changes, so the
 *     widget refetches promptly instead of waiting for the next poll.
 */

const { createElement: h, useEffect, useState, useCallback, useRef } = require('react');
const slotApi = require('@plugin-host');

const DIRTY_KEY = 'agendaDirty'; // timestamp bumped by calendar hooks
const AGENDA_PATH = '/api/calendar-agenda';

// ─── Date helpers ────────────────────────────────────────────

function startOfDay(d) {
  const n = new Date(d);
  n.setHours(0, 0, 0, 0);
  return n;
}

function dayKey(d) {
  return startOfDay(d).toISOString().slice(0, 10);
}

function relativeDayLabel(date) {
  const today = startOfDay(new Date());
  const that = startOfDay(date);
  const diffDays = Math.round((that.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return that.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function timeLabel(ev) {
  if (ev.allDay) return 'All day';
  const start = new Date(ev.start);
  return start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ─── Slot component ──────────────────────────────────────────

const COLLAPSED_KEY = 'collapsed';

// Matches the sidebar's section-header chevron (lucide ChevronDown /
// ChevronRight, 14px, muted) — we can't import lucide inside the sandbox iframe.
function Chevron(expanded) {
  return h(
    'svg',
    {
      width: 14,
      height: 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { color: 'var(--color-muted-foreground)', flexShrink: 0 },
      'aria-hidden': true,
    },
    h('polyline', { points: expanded ? '6 9 12 15 18 9' : '9 18 15 12 9 6' }),
  );
}

function AgendaWidget() {
  const [events, setEvents] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | error | unauth
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [hover, setHover] = useState(false);
  const lastDirtyRef = useRef(null);
  const inFlightRef = useRef(false);

  // Restore the persisted collapse state (the sidebar sections remember theirs).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await slotApi.storage.get(COLLAPSED_KEY);
        if (!cancelled && typeof stored === 'boolean') setCollapsed(stored);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      void slotApi.storage.set(COLLAPSED_KEY, next);
      return next;
    });
  }, []);

  const settings = slotApi.plugin?.settings || {};
  const days = Number(settings.daysAhead) || 7;
  const limit = Number(settings.maxEvents) || 50;
  const refreshMs = Math.max(1, Number(settings.refreshMinutes) || 10) * 60_000;

  const fetchAgenda = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await slotApi.http.post(AGENDA_PATH, { days, limit });
      if (res?.status === 401) {
        setState('unauth');
        return;
      }
      if (!res?.ok) {
        setError((res?.data && res.data.error) || `HTTP ${res?.status || '??'}`);
        setState('error');
        return;
      }
      const list = Array.isArray(res.data?.events) ? res.data.events : [];
      setEvents(list);
      setState('ready');
    } catch (err) {
      slotApi.log.warn('calendar-agenda: fetch failed', err);
      setError(String((err && err.message) || err));
      setState('error');
    } finally {
      inFlightRef.current = false;
    }
  }, [days, limit]);

  useEffect(() => {
    void fetchAgenda();

    // Periodic refresh.
    const pollId = setInterval(() => { void fetchAgenda(); }, refreshMs);

    // Refetch when calendar data changes (background hooks bump the marker)
    // or when the iframe regains focus.
    const dirtyId = setInterval(async () => {
      try {
        const mark = await slotApi.storage.get(DIRTY_KEY);
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

  // ── Render ──
  // Header mirrors the sidebar's collapsible section: a full-width toggle with
  // a chevron + semibold label, plus the refresh affordance on the right.
  const header = h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        marginBottom: collapsed ? 0 : '8px',
        borderRadius: '4px',
        background: hover ? 'var(--color-muted)' : 'transparent',
        transition: 'background-color 0.12s',
      },
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
    },
    h(
      'button',
      {
        type: 'button',
        onClick: toggleCollapsed,
        title: collapsed ? 'Expand agenda' : 'Collapse agenda',
        'aria-expanded': !collapsed,
        style: {
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          font: 'inherit',
          fontSize: '14px',
          fontWeight: 600,
          color: 'var(--color-foreground)',
          background: 'transparent',
          border: 'none',
          padding: '4px 2px',
          cursor: 'pointer',
          textAlign: 'left',
        },
      },
      Chevron(!collapsed),
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 'Agenda'),
    ),
    h(
      'button',
      {
        type: 'button',
        onClick: (e) => { e.stopPropagation(); void fetchAgenda(); },
        title: 'Refresh agenda',
        style: {
          font: 'inherit',
          fontSize: '12px',
          cursor: 'pointer',
          border: '1px solid var(--color-input)',
          background: 'var(--color-muted)',
          color: 'inherit',
          borderRadius: '6px',
          padding: '2px 8px',
          flexShrink: 0,
        },
      },
      '↻',
    ),
  );

  let bodyEl = null;
  if (!collapsed) {
    if (state === 'loading') {
      bodyEl = h('div', { style: mutedStyle() }, 'Loading…');
    } else if (state === 'unauth') {
      bodyEl = h('div', { style: mutedStyle() }, 'Sign in to see your agenda.');
    } else if (state === 'error') {
      bodyEl = h(
        'div',
        { style: { ...mutedStyle(), color: 'var(--color-destructive, #ef4444)' } },
        `Couldn't load agenda: ${error}`,
      );
    } else if (events.length === 0) {
      bodyEl = h('div', { style: mutedStyle() }, `No events in the next ${days} day(s).`);
    } else {
      bodyEl = h('div', null, ...renderGroups(events));
    }
  }

  return h(
    'div',
    { style: { padding: '12px', fontSize: '13px', lineHeight: 1.4 } },
    header,
    bodyEl,
  );
}

function mutedStyle() {
  return { color: 'var(--color-muted-foreground)', fontSize: '12px', padding: '4px 0' };
}

function renderGroups(events) {
  // Group sorted events by calendar day.
  const groups = [];
  const byKey = new Map();
  for (const ev of events) {
    const key = dayKey(new Date(ev.start));
    let g = byKey.get(key);
    if (!g) {
      g = { key, date: new Date(ev.start), items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(ev);
  }

  return groups.map((g) =>
    h(
      'div',
      { key: g.key, style: { marginBottom: '10px' } },
      h(
        'div',
        {
          style: {
            fontSize: '11px',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--color-muted-foreground)',
            fontWeight: 600,
            marginBottom: '4px',
          },
        },
        relativeDayLabel(g.date),
      ),
      ...g.items.map((ev) => renderEvent(ev)),
    ),
  );
}

function renderEvent(ev) {
  return h(
    'div',
    {
      key: ev.id,
      style: {
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
        padding: '4px 0',
      },
    },
    h('div', {
      style: {
        width: '4px',
        alignSelf: 'stretch',
        minHeight: '28px',
        borderRadius: '2px',
        background: ev.color || 'var(--color-accent)',
        flexShrink: 0,
      },
    }),
    h(
      'div',
      { style: { flex: 1, minWidth: 0 } },
      h(
        'div',
        {
          style: {
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textDecoration: ev.status === 'cancelled' ? 'line-through' : 'none',
            opacity: ev.status === 'cancelled' ? 0.6 : 1,
          },
          title: ev.title,
        },
        ev.title,
      ),
      h(
        'div',
        { style: { fontSize: '11px', color: 'var(--color-muted-foreground)' } },
        timeLabel(ev),
        ev.location ? ` · ${ev.location}` : '',
      ),
    ),
  );
}

// ─── Position → slot wiring ─────────────────────────────────
//
// Slot *offers* count toward host layout even when a `shouldShow` gate hides
// the iframe (e.g. the email viewer reserves its sidebar whenever any plugin
// offers `email-detail-sidebar`), which left an empty panel for the slots we
// weren't using. So instead of registering every candidate slot, we register
// ONLY the one the `position` setting selects.
//
// The `slots` export is evaluated at module load, where `@plugin-host` already
// exposes the resolved settings (in both the background and slot iframes), so
// this picks the right slot up front. Changing `position` reloads the plugin,
// which re-runs this and re-registers a single slot.

let pluginApi = null;

const POSITION_TO_SLOT = {
  'Left sidebar': 'sidebar-widget',
  'Email reading pane': 'email-detail-sidebar',
  'Top banner': 'app-top-banner',
};

const DEFAULT_SLOT = 'sidebar-widget';
const activeSlot = POSITION_TO_SLOT[slotApi?.plugin?.settings?.position] || DEFAULT_SLOT;

export const slots = {
  [activeSlot]: {
    component: AgendaWidget,
    order: 15,
  },
};

// ─── Hooks (background iframe) ──────────────────────────────

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

export async function activate(api) {
  pluginApi = api;
  api.log.info('Calendar Agenda plugin activated');
}
