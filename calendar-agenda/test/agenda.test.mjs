// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { durationMs, makeAgenda, slotForPosition } from '../src/lib/agenda.js';

const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'calendar-agenda', 'manifest.json'), 'utf8'));
const NOW = () => new Date(2026, 9, 14, 9, 0);

afterEach(cleanup);

/** A timed event as api.calendar.getEvents returns it, starting at local `start`. */
function timed(id, title, start, minutes, extra = {}) {
  return {
    id, uid: id, calendarId: 'cal', title, description: '',
    // Wall-clock time in the event's own zone, which is not the viewer's.
    start: '2026-01-01T03:00:00', timeZone: 'Pacific/Kiritimati', duration: `PT${minutes}M`,
    utcStart: start.toISOString(), utcEnd: new Date(start.getTime() + minutes * 60_000).toISOString(),
    isAllDay: false, location: '', status: 'confirmed', participants: [], isRecurring: false, keywords: [],
    ...extra,
  };
}

function allDay(id, title, date, extra = {}) {
  return {
    id, uid: id, calendarId: 'cal', title, description: '',
    start: `${date}T00:00:00`, timeZone: null, duration: 'P1D', utcStart: null, utcEnd: null,
    isAllDay: true, location: '', status: 'confirmed', participants: [], isRecurring: false, keywords: [],
    ...extra,
  };
}

const events = [
  timed('a', 'Standup', new Date(2026, 9, 14, 10, 0), 15, { location: 'Room 1' }),
  allDay('b', 'Offsite', '2026-10-15'),
  timed('c', 'Dropped', new Date(2026, 9, 15, 15, 30), 30, { status: 'cancelled' }),
];

const calendars = [{ id: 'cal', name: 'Work', color: '#3b82f6', isVisible: true, isDefault: true, isTasksOnly: false }];

function setup(slot, {
  getEvents = async () => events,
  listCalendars = async () => calendars,
  settings = { daysAhead: 7 },
  locale = 'en',
  dateLocale,
  timeFormat,
  timeZone,
} = {}) {
  const api = fakeApi({
    translations: manifest.locales,
    settings,
    locale,
    dateLocale,
    timeFormat,
    timeZone,
    handlers: { 'calendar.getEvents': getEvents, 'calendar.listCalendars': listCalendars },
  });
  const Agenda = makeAgenda(React, api, { slot, now: NOW });
  return { api, Agenda };
}

async function show(Agenda) {
  await act(async () => { render(React.createElement(Agenda)); });
}

const rows = () => [...document.querySelectorAll('[title]')];
const rowTitles = () => rows().map((r) => r.getAttribute('title').split(' · ')[0]);
const dayHeadings = () => [...document.querySelectorAll('[role="heading"]')].map((d) => d.textContent);
const clock = (date) => date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });

describe('position', () => {
  it('puts the left-sidebar agenda in a sidebar section', () => {
    expect(slotForPosition('Left sidebar')).toBe('sidebar-section');
    expect(slotForPosition(undefined)).toBe('sidebar-section');
    expect(slotForPosition('Top banner')).toBe('app-top-banner');
  });
});

