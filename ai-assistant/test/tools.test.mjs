import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { formatContacts, formatEvents, formatMySettings, formatSettings, runTool, toolsFor } from '../src/lib/tools.js';

// What the model may look up: offered by context and setting, run through
// the api, answered as text.

describe('toolsFor', () => {
  it('offers the original message only in a reply, the lookups unless turned off, and where a setting is always', () => {
    expect(toolsFor({}).map((t) => t.name)).toEqual(['check_calendar', 'find_contact', 'search_mail', 'read_message', 'read_my_settings', 'find_setting']);
    expect(toolsFor({ inReplyToId: 'M1' }).map((t) => t.name)).toEqual(['read_original_message', 'check_calendar', 'find_contact', 'search_mail', 'read_message', 'read_my_settings', 'find_setting']);
    // The user's own settings are a lookup; where a setting is, is the app's text.
    expect(toolsFor({ inReplyToId: 'M1', lookups: false }).map((t) => t.name)).toEqual(['read_original_message', 'find_setting']);
    expect(toolsFor({ lookups: false }).map((t) => t.name)).toEqual(['find_setting']);
    for (const tool of toolsFor({ inReplyToId: 'M1' })) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters.type).toBe('object');
    }
  });
});

describe('the app\'s settings', () => {
  it('finds where a setting is, by the names the user sees', async () => {
    const api = fakeApi({ handlers: { 'app.searchSettings': async () => [
      { pageId: 'composing', page: 'Verfassen', label: 'Senden rückgängig machen', description: 'Wartezeit vor dem Senden' },
    ] } });
    const text = await runTool(api, 'find_setting', { query: 'undo send' }, { settingsName: 'Einstellungen' });
    expect(api.calls('app.searchSettings')[0].args).toEqual(['undo send', { limit: 6 }]);
    expect(text).toContain('- Einstellungen > Verfassen > Senden rückgängig machen: Wartezeit vor dem Senden');
    await expect(runTool(api, 'find_setting', { query: ' ' })).rejects.toThrow(/query is empty/);
    expect(formatSettings([], 'teleport')).toContain('No setting matches "teleport"');
  });

  it('reads the user\'s settings with their units', async () => {
    const api = fakeApi({ handlers: { 'app.getSettings': async () => ({ sendDelaySeconds: 10, markAsReadDelay: 0, mailLayout: 'focus', calendarWorkingDays: [1, 2, 3] }) } });
    const text = await runTool(api, 'read_my_settings', {});
    expect(text).toContain('- sendDelaySeconds: 10 s');
    expect(text).toContain('- markAsReadDelay: 0 ms');
    expect(text).toContain('- mailLayout: focus');
    expect(text).toContain('- calendarWorkingDays: 1, 2, 3');
    expect(formatMySettings({})).toBe('No settings could be read.');
  });
});

