import { describe, expect, it } from 'vitest';
import { calendarWidget, contactsWidget, emailsWidget, normalizeWidget, parseWidgetJson } from '../src/lib/widgets.js';

// Widgets are checked before they are drawn: shapes, sizes, dates.

describe('normalizeWidget', () => {
  it('keeps the known kinds and drops the rest', () => {
    expect(normalizeWidget({ type: 'choices', items: ['a', { text: 'b' }, 5] })).toEqual({ type: 'choices', items: ['a', 'b'] });
    expect(normalizeWidget({ type: 'checklist', title: 'T', items: [{ text: 'do', due: '2026-10-30' }, { text: 'x', due: 'soon' }] }))
      .toEqual({ type: 'checklist', title: 'T', items: [{ text: 'do', due: '2026-10-30' }, { text: 'x', due: '' }] });
    expect(normalizeWidget({ type: 'times', items: [{ start: '2026-10-15T15:00', end: 'later' }] })).toEqual({ type: 'times', items: [{ start: '2026-10-15T15:00', end: '', label: '' }] });
    expect(normalizeWidget({ type: 'table', columns: ['a'], rows: [['1'], ['2']] })).toEqual({ type: 'table', columns: ['a'], rows: [['1'], ['2']] });
    expect(normalizeWidget({ type: 'script', src: 'x' })).toBeNull();
    expect(normalizeWidget({ type: 'choices', items: [] })).toBeNull();
    expect(normalizeWidget(null)).toBeNull();
  });

  it('caps long lists and texts', () => {
    const w = normalizeWidget({ type: 'choices', items: Array.from({ length: 50 }, (_, i) => `c${i}`.padEnd(300, 'x')) });
    expect(w.items).toHaveLength(30);
    expect(w.items[0]).toHaveLength(120);
  });

  it('reads the JSON of a widget block and ignores broken ones', () => {
    expect(parseWidgetJson('{"type":"choices","items":["ok"]}')).toEqual({ type: 'choices', items: ['ok'] });
    expect(parseWidgetJson('{"type":"choices", items: [')).toBeNull();
  });
});

describe('cards of the lookups', () => {
  it('lays calendar events out per day, busy or free, over the range asked', () => {
    const w = calendarWidget([
      { title: 'Standup', utcStart: '2026-10-22T08:00:00Z', utcEnd: '2026-10-22T08:15:00Z', isAllDay: false },
      { title: 'Offsite', start: '2026-10-23', isAllDay: true },
    ], { from: '2026-10-21', to: '2026-10-23' });
    expect(w.days.map((d) => [d.date, d.events.map((e) => e.title)])).toEqual([['2026-10-21', []], ['2026-10-22', ['Standup']], ['2026-10-23', ['Offsite']]]);
    expect(w.days[2].events[0].allDay).toBe(true);
  });

  it('lists contacts per address and messages with their ids', () => {
    expect(contactsWidget([
      { name: { full: 'Anna' }, emails: { work: { address: 'b@e.org', pref: 2 }, home: { address: 'a@e.org', pref: 1 } } },
      { name: { components: [{ kind: 'given', value: 'Bo' }, { kind: 'surname', value: 'Li' }] } },
    ])).toEqual({ type: 'contacts', items: [{ name: 'Anna', email: 'a@e.org' }, { name: 'Anna', email: 'b@e.org' }, { name: 'Bo Li', email: '' }] });
    expect(emailsWidget([
      { id: 'M1', subject: 'Hi', from: [{ name: 'Carol', email: 'c@e.org' }], receivedAt: '2026-10-12T09:00:00Z' },
      // The same newsletter delivered twice shows once.
      { id: 'M0', subject: 'Hi', from: [{ name: 'Carol', email: 'c@e.org' }], receivedAt: '2026-10-12T08:59:00Z' },
    ])).toEqual({ type: 'emails', items: [{ id: 'M1', subject: 'Hi', from: 'Carol', date: '2026-10-12T09:00:00Z' }] });
  });
});