describe('reading events', () => {
  it('asks api.calendar for today through the next N days, in the UTC form it accepts', async () => {
    const { api, Agenda } = setup('sidebar-section', { settings: { daysAhead: 3 } });
    await show(Agenda);
    const calls = api.calls('calendar.getEvents');
    expect(calls).toHaveLength(1);
    const range = calls[0].args[0];
    // The host refuses milliseconds and offsets: 2026-10-14T07:00:00Z only.
    expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(range.from)).toBe(new Date(2026, 9, 14).getTime());
    expect(Date.parse(range.to)).toBe(new Date(2026, 9, 17, 9, 0).getTime());
    expect(Object.keys(range)).toEqual(['from', 'to']);
  });

  it('does not POST to the app, which no plugin may do for the agenda', async () => {
    const { api, Agenda } = setup('sidebar-section');
    await show(Agenda);
    expect(api.calls('http.post')).toHaveLength(0);
    expect(manifest.permissions).not.toContain('http:post');
    expect(manifest.permissions).toContain('calendar:read');
    expect(manifest.apiPostPaths).toBeUndefined();
  });

  it('keeps running events, drops finished ones, sorts by start and caps the count', async () => {
    const list = [
      allDay('d', 'Holiday', '2026-10-16'),
      timed('e', 'Finished', new Date(2026, 9, 14, 7, 0), 60),
      timed('f', 'Running', new Date(2026, 9, 14, 8, 30), 60),
      timed('g', 'Later', new Date(2026, 9, 14, 18, 0), 60),
      allDay('h', 'Today all day', '2026-10-14'),
    ];
    const { Agenda } = setup('sidebar-section', { getEvents: async () => list, settings: { daysAhead: 7, maxEvents: 3 } });
    await show(Agenda);
    expect(rowTitles()).toEqual(['Today all day', 'Running', 'Later']);
  });

  it('places a timed event by its UTC start, not the wall clock of its own zone', async () => {
    const { Agenda } = setup('sidebar-section', { getEvents: async () => [events[0]] });
    await show(Agenda);
    const time = new Date(2026, 9, 14, 10, 0).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
    expect(document.body.textContent).toBe(`TodayStandup${time}`);
  });

  it('names an event without a title', async () => {
    const { Agenda } = setup('sidebar-section', { getEvents: async () => [timed('x', '  ', new Date(2026, 9, 14, 11, 0), 30)] });
    await show(Agenda);
    expect(rowTitles()).toEqual(['(No title)']);
  });

  it('reads ISO durations', () => {
    expect(durationMs('PT1H30M')).toBe(90 * 60_000);
    expect(durationMs('P1D')).toBe(86_400_000);
    expect(durationMs('P1W')).toBe(7 * 86_400_000);
    expect(durationMs('P1DT2H')).toBe(26 * 3_600_000);
    expect(durationMs('')).toBe(0);
  });
});

describe('sidebar section', () => {
  it('groups events under a line per day, with the time on each row and no header of its own', async () => {
    const { Agenda } = setup('sidebar-section');
    await show(Agenda);
    const time = clock(new Date(2026, 9, 14, 10, 0));
    const later = clock(new Date(2026, 9, 15, 15, 30));
    const days = [...document.querySelectorAll('[data-day]')];
    expect(days.map((d) => d.querySelector('[role="heading"]').textContent)).toEqual(['Today', 'Tomorrow']);
    expect(days.map((d) => [...d.querySelectorAll('[title]')].map((r) => r.textContent))).toEqual([
      [`Standup${time}`],
      ['OffsiteAll day', `Dropped${later}`],
    ]);
    expect(rows()[0].getAttribute('title')).toBe(`Standup · ${time} · Room 1`);
    expect(rows()[2].querySelector('del').textContent).toBe('Dropped');
    // The host draws the header and folds the section.
    expect(screen.queryByText('Agenda')).toBeNull();
    expect(screen.queryByRole('button', { name: /collapse|expand|refresh/i })).toBeNull();
  });

  it('marks each event with its calendar colour, blue when the calendar has none', async () => {
    const list = [
      timed('a', 'Work thing', new Date(2026, 9, 14, 10, 0), 30, { calendarId: 'work' }),
      timed('b', 'Home thing', new Date(2026, 9, 14, 11, 0), 30, { calendarId: 'home' }),
      timed('c', 'Orphan', new Date(2026, 9, 14, 12, 0), 30, { calendarId: 'gone' }),
    ];
    const { Agenda } = setup('sidebar-section', {
      getEvents: async () => list,
      listCalendars: async () => [{ id: 'work', color: '#ef4444' }, { id: 'home', color: '#22c55e' }, { id: 'plain', color: '' }],
    });
    await show(Agenda);
    expect(rows().map((r) => r.querySelector('[data-color]')?.getAttribute('data-color'))).toEqual(['#ef4444', '#22c55e', '#3b82f6']);
  });

  it('still lists events, all blue, when the calendars cannot be read', async () => {
    const { api, Agenda } = setup('sidebar-section', { listCalendars: async () => { throw new Error('nope'); } });
    await show(Agenda);
    expect(rowTitles()).toEqual(['Standup', 'Offsite', 'Dropped']);
    expect(rows().map((r) => r.querySelector('[data-color]').getAttribute('data-color'))).toEqual(['#3b82f6', '#3b82f6', '#3b82f6']);
    expect(api.calls('calendar.listCalendars')).toHaveLength(1);
  });

  it('puts an event that started before today and is still running under today', async () => {
    const list = [
      allDay('t', 'Trip', '2026-10-13', { duration: 'P3D' }),
      timed('a', 'Standup', new Date(2026, 9, 14, 10, 0), 15),
      allDay('n', 'Next week', '2026-10-17'),
    ];
    const { Agenda } = setup('sidebar-section', { getEvents: async () => list });
    await show(Agenda);
    const sat = new Date(2026, 9, 17).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
    expect(dayHeadings()).toEqual(['Today', sat]);
    expect(rowTitles()).toEqual(['Trip', 'Standup', 'Next week']);
  });

  it('says so when there is nothing, in the sidebar empty line', async () => {
    const { Agenda } = setup('sidebar-section', { getEvents: async () => [] });
    await show(Agenda);
    expect(document.body.textContent).toBe('No events in the next 7 day(s).');
  });

  it('shows the sign-in hint when there is no session', async () => {
    const { Agenda } = setup('sidebar-section', {
      getEvents: async () => { throw new Error('calendar.getEvents: no active session'); },
    });
    await show(Agenda);
    expect(document.body.textContent).toBe('Sign in to see your agenda.');
  });
});

