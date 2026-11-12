// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { describeAction } from '../src/lib/actions.js';
import { actionCaps } from '../src/lib/areas/actions.js';
import { AssistantPanel } from '../src/ui/Panel.jsx';

// A change to an event that isn't the user's alone waits for the OK in
// automatic mode, also when nobody else is listed: an event in a calendar
// someone shared with the user (the webmail's view marks it only by the
// "<accountId>:" in front of its ids), an event where the user is listed but
// not as its owner, and an event whose people or owner the view can't tell.
// The user's own events follow the mode.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const BASE = { title: 'Team offsite', description: '', start: '2026-11-20T09:00:00', duration: 'PT8H', timeZone: 'Europe/Berlin', isAllDay: false, location: 'Office', isRecurring: false };
const ME = 'alice@example.org';
const EVENTS = {
  shared: { ...BASE, id: 'acct2:E5', calendarId: 'acct2:cal1', participants: [] },
  sharedCalendarOnly: { ...BASE, id: 'E6', calendarId: 'acct2:cal1', participants: [] },
  flagged: { ...BASE, id: 'E7', calendarId: 'cal1', isShared: true, participants: [] },
  attendee: { ...BASE, id: 'E10', calendarId: 'cal1', title: 'Supplier call', participants: [{ email: ME, role: 'attendee' }] },
  noRole: { ...BASE, id: 'E11', calendarId: 'cal1', participants: [{ email: ME, role: '' }] },
  noList: { ...BASE, id: 'E12', calendarId: 'cal1' },
  own: { ...BASE, id: 'E1', calendarId: 'cal1', participants: [] },
  ownAsOwner: { ...BASE, id: 'E2', calendarId: 'cal1', participants: [{ email: ME, role: 'owner' }] },
  ownBothRoles: { ...BASE, id: 'E3', calendarId: 'cal1', participants: [{ email: 'Alice@Example.org', role: 'owner,attendee' }] },
};
const byId = Object.fromEntries(Object.values(EVENTS).map((e) => [e.id, e]));

function apiWith(handlers = {}) {
  return fakeApi({
    translations: allStrings(), locale: 'en', dateLocale: 'en-GB', timeFormat: '24h', timeZone: 'Europe/Berlin', hostFeatures: {},
    handlers: {
      'calendar.getEvent': async (id) => byId[id] ?? null,
      'calendar.updateEvent': async () => ({}),
      'user.getIdentities': async () => [{ email: ME }],
      ...handlers,
    },
  });
}
const asks = async (event, change = { location: 'Room 2' }, handlers) => {
  const api = apiWith(handlers);
  const ctx = { actions: 'auto', lookups: true, config: {}, prefs: {}, zone: 'Europe/Berlin', doCaps: actionCaps(api) };
  return (await describeAction(api, 'update_event', { id: event.id, ...change }, ctx)).alwaysAsk;
};

describe('changing an event that isn\'t the user\'s alone', () => {
  it.each([
    ['in a calendar someone shared, with nobody listed', EVENTS.shared],
    ['whose calendar is another account\'s', EVENTS.sharedCalendarOnly],
    ['marked as shared', EVENTS.flagged],
    ['where the user is listed only as an attendee', EVENTS.attendee],
    ['where the user is listed without a role', EVENTS.noRole],
    ['whose view lists no people at all', EVENTS.noList],
  ])('asks first for an event %s', async (_what, event) => {
    expect(await asks(event)).toBe(true);
  });

  it('asks first for the user\'s event as owner when the user\'s addresses can\'t be read', async () => {
    expect(await asks(EVENTS.ownAsOwner, undefined, { 'user.getIdentities': async () => { throw new Error('no permission'); } })).toBe(true);
  });

  it.each([
    ['a time change', { start: '2026-11-20T10:00' }],
    ['a title change', { title: 'Offsite (moved)' }],
    ['the all-day switch', { isAllDay: true }],
  ])('asks first for %s in a shared calendar', async (_what, change) => {
    expect(await asks(EVENTS.shared, change)).toBe(true);
  });
});

describe('changing the user\'s own event (control)', () => {
  it.each([
    ['with nobody listed', EVENTS.own],
    ['with the user alone as owner', EVENTS.ownAsOwner],
    ['with the user as owner and attendee, written in capitals', EVENTS.ownBothRoles],
  ])('follows the mode for an event %s', async (_what, event) => {
    expect(await asks(event)).toBe(false);
  });
});

describe('in the panel, in automatic mode', () => {
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const toolCall = (input) => ev('message_start', { type: 'message_start' })
    + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'update_event' } })
    + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
    + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    + ev('message_stop', { type: 'message_stop' });
  const OPEN = { id: 'M1', subject: 'Notes', receivedAt: '2026-11-01T09:00:00Z', from: [{ name: 'Carol', email: 'carol@example.org' }], to: [{ email: ME }], mailboxIds: ['inbox'], text: 'Please move the offsite to the other office.' };

  async function change(input) {
    let i = 0;
    const turns = [toolCall(input)];
    const api = apiWith({
      'admin.getAllConfig': async () => CONFIG,
      'proxy.fetch': async () => streamResponse(i < turns.length ? turns[i++] : anthropicSse(['Done.'])),
      'email.get': async () => OPEN,
      'mailboxes.list': async () => [{ id: 'inbox', name: 'Inbox', role: 'inbox' }],
    });
    void api.storage.set('consent:v2:anthropic:http://localhost:18099', true);
    void api.storage.set('prefs', { actions: 'auto' });
    await act(async () => { render(React.createElement(AssistantPanel, { api, email: OPEN, selection: { text: '' }, focusRequest: 0 })); });
    const box = await screen.findByRole('textbox', { name: 'Message to the assistant' });
    await act(async () => { fireEvent.change(box, { target: { value: 'Tidy up my calendar.' } }); });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    const state = await waitFor(() => {
      if (api.calls('calendar.updateEvent').length) return 'changed';
      if (document.querySelector('[data-action="update_event"]')?.dataset.actionState === 'waiting') return 'waiting';
      throw new Error('not settled yet');
    }, { timeout: 5000 });
    return state;
  }

  it('waits for the OK before changing an event in a shared calendar', async () => {
    expect(await change({ id: 'acct2:E5', location: 'https://meet.example.net/room' })).toBe('waiting');
  });

  it('changes the user\'s own event without a question (control)', async () => {
    expect(await change({ id: 'E1', location: 'Room 2' })).toBe('changed');
  });
});
