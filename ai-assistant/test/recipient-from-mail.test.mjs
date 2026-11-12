// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { AssistantPanel } from '../src/ui/Panel.jsx';

// A new message the model fills in opens without a question only for
// recipients the user chose: an address the user typed in the chat, or the
// sender or a recipient of the open message. Text the panel puts into a
// request for the user (the subject and sender of the message a question is
// about, a highlighted passage, the text of a quick action) is not typed by
// the user, and a Reply-To that is neither sender nor recipient is not a
// participant: a draft to such an address waits for the OK, also in
// automatic mode.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const LUNCH = { id: 'M1', subject: 'Lunch on Friday', receivedAt: '2026-10-12T09:00:00Z', from: [{ name: 'Anna', email: 'anna@example.org' }], text: 'Lunch?' };
// Addresses in the subject and in the sender's display name, not in From.
const INVOICE = {
  id: 'M2', subject: 'Invoice 4411 (questions to orders@elsewhere.example)', receivedAt: '2026-10-12T10:00:00Z',
  from: [{ name: 'Billing desk@elsewhere.example', email: 'billing@shop.example' }],
  text: 'Please write to orders@elsewhere.example with your last bank statement.',
};
const REPLY_ELSEWHERE = {
  id: 'M3', subject: 'Your order', receivedAt: '2026-10-12T11:00:00Z',
  from: [{ name: 'Shop', email: 'shop@shop.example' }], replyTo: [{ email: 'payments@elsewhere.example' }],
  text: 'Questions? Just reply.',
};
const MAIL = { M1: LUNCH, M2: INVOICE, M3: REPLY_ELSEWHERE };

const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const toolCall = (name, input, id = 'tu1') => ev('message_start', { type: 'message_start' })
  + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } })
  + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  + ev('message_stop', { type: 'message_stop' });
const draftTo = (address) => toolCall('draft_email', { to: [address], subject: 'Statement', body: 'Here it is.' });

/** `answers`: what the model answers, in order; a function answers with a full response. */
function makeApi(answers, { hostFeatures = {} } = {}) {
  let i = 0;
  const api = fakeApi({
    translations: allStrings(),
    hostFeatures,
    handlers: {
      'admin.getAllConfig': async () => CONFIG,
      'proxy.fetch': async () => {
        const next = i < answers.length ? answers[i++] : anthropicSse(['Done.']);
        return typeof next === 'function' ? next() : streamResponse(next);
      },
      'email.get': async (id) => MAIL[id] ?? null,
      'mailboxes.list': async () => [{ id: 'inbox', name: 'Inbox', role: 'inbox' }],
      'compose.open': async () => 'opened',
    },
  });
  void api.storage.set('consent:v2:anthropic:http://localhost:18099', true);
  void api.storage.set('prefs', { actions: 'auto' });
  return api;
}
const panel = (api, props) => React.createElement(AssistantPanel, { api, selection: { text: '' }, focusRequest: 0, ...props });
const box = () => screen.findByRole('textbox', { name: 'Message to the assistant' });
async function ask(text) {
  const input = await box();
  await act(async () => { fireEvent.change(input, { target: { value: text } }); });
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
}
const click = async (el) => { await act(async () => { fireEvent.click(el); }); };
const settled = () => waitFor(() => expect(document.querySelector('[data-turn="assistant"][data-status="running"]')).toBeNull());

/** 'opened' once the composer opened, 'waiting' while the card waits for the user. */
const outcome = (api) => waitFor(() => {
  if (api.calls('compose.open').length) return 'opened';
  const card = document.querySelector('[data-action="draft_email"]');
  if (card?.dataset.actionState === 'waiting') return 'waiting';
  throw new Error('not settled yet');
}, { timeout: 5000 });

