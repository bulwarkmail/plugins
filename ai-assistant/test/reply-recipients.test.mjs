// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { describeAction, replyToOf } from '../src/lib/actions.js';
import { AssistantPanel } from '../src/ui/Panel.jsx';

// A reply goes where the webmail addresses it: the Reply-To, else the
// sender (reply to all adds To and Cc). The card says where. When that is an
// address neither the sender nor a recipient of the message, and the user
// didn't type it, the reply waits for the OK, also in automatic mode; so
// does a reply whose recipients the message view doesn't show. The
// webmail's view carries Reply-To only in the raw headers.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const BASE = {
  subject: 'Your order', receivedAt: '2026-11-10T11:00:00Z', mailboxIds: ['inbox'], text: 'Questions? Just reply.',
  from: [{ name: 'Shop', email: 'shop@shop.example' }], to: [{ name: 'Alice', email: 'alice@example.org' }], cc: [{ name: 'Bob', email: 'bob@example.org' }],
};
const MAIL = {
  // Reply-To in the raw headers, as the webmail's view gives it.
  M1: { ...BASE, id: 'M1', headers: { 'Reply-To': ' Payments <payments@elsewhere.example>' } },
  // The same as a list, as other views may give it.
  M2: { ...BASE, id: 'M2', replyTo: [{ email: 'payments@elsewhere.example' }] },
  // Two Reply-To addresses, one of them a recipient.
  M3: { ...BASE, id: 'M3', headers: { 'reply-to': ' bob@example.org, Payments <payments@elsewhere.example>' } },
  // A view without headers: nobody can tell where a reply goes.
  M4: { ...BASE, id: 'M4' },
  // A Reply-To header without a readable address.
  M5: { ...BASE, id: 'M5', headers: { 'Reply-To': ' undisclosed-recipients:;' } },
  // No Reply-To: the reply goes to the sender.
  M6: { ...BASE, id: 'M6', headers: { Subject: 'Your order' } },
  // Reply-To is the Cc recipient.
  M7: { ...BASE, id: 'M7', headers: { 'Reply-To': ' Bob <bob@example.org>' } },
  // The user's own message: a reply goes to its recipients.
  M8: { ...BASE, id: 'M8', from: [{ name: 'Alice', email: 'alice@example.org' }], to: [{ name: 'Carl', email: 'carl@example.org' }], cc: [], headers: {} },
};

const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const toolCall = (name, input, id = 'tu1') => ev('message_start', { type: 'message_start' })
  + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } })
  + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  + ev('message_stop', { type: 'message_stop' });

function makeApi(turns = []) {
  let i = 0;
  const api = fakeApi({
    translations: allStrings(),
    handlers: {
      'admin.getAllConfig': async () => CONFIG,
      'proxy.fetch': async () => streamResponse(i < turns.length ? turns[i++] : anthropicSse(['Done.'])),
      'email.get': async (id) => MAIL[id] ?? null,
      'mailboxes.list': async () => [{ id: 'inbox', name: 'Inbox', role: 'inbox' }],
      'compose.reply': async () => true,
      'user.getIdentities': async () => [{ email: 'alice@example.org' }],
    },
  });
  void api.storage.set('consent:v2:anthropic:http://localhost:18099', true);
  void api.storage.set('prefs', { actions: 'auto' });
  return api;
}
async function replyFromPanel(id, typed = 'answer them for me') {
  const api = makeApi([toolCall('draft_reply', { text: 'Thanks, here is the statement.' })]);
  await act(async () => { render(React.createElement(AssistantPanel, { api, email: MAIL[id], selection: { text: '' }, focusRequest: 0 })); });
  const box = await screen.findByRole('textbox', { name: 'Message to the assistant' });
  await act(async () => { fireEvent.change(box, { target: { value: typed } }); });
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
  const state = await waitFor(() => {
    if (api.calls('compose.reply').length) return 'opened';
    const card = document.querySelector('[data-action="draft_reply"]');
    if (card?.dataset.actionState === 'waiting') return 'waiting';
    throw new Error('not settled yet');
  }, { timeout: 5000 });
  return { api, state, card: document.querySelector('[data-action="draft_reply"]')?.textContent ?? '' };
}
const summary = async (id, args = {}, ctx = {}) => (await describeAction(makeApi(), 'draft_reply', { text: 'Hi', ...args }, { openEmailId: id, ...ctx })).summary.split('\n');