describe('reading pane and top banner', () => {
  it('lists events per day with time and place in the reading pane', async () => {
    const { Agenda } = setup('email-detail-sidebar');
    await show(Agenda);
    expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy();
    const lists = screen.getAllByRole('list');
    expect(lists.map((l) => l.getAttribute('aria-label'))).toEqual(['Today', 'Tomorrow']);
    const items = screen.getAllByRole('listitem');
    expect(items.map((r) => r.textContent)).toEqual([
      `Standup${clock(new Date(2026, 9, 14, 10, 0))} · Room 1`,
      'OffsiteAll day',
      `Dropped${clock(new Date(2026, 9, 15, 15, 30))}`,
    ]);
  });

  it('shows an error as an alert in the reading pane', async () => {
    const { Agenda } = setup('email-detail-sidebar', { getEvents: async () => { throw new Error('boom'); } });
    await show(Agenda);
    expect(screen.getByRole('alert').textContent).toBe("Couldn't load agenda: boom");
  });

  it('puts the next events as chips in a compact info bar', async () => {
    const { Agenda } = setup('app-top-banner');
    await show(Agenda);
    const bar = document.querySelector('.bk-infobar');
    expect(bar.textContent.startsWith('Agenda')).toBe(true);
    expect(bar.querySelectorAll('span[title]')).toHaveLength(3);
  });
});

describe('regional formatting and locale settings', () => {
  it('formats times in 24h when timeFormat is 24h', async () => {
    const { Agenda } = setup('sidebar-section', {
      timeFormat: '24h',
      getEvents: async () => [timed('a', 'Afternoon Meeting', new Date(2026, 9, 14, 14, 30), 30)],
    });
    await show(Agenda);
    expect(document.body.textContent).toContain('Afternoon Meeting14:30');
  });

  it('formats times in 12h when timeFormat is 12h', async () => {
    const { Agenda } = setup('sidebar-section', {
      timeFormat: '12h',
      getEvents: async () => [timed('a', 'Afternoon Meeting', new Date(2026, 9, 14, 14, 30), 30)],
    });
    await show(Agenda);
    expect(document.body.textContent).toMatch(/Afternoon Meeting(2:30|02:30)\s*PM/);
  });

  it('formats date headings using dateLocale when provided', async () => {
    const { Agenda } = setup('sidebar-section', {
      dateLocale: 'de',
      getEvents: async () => [allDay('n', 'Future', '2026-10-18')],
    });
    await show(Agenda);
    const headings = dayHeadings();
    // 'de' locale short weekday for Sunday is 'So.'
    expect(headings.some((h) => h.includes('So.'))).toBe(true);
  });

  // Days are grouped in the browser's zone, so their labels and times must
  // be too: a zone setting 11 hours behind would put the heading for the
  // 18th's midnight on the 17th.
  it('labels days and times in the same zone it groups them in', async () => {
    const { Agenda } = setup('sidebar-section', {
      timeZone: 'Pacific/Pago_Pago',
      getEvents: async () => [allDay('n', 'Future', '2026-10-18'), timed('t', 'Late', new Date(2026, 9, 16, 9, 0), 30)],
    });
    await show(Agenda);
    expect(dayHeadings()).toEqual(['Fri, Oct 16', 'Sun, Oct 18']);
    expect(document.body.textContent).toContain(`Late${clock(new Date(2026, 9, 16, 9, 0))}`);
  });

  it('resolves untitled fallback dynamically in the active locale', async () => {
    const { Agenda } = setup('sidebar-section', {
      locale: 'de',
      getEvents: async () => [timed('x', '', new Date(2026, 9, 14, 11, 0), 30)],
    });
    await show(Agenda);
    expect(rowTitles()).toEqual(['(Kein Titel)']);
  });
});
