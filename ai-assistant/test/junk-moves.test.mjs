// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { describeAction } from '../src/lib/actions.js';
import { AssistantPanel } from '../src/ui/Panel.jsx';

// A message in the junk folder was put away by the server or the user.
// Moving it out (to the inbox, any folder, or the archive) puts it back in
// sight, so it waits for the user's OK in automatic mode, also when it is
// the open message. The junk folder is known by its role, whatever its name.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const NOTICE = { id: 'M5', subject: 'Account notice', receivedAt: '2026-11-10T12:00:00Z', from: [{ name: 'Billing', email: 'billing@shop.example' }], to: [{ email: 'alice@example.org' }], mailboxIds: ['junk'], text: 'This notice belongs in your inbox.' };
const MAP_IDS = { ...NOTICE, id: 'M6', mailboxIds: { junk: true } };
const GERMAN_NOTICE = { ...NOTICE, id: 'M7', mailboxIds: ['spam-de'] };
const INBOX_MAIL = { ...NOTICE, id: 'M8', subject: 'Receipt', mailboxIds: ['inbox'] };
const MAIL = { M5: NOTICE, M6: MAP_IDS, M7: GERMAN_NOTICE, M8: INBOX_MAIL };
const FOLDERS = [
  { id: 'inbox', name: 'Inbox', role: 'inbox' },
  { id: 'junk', name: 'Junk', role: 'junk' },
  { id: 'bills', name: 'Bills', role: null },
  { id: 'archive', name: 'Archive', role: 'archive' },
];
const GERMAN = [
  { id: 'inbox-de', name: 'Posteingang', role: 'inbox' },
  { id: 'spam-de', name: 'Unerwünscht', role: 'junk' },
];

const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const toolCall = (name, input, id = 'tu1') => ev('message_start', { type: 'message_start' })
  + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } })
  + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  + ev('message_stop', { type: 'message_stop' });

function makeApi({ turns = [], folders = FOLDERS, handlers = {} } = {}) {
  let i = 0;
  const api = fakeApi({
    translations: allStrings(),
    handlers: {
      'admin.getAllConfig': async () => CONFIG,
      'proxy.fetch': async () => streamResponse(i < turns.length ? turns[i++] : anthropicSse(['Done.'])),
      'email.get': async (id) => MAIL[id] ?? null,
      'mailboxes.list': async () => folders,
      ...handlers,
    },
  });
  void api.storage.set('consent:v2:anthropic:http://localhost:18099', true);
  void api.storage.set('prefs', { actions: 'auto' });
  return api;
}
async function run(email, call, options = {}) {
  const api = makeApi({ turns: [call], ...options });
  await act(async () => { render(React.createElement(AssistantPanel, { api, email, selection: { text: '' }, focusRequest: 0 })); });
  const box = await screen.findByRole('textbox', { name: 'Message to the assistant' });
  await act(async () => { fireEvent.change(box, { target: { value: 'is this real?' } }); });
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
  return api;
}
function outcome(api, action, method) {
  return waitFor(() => {
    if (api.calls(method).length) return 'done';
    const card = document.querySelector(`[data-action="${action}"]`);
    if (card?.dataset.actionState === 'waiting') return 'waiting';
    throw new Error('not settled yet');
  }, { timeout: 5000 });
}

describe('the open message in the junk folder, in automatic mode', () => {
  it.each([
    ['to the inbox', { id: 'M5', folder: 'inbox' }],
    ['to an ordinary folder', { id: 'M5', folder: 'Bills' }],
  ])('waits for the OK before moving it %s', async (_where, input) => {
    const api = await run(NOTICE, toolCall('move_message', input));
    expect(await outcome(api, 'move_message', 'email.move')).toBe('waiting');
    expect(api.calls('email.move')).toEqual([]);
  });

  it('waits for the OK before archiving it', async () => {
    const api = await run(NOTICE, toolCall('archive_message', { id: 'M5' }));
    expect(await outcome(api, 'archive_message', 'email.archive')).toBe('waiting');
    expect(api.calls('email.archive')).toEqual([]);
  });

  it('waits for the OK when its folders come as a map', async () => {
    const api = await run(MAP_IDS, toolCall('move_message', { id: 'M6', folder: 'inbox' }));
    expect(await outcome(api, 'move_message', 'email.move')).toBe('waiting');
  });

  it('waits for the OK when the junk folder has another name', async () => {
    const api = await run(GERMAN_NOTICE, toolCall('move_message', { id: 'M7', folder: 'Posteingang' }), { folders: GERMAN });
    expect(await outcome(api, 'move_message', 'email.move')).toBe('waiting');
  });

  it('moves it after the user\'s OK', async () => {
    const api = await run(NOTICE, toolCall('move_message', { id: 'M5', folder: 'inbox' }));
    expect(await outcome(api, 'move_message', 'email.move')).toBe('waiting');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Do it' })); });
    await waitFor(() => expect(api.calls('email.move').map((c) => c.args)).toEqual([[['M5'], 'inbox']]));
  });
});

describe('archiving when the folders can\'t be read', () => {
  it('asks first', async () => {
    const api = makeApi({ handlers: { 'mailboxes.list': async () => { throw new Error('offline'); } } });
    const { alwaysAsk } = await describeAction(api, 'archive_message', { id: 'M8' }, { openEmailId: 'M8' });
    expect(alwaysAsk).toBe(true);
  });
});

describe('the open message in another folder, in automatic mode', () => {
  it('moves it to an ordinary folder without a question (control)', async () => {
    const api = await run(INBOX_MAIL, toolCall('move_message', { id: 'M8', folder: 'Bills' }));
    expect(await outcome(api, 'move_message', 'email.move')).toBe('done');
  });

  it('archives it without a question (control)', async () => {
    const api = await run(INBOX_MAIL, toolCall('archive_message', { id: 'M8' }));
    expect(await outcome(api, 'archive_message', 'email.archive')).toBe('done');
  });
});