describe('a reply the model drafts, in automatic mode', () => {
  it.each([
    ['a Reply-To header that is neither sender nor recipient', 'M1'],
    ['a Reply-To list that is neither sender nor recipient', 'M2'],
    ['two Reply-To addresses, one of them unknown', 'M3'],
  ])('waits for the OK with %s, and the card names it', async (_what, id) => {
    const { api, state, card } = await replyFromPanel(id);
    expect(state).toBe('waiting');
    expect(api.calls('compose.reply')).toEqual([]);
    expect(card).toContain('The reply goes to');
    expect(card).toContain('payments@elsewhere.example');
  });

  it.each([
    ['a message view without headers', 'M4'],
    ['a Reply-To without a readable address', 'M5'],
  ])('waits for the OK with %s, and says it can\'t tell where it goes', async (_what, id) => {
    const { state, card } = await replyFromPanel(id);
    expect(state).toBe('waiting');
    expect(card).toContain('This message doesn\'t show where a reply would go');
  });

  it('opens it after the user\'s OK', async () => {
    const { api } = await replyFromPanel('M1');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Do it' })); });
    await waitFor(() => expect(api.calls('compose.reply').map((c) => c.args[0])).toEqual(['M1']));
  });

  it.each([
    ['without a Reply-To, to the sender', 'M6'],
    ['with a Reply-To that is the Cc recipient', 'M7'],
    ['to the user\'s own message, to its recipient', 'M8'],
  ])('opens a reply %s without a question (control)', async (_what, id) => {
    const { state } = await replyFromPanel(id);
    expect(state).toBe('opened');
  });

  it('opens a reply to a Reply-To the user typed without a question (control)', async () => {
    const { state } = await replyFromPanel('M1', 'reply to payments@elsewhere.example and thank them');
    expect(state).toBe('opened');
  });
});

describe('the reply card', () => {
  it('names where a reply and a reply to all go, without the user\'s own address', async () => {
    expect(await summary('M6')).toEqual(['Open a reply to “Your order” with the drafted text', 'The reply goes to shop@shop.example']);
    expect(await summary('M6', { all: true })).toEqual(['Open a reply to all for “Your order” with the drafted text', 'The reply goes to shop@shop.example, bob@example.org']);
    expect(await summary('M1', { all: true })).toEqual(['Open a reply to all for “Your order” with the drafted text', 'The reply goes to payments@elsewhere.example, bob@example.org']);
    expect(await summary('M8')).toEqual(['Open a reply to “Your order” with the drafted text', 'The reply goes to carl@example.org']);
  });

  it('is in the user\'s language', async () => {
    const api = makeApi();
    api.setLocale('de');
    const { summary: text } = await describeAction(api, 'draft_reply', { text: 'Hi' }, { openEmailId: 'M1' });
    expect(text.split('\n')[1]).toBe('Die Antwort geht an payments@elsewhere.example');
  });
});

describe('reading the Reply-To of a message view', () => {
  it('from a list, from raw headers by any spelling of the name, or not at all', () => {
    expect(replyToOf(MAIL.M2)).toEqual(['payments@elsewhere.example']);
    expect(replyToOf(MAIL.M3)).toEqual(['bob@example.org', 'payments@elsewhere.example']);
    expect(replyToOf({ headers: { 'Reply-To': [' a@example.org', ' B <b@example.org>'] } })).toEqual(['a@example.org', 'b@example.org']);
    expect(replyToOf({ headers: [{ name: 'Reply-To', value: ' c@example.org' }] })).toEqual(['c@example.org']);
    expect(replyToOf(MAIL.M6)).toEqual([]);
    expect(replyToOf(MAIL.M4)).toBeNull();
    expect(replyToOf(MAIL.M5)).toBeNull();
  });
});