describe('runTool', () => {
  it('reads the message the user replies to', async () => {
    const api = fakeApi({ handlers: { 'email.get': async (id) => ({ id, from: [{ name: 'Carol', email: 'carol@example.org' }], receivedAt: '2026-10-12T09:00:00Z', subject: 'Thursday', text: 'Can we meet?' }) } });
    const text = await runTool(api, 'read_original_message', {}, { inReplyToId: 'M1' });
    expect(text).toBe('From: Carol <carol@example.org>\nDate: 2026-10-12T09:00:00Z\nSubject: Thursday\n\nCan we meet?');
    expect(api.calls('email.get').map((c) => c.args)).toEqual([['M1']]);
    await expect(runTool(api, 'read_original_message', {}, {})).rejects.toThrow(/no original message/);
  });

  it('lists calendar events for a range, the end day included, and clamps odd ranges', async () => {
    const asked = [];
    const api = fakeApi({ handlers: { 'calendar.getEvents': async (q) => { asked.push(q); return [
      { title: 'Standup', utcStart: '2026-10-22T08:00:00Z', utcEnd: '2026-10-22T08:15:00Z', isAllDay: false, location: '' },
      { title: 'Offsite', start: '2026-10-23', isAllDay: true },
    ]; } } });
    const { text, widget } = await runTool(api, 'check_calendar', { from: '2026-10-22', to: '2026-10-23' });
    expect(asked).toEqual([{ from: '2026-10-22', to: '2026-10-24' }]);
    expect(text).toContain('Events between 2026-10-22 and 2026-10-23');
    expect(text).toContain('Standup');
    expect(text).toContain('2026-10-23 (all day): Offsite');
    // The card: one row per day, busy or free.
    expect(widget.type).toBe('calendar');
    expect(widget.days.map((d) => [d.date, d.events.length])).toEqual([['2026-10-22', 1], ['2026-10-23', 1]]);

    await runTool(api, 'check_calendar', { from: '2026-10-22', to: '2026-12-31' });
    expect(asked[1]).toEqual({ from: '2026-10-22', to: '2026-11-23' });
    await runTool(api, 'check_calendar', { from: '2026-10-22', to: '2026-10-01' });
    expect(asked[2]).toEqual({ from: '2026-10-22', to: '2026-10-23' });
    await expect(runTool(api, 'check_calendar', { from: 'tomorrow' })).rejects.toThrow(/date/);
  });

  it('finds contacts and keeps the list short', async () => {
    // JSContact cards, as api.contacts.search returns them
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      name: { full: `Person ${i}` },
      emails: { e1: { address: `p${i}@example.org` } },
      ...(i === 0 ? { organizations: { o1: { name: 'ACME' } } } : {}),
    }));
    const api = fakeApi({ handlers: { 'contacts.search': async () => many } });
    const { text, widget } = await runTool(api, 'find_contact', { query: 'Person' });
    expect(text.split('\n')).toHaveLength(6);
    expect(text).toContain('- Person 0: p0@example.org (ACME)');
    expect(widget).toMatchObject({ type: 'contacts', items: expect.arrayContaining([{ name: 'Person 0', email: 'p0@example.org' }]) });
    expect(api.calls('contacts.search').map((c) => c.args)).toEqual([['Person']]);
    await expect(runTool(api, 'find_contact', { query: '  ' })).rejects.toThrow(/empty/);
    await expect(runTool(api, 'nope', {})).rejects.toThrow(/unknown tool/);
  });
});

describe('mail lookups', () => {
  it('searches the mail through the api, lists ids for read_message, and brings a card', async () => {
    const asked = [];
    const api = fakeApi({ handlers: {
      'email.search': async (q) => { asked.push(q); return [{ id: 'M7', subject: 'Invoice 42', from: [{ name: 'Carol', email: 'carol@example.org' }], receivedAt: '2026-10-12T09:00:00Z', preview: 'Please find attached' }]; },
      'email.get': async (id) => ({ id, subject: 'Invoice 42', from: [{ name: 'Carol', email: 'carol@example.org' }], receivedAt: '2026-10-12T09:00:00Z', text: 'The invoice is attached.' }),
    } });
    const found = await runTool(api, 'search_mail', { text: 'invoice', from: 'carol', after: '2026-10-01', limit: 50 });
    expect(asked).toEqual([{ text: 'invoice', from: 'carol', after: '2026-10-01', limit: 10 }]);
    expect(found.text).toContain('id M7');
    expect(found.text).toContain('Invoice 42');
    expect(found.widget).toMatchObject({ type: 'emails', items: [{ id: 'M7', subject: 'Invoice 42', from: 'Carol' }] });
    const read = await runTool(api, 'read_message', { id: 'M7' });
    expect(read).toBe('From: Carol <carol@example.org>\nDate: 2026-10-12T09:00:00Z\nSubject: Invoice 42\n\nThe invoice is attached.');
    await expect(runTool(api, 'search_mail', {})).rejects.toThrow(/at least one of/);
    await expect(runTool(api, 'search_mail', { text: 'x', after: 'soon' })).rejects.toThrow(/date/);
    await expect(runTool(api, 'read_message', { id: '' })).rejects.toThrow(/empty/);
  });
});

describe('formatting', () => {
  it('says when there is nothing', () => {
    expect(formatEvents([], { from: '2026-10-22', to: '2026-10-22' })).toBe('No events between 2026-10-22 and 2026-10-22.');
    expect(formatContacts([], 'Zed')).toBe('No contact matches "Zed".');
  });
});