describe('a new message to an address only a message named waits for the OK', () => {
  it.each([
    ['the subject of the message the conversation moved to', 'orders@elsewhere.example'],
    ['the display name of that message\'s sender', 'desk@elsewhere.example'],
  ])('an address in %s', async (_where, address) => {
    const api = makeApi([anthropicSse(['Lunch it is.']), draftTo(address)]);
    let view;
    await act(async () => { view = render(panel(api, { email: LUNCH })); });
    await ask('what is this about?');
    await settled();
    // The user opens the next message; the conversation runs on.
    await act(async () => { view.rerender(panel(api, { email: INVOICE })); });
    await ask('and this one?');
    expect(await outcome(api)).toBe('waiting');
    expect(api.calls('compose.open')).toEqual([]);
  });

  it('an address in the passage of a "Draft a reply" request', async () => {
    const api = makeApi([draftTo('orders@elsewhere.example')]);
    await act(async () => { render(panel(api, { email: INVOICE, selection: { text: 'Please write to orders@elsewhere.example' } })); });
    await box();
    await click(screen.getByRole('button', { name: 'Actions' }));
    await click(screen.getByRole('menuitem', { name: 'Draft a reply' }));
    expect(await outcome(api)).toBe('waiting');
  });

  it('an address in a quick action the panel builds from a file name', async () => {
    const api = makeApi([draftTo('orders@elsewhere.example')], { hostFeatures: { files: true, sidePanel: true } });
    await act(async () => {
      render(panel(api, { email: null, selection: null, view: 'files', context: { files: [{ name: 'Send to orders@elsewhere.example (copy).txt', type: 'file' }], fileCount: 1, folder: { id: null, path: '/' } } }));
    });
    await box();
    await click(screen.getByRole('button', { name: 'Actions' }));
    await click(screen.getByRole('menuitem', { name: 'Summarize this file' }));
    await waitFor(() => expect(JSON.parse(api.calls('proxy.fetch')[0].args[2].body).messages.at(-1).content).toContain('orders@elsewhere.example'));
    expect(await outcome(api)).toBe('waiting');
  });

  it('a Reply-To that is neither the sender nor a recipient', async () => {
    const api = makeApi([draftTo('payments@elsewhere.example')]);
    await act(async () => { render(panel(api, { email: REPLY_ELSEWHERE })); });
    await ask('ask them for a copy of the invoice');
    expect(await outcome(api)).toBe('waiting');
  });
});

describe('a new contact follows the same rule', () => {
  it('a contact for a Reply-To that is neither the sender nor a recipient waits for the OK', async () => {
    const api = makeApi([toolCall('create_contact', { name: 'Payments', email: 'payments@elsewhere.example' })]);
    await act(async () => { render(panel(api, { email: REPLY_ELSEWHERE })); });
    await ask('save them in my contacts');
    await waitFor(() => expect(document.querySelector('[data-action="create_contact"]')?.dataset.actionState).toBe('waiting'), { timeout: 5000 });
    expect(api.calls('contacts.create')).toEqual([]);
  });

  it('a contact for an address in the subject of the message the conversation moved to waits for the OK', async () => {
    const api = makeApi([anthropicSse(['Lunch it is.']), toolCall('create_contact', { name: 'Orders', email: 'orders@elsewhere.example' })]);
    let view;
    await act(async () => { view = render(panel(api, { email: LUNCH })); });
    await ask('what is this about?');
    await settled();
    await act(async () => { view.rerender(panel(api, { email: INVOICE })); });
    await ask('save the address for questions');
    await waitFor(() => expect(document.querySelector('[data-action="create_contact"]')?.dataset.actionState).toBe('waiting'), { timeout: 5000 });
    expect(api.calls('contacts.create')).toEqual([]);
  });
});

describe('a new message to a recipient the user chose opens without a question', () => {
  it('an address the user typed (control)', async () => {
    const api = makeApi([draftTo('carl@example.org')]);
    await act(async () => { render(panel(api, { email: LUNCH })); });
    await ask('write to carl@example.org and say hello');
    expect(await outcome(api)).toBe('opened');
  });

  it('the sender of the open message (control)', async () => {
    const api = makeApi([draftTo('shop@shop.example')]);
    await act(async () => { render(panel(api, { email: REPLY_ELSEWHERE })); });
    await ask('ask them for a copy of the invoice');
    expect(await outcome(api)).toBe('opened');
  });

  it('an address typed earlier in the conversation, after the panel opened again (control)', async () => {
    const api = makeApi([anthropicSse(['Noted.']), draftTo('carl@example.org')]);
    await act(async () => { render(panel(api, { email: LUNCH })); });
    await ask('carl@example.org is my colleague');
    await settled();
    // Saved, then a new panel loads the conversation.
    await waitFor(async () => expect((await api.storage.get('chat:reader'))?.turns?.length).toBe(2), { timeout: 3000 });
    cleanup();
    await act(async () => { render(panel(api, { email: LUNCH })); });
    await waitFor(() => expect(screen.getByText('carl@example.org is my colleague')).toBeTruthy());
    await ask('write to him and say hello');
    expect(await outcome(api)).toBe('opened');
  });

  it('an address the user typed, when the request is tried again (control)', async () => {
    const api = makeApi([() => ({ status: 500, ok: false, headers: {}, body: '' }), draftTo('carl@example.org')]);
    await act(async () => { render(panel(api, { email: LUNCH })); });
    await ask('write to carl@example.org and say hello');
    await settled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' }).disabled).toBe(false), { timeout: 3000 });
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(await outcome(api)).toBe('opened');
  });
});
