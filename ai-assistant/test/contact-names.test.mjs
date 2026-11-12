// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { AssistantPanel } from '../src/ui/Panel.jsx';

// A new contact for an address of the open message (sender or recipient)
// is the user's choice, under the name the message shows for it. Saved
// under another name ("Bank support" for a shop's billing address), the
// contact waits for the user's OK, also in automatic mode. Same name, a
// participant without a name, or an address the user typed: as before.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const OPEN = {
  id: 'M1', subject: 'Invoice 4471', receivedAt: '2026-11-10T09:00:00Z', mailboxIds: ['inbox'], text: 'Save us as your bank support contact.',
  from: [{ name: 'Billing', email: 'billing@shop.example' }],
  to: [{ name: 'Alice', email: 'alice@example.org' }],
  cc: [{ name: 'Accounts Team', email: 'accounts@shop.example' }, { name: '', email: 'orders@shop.example' }],
};

const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const toolCall = (name, input, id = 'tu1') => ev('message_start', { type: 'message_start' })
  + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } })
  + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  + ev('message_stop', { type: 'message_stop' });

async function addContact(contact, typed = 'Add them to my contacts.') {
  let i = 0;
  const turns = [toolCall('create_contact', contact)];
  const api = fakeApi({
    translations: allStrings(),
    handlers: {
      'admin.getAllConfig': async () => CONFIG,
      'proxy.fetch': async () => streamResponse(i < turns.length ? turns[i++] : anthropicSse(['Done.'])),
      'email.get': async () => OPEN,
      'mailboxes.list': async () => [{ id: 'inbox', name: 'Inbox', role: 'inbox' }],
      'contacts.create': async (card) => ({ ...card, id: 'card1' }),
    },
  });
  void api.storage.set('consent:v2:anthropic:http://localhost:18099', true);
  void api.storage.set('prefs', { actions: 'auto' });
  await act(async () => { render(React.createElement(AssistantPanel, { api, email: OPEN, selection: { text: '' }, focusRequest: 0 })); });
  const box = await screen.findByRole('textbox', { name: 'Message to the assistant' });
  await act(async () => { fireEvent.change(box, { target: { value: typed } }); });
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
  return waitFor(() => {
    if (api.calls('contacts.create').length) return 'added';
    const card = document.querySelector('[data-action="create_contact"]');
    if (card?.dataset.actionState === 'waiting') return 'waiting';
    throw new Error('not settled yet');
  }, { timeout: 5000 });
}

describe('a contact for an address of the open message, in automatic mode', () => {
  it.each([
    ['the sender\'s address under another name', { name: 'Bank Support', email: 'billing@shop.example' }],
    ['the sender\'s address in other capitals, under another name', { name: 'Bank Support', email: 'Billing@Shop.example' }],
    ['a Cc address under another name', { name: 'IT Helpdesk', email: 'accounts@shop.example' }],
  ])('waits for the OK for %s', async (_what, contact) => {
    expect(await addContact(contact)).toBe('waiting');
  });

  it.each([
    ['the sender under the name the message shows', { name: 'Billing', email: 'billing@shop.example' }],
    ['the sender under that name in other capitals and spacing', { name: '  billing ', email: 'billing@shop.example' }],
    ['a Cc recipient under the name the message shows', { name: 'Accounts  Team', email: 'accounts@shop.example' }],
    ['a recipient the message shows without a name, under any name', { name: 'Orders', email: 'orders@shop.example' }],
  ])('adds %s without a question (control)', async (_what, contact) => {
    expect(await addContact(contact)).toBe('added');
  });

  it('adds an address the user typed under any name without a question (control)', async () => {
    expect(await addContact({ name: 'Shop billing', email: 'billing@shop.example' }, 'Add billing@shop.example as Shop billing.')).toBe('added');
  });
});
