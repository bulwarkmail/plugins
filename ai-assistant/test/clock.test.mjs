import { describe, expect, it } from 'vitest';
import { addDays, clock, dateIn, userZone, whenIn } from '../src/lib/clock.js';
import { calendarWidget } from '../src/lib/widgets.js';

// "Today" for the model is the user's date in their own time zone. The UTC
// date is a day behind in Europe after midnight and a day ahead in America
// every evening.

describe('the user\'s now', () => {
  it('is Saturday in Berlin at 00:30, when UTC is still Friday', () => {
    const now = clock('Europe/Berlin', new Date('2026-10-30T23:30:00Z'));
    expect(now).toMatchObject({ date: '2026-10-31', weekday: 'Saturday', time: '00:30', tomorrow: '2026-11-01', yesterday: '2026-10-30' });
    expect(now.line).toContain('Saturday, 2026-10-31, 00:30');
    expect(now.line).toContain('Tomorrow is Sunday, 2026-11-01');
    expect(now.line).toContain('yesterday was Friday, 2026-10-30');
    expect(now.line).toContain('Europe/Berlin');
  });

  it('is Wednesday in Berlin at 00:30 in summer time, two hours ahead of UTC', () => {
    const now = clock('Europe/Berlin', new Date('2026-07-14T22:30:00Z'));
    expect(now).toMatchObject({ date: '2026-07-15', weekday: 'Wednesday', time: '00:30', tomorrow: '2026-07-16' });
  });

  it('is still Saturday in Los Angeles at 23:30, when UTC is already Sunday', () => {
    const now = clock('America/Los_Angeles', new Date('2026-11-01T06:30:00Z'));
    expect(now).toMatchObject({ date: '2026-10-31', weekday: 'Saturday', time: '23:30', tomorrow: '2026-11-01' });
    expect(now.line).toContain('Tomorrow is Sunday, 2026-11-01');
  });

  it('follows the change to winter time in Los Angeles', () => {
    const now = clock('America/Los_Angeles', new Date('2026-11-08T07:30:00Z'));
    expect(now).toMatchObject({ date: '2026-11-07', weekday: 'Saturday', time: '23:30', tomorrow: '2026-11-08' });
  });

  it('counts days across months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('shows a mail\'s time in the user\'s zone', () => {
    expect(whenIn('Europe/Berlin', '2026-10-30T23:30:00Z')).toBe('Saturday, 2026-10-31 00:30');
    expect(dateIn('America/Los_Angeles', '2026-11-01T06:30:00Z')).toBe('2026-10-31');
  });
});

describe('which zone is the user\'s', () => {
  it('takes the host\'s zone, which follows the user\'s setting', () => {
    expect(userZone({ i18n: { timeZone: 'Europe/Berlin' } }, 'America/New_York')).toBe('Europe/Berlin');
  });

  it('takes the account\'s zone while the host still says UTC (regional settings not there yet)', () => {
    expect(userZone({ i18n: { timeZone: 'UTC' } }, 'Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('takes the account\'s zone on hosts without one', () => {
    expect(userZone({ i18n: {} }, 'Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('ignores a zone that is not one', () => {
    expect(userZone({ i18n: { timeZone: 'Mars/Base' } }, 'Europe/Paris')).toBe('Europe/Paris');
  });
});

describe('the calendar card', () => {
  it('files an event at 00:30 Berlin under its own day, not the UTC day before', () => {
    const w = calendarWidget([
      { title: 'Late call', utcStart: '2026-10-30T23:30:00Z', utcEnd: '2026-10-31T00:00:00Z' },
      { title: 'Lunch', utcStart: '2026-10-30T11:00:00Z', utcEnd: '2026-10-30T12:00:00Z' },
    ], { from: '2026-10-30', to: '2026-10-31', zone: 'Europe/Berlin' });
    expect(w.days.find((d) => d.date === '2026-10-30').events.map((e) => e.title)).toEqual(['Lunch']);
    expect(w.days.find((d) => d.date === '2026-10-31').events.map((e) => e.title)).toEqual(['Late call']);
  });

  it('keeps an all-day event on its date', () => {
    const w = calendarWidget([{ title: 'Holiday', start: '2026-10-31', isAllDay: true }], { from: '2026-10-31', to: '2026-10-31', zone: 'America/Los_Angeles' });
    expect(w.days[0].events.map((e) => e.title)).toEqual(['Holiday']);
  });
});
