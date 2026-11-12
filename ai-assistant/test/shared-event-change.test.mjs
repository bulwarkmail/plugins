// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { AssistantPanel } from '../src/ui/Panel.jsx';

// A change to an event other people take part in reaches them: they read
// its title, place and description, and a new time moves the meeting in
// their calendars. In automatic mode such a change waits for the user's OK,
// whichever field it touches. An event of the user alone keeps following
// the mode. The panel runs with a scripted model answer; what counts is
// whether calendar.updateEvent was called before anyone pressed OK.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const OPEN = { id: 'M1', subject: 'Notes', receivedAt: '2026-11-01T09:00:00Z', from: [{ name: 'Carol', email: 'carol@example.org' }], to: [{ email: 'alice@example.org' }], mailboxIds: ['inbox'], text: 'See you at the meeting.' };
const BASE = { title: 'Board meeting', description: 'Agenda attached', start: '2026-11-03T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', isAllDay: false, location: 'Room 1', isRecurring: false };
const EVENTS = {
  // Alice (the user) organises, Bob attends.
  E9: { ...BASE, id: 'E9', uid: 'u9', participants: [{ email: 'alice@example.org', role: 'owner' }, { email: 'bob@partner.example', role: 'attendee' }] },
  // Bob organises, Alice attends.
  E8: { ...BASE, id: 'E8', uid: 'u8', title: 'Supplier call', participants: [{ email: 'bob@partner.example', role: 'owner' }, { email: 'Alice@example.org', role: 'attendee' }] },
  // A weekly meeting with Bob.
  E7: { ...BASE, id: 'E7', uid: 'u7', title: 'Weekly sync', isRecurring: true, participants: [{ email: 'alice@example.org', role: 'owner' }, { email: 'bob@partner.example', role: 'attendee' }] },
  // The user's own events: no participants, or the user alone.
  E1: { ...BASE, id: 'E1', uid: 'u1', title: 'Dentist', participants: [] },
  E2: { ...BASE, id: 'E2', uid: 'u2', title: 'Focus time', participants: [{ email: 'alice@example.org', role: 'owner' }] },
};

const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const toolCall = (name, input, id = 'tu1') => ev('message_start', { type: 'message_start' })
  + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } })
  + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  + ev('message_stop', { type: 'message_stop' });

function makeApi(turns) {
  let i = 0;
  const api = fakeApi({
    translations: allStrings(), locale: 'en', dateLocale: 'en-GB', timeFormat: '24h', timeZone: 'Europe/Berlin', hostFeatures: {},
    handlers: {
      'admin.getAllConfig': async () => CONFIG,
      'proxy.fetch': async () => streamResponse(i < turns.length ? turns[i++] : anthropicSse(['Done.'])),
      'email.get': async () => OPEN,
      'mailboxes.list': async () => [{ id: 'inbox', name: 'Inbox', role: 'inbox' }],
      'calendar.getEvent': async (id) => EVENTS[id] ?? null,
      'calendar.updateEvent': async () => ({}),
      'user.getIdentities': async () => [{ email: 'alice@example.org' }],
    },
  });
  void api.storage.set('consent:v2:anthropic:http://localhost:18099', true);
  void api.storage.set('prefs', { actions: 'auto' });
  return api;
}

async function askWith(api) {
  await act(async () => { render(React.createElement(AssistantPanel, { api, email: OPEN, selection: { text: '' }, focusRequest: 0 })); });
  const box = await screen.findByRole('textbox', { name: 'Message to the assistant' });
  await act(async () => { fireEvent.change(box, { target: { value: 'Tidy up my calendar.' } }); });
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
}

/** 'changed' once the change reached the host, 'waiting' while its card waits for the user. */
function outcome(api) {
  return waitFor(() => {
    if (api.calls('calendar.updateEvent').length) return 'changed';
    const card = document.querySelector('[data-action="update_event"]');
    if (card?.dataset.actionState === 'waiting') return 'waiting';
    throw new Error('not settled yet');
  }, { timeout: 5000 });
}

describe('changing an event other people take part in, in automatic mode', () => {
  it.each([
    ['its title', { id: 'E9', title: 'Board meeting (budget)' }],
    ['its place', { id: 'E9', location: 'https://meet.example.net/room' }],
    ['its start', { id: 'E9', start: '2026-12-24T03:00' }],
    ['its end', { id: 'E9', end: '2026-11-03T18:00' }],
    ['its description', { id: 'E9', description: 'New agenda' }],
    ['it to all day', { id: 'E9', isAllDay: true }],
    ['the title of one someone else organises', { id: 'E8', title: 'Supplier call (moved)' }],
    ['the time of a repeating one', { id: 'E7', start: '2026-11-03T11:00' }],
  ])('waits for the OK before changing %s', async (_what, change) => {
    const api = makeApi([toolCall('update_event', change)]);
    await askWith(api);
    expect(await outcome(api)).toBe('waiting');
    expect(api.calls('calendar.updateEvent')).toEqual([]);
  });

  it('changes it after the user\'s OK', async () => {
    const api = makeApi([toolCall('update_event', { id: 'E9', title: 'Board meeting (budget)' })]);
    await askWith(api);
    expect(await outcome(api)).toBe('waiting');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Do it' })); });
    await waitFor(() => expect(api.calls('calendar.updateEvent').map((c) => c.args)).toEqual([['E9', { title: 'Board meeting (budget)' }]]));
  });
});

describe('changing an event of the user alone, in automatic mode', () => {
  it.each([
    ['one without participants', { id: 'E1', title: 'Dentist (moved)' }],
    ['one where the user is the only participant', { id: 'E2', start: '2026-11-03T14:00' }],
  ])('changes %s without a question (control)', async (_what, change) => {
    const api = makeApi([toolCall('update_event', change)]);
    await askWith(api);
    expect(await outcome(api)).toBe('changed');
    expect(api.calls('calendar.updateEvent')[0].args[0]).toBe(change.id);
  });
});
