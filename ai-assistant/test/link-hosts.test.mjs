// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { archiveChat } from '../src/lib/chat-history.js';
import { Markdown } from '../src/ui/Markdown.jsx';
import { AssistantPanel } from '../src/ui/Panel.jsx';

// Links in an answer: the model writes them, from whatever it read. A link
// whose text is not its own address shows the host it leads to next to the
// text, in the running chat, after a reload and in an earlier chat. A link
// written as its address opens with one click and needs no extra host.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const EMAIL = { id: 'M1', subject: 'Invoice 4471', receivedAt: '2026-11-10T09:00:00Z', from: [{ name: 'Billing', email: 'billing@shop.example' }], text: 'The invoice is attached.' };
const LABELLED = 'Due Friday.\n\n[View invoice](https://pay.example.net/c?d=123)';

/** The host shown next to the link whose text is `label`, or null. */
const hostNextTo = (label) => {
  const button = screen.getByRole('button', { name: label });
  let node = button.nextSibling;
  while (node && node.nodeType === 3 && !node.textContent.trim()) node = node.nextSibling;
  return node?.matches?.('[data-link-host]') ? node.textContent : null;
};

describe('a link in formatted text', () => {
  it('shows the host next to a text that is not its address, and still opens with one click', () => {
    const open = vi.fn();
    render(React.createElement(Markdown, { text: LABELLED, onOpenLink: open }));
    expect(hostNextTo('View invoice')).toBe('(pay.example.net)');
    fireEvent.click(screen.getByRole('button', { name: 'View invoice' }));
    expect(open).toHaveBeenCalledWith('https://pay.example.net/c?d=123');
  });

  it('shows the real host when the text is another address', () => {
    render(React.createElement(Markdown, { text: 'Sign in at [https://bank.example](https://other.example/login).' }));
    expect(hostNextTo('https://bank.example')).toBe('(other.example)');
  });

  it('shows the host after a user part in the address, not the user part', () => {
    render(React.createElement(Markdown, { text: '[Your bank](https://bank.example@other.example/login)' }));
    expect(hostNextTo('Your bank')).toBe('(other.example)');
  });

  it('shows the host in lists, quotes and tables too', () => {
    render(React.createElement(Markdown, { text: '- [one](https://a.example/1)\n\n> [two](https://b.example/2)\n\n| A |\n|---|\n| [three](https://c.example/3) |' }));
    expect(hostNextTo('one')).toBe('(a.example)');
    expect(hostNextTo('two')).toBe('(b.example)');
    expect(hostNextTo('three')).toBe('(c.example)');
  });

  it('adds nothing to a link written as its own address (control)', () => {
    const open = vi.fn();
    render(React.createElement(Markdown, { text: 'See https://example.org/docs and [https://example.org/help](https://example.org/help).', onOpenLink: open }));
    expect(document.querySelector('[data-link-host]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'https://example.org/docs' }));
    expect(open).toHaveBeenCalledWith('https://example.org/docs');
  });

  it('adds nothing to a plain link followed by bracketed text that is no host (control)', () => {
    render(React.createElement(Markdown, { text: 'See https://example.org/docs (page 2) for that.' }));
    expect(document.querySelector('[data-link-host]')).toBeNull();
  });
});

describe('the host next to a link, kept readable', () => {
  const RLO = '‮';

  it('is isolated left to right, so a direction change earlier in the answer can\'t turn it around', () => {
    render(React.createElement(Markdown, { text: `Pay here ${RLO}[View invoice](https://pay.example.net/c) today.` }));
    const host = document.querySelector('[data-link-host]');
    expect(host.textContent).toBe('(pay.example.net)');
    expect(host.tagName).toBe('BDI');
    expect(host.getAttribute('dir')).toBe('ltr');
  });

  it('follows a link text without direction controls', () => {
    render(React.createElement(Markdown, { text: `[${RLO}View invoice⁦](https://pay.example.net/c)` }));
    const button = screen.getByRole('button', { name: 'View invoice' });
    expect(button.textContent).toBe('View invoice');
    expect(hostNextTo('View invoice')).toBe('(pay.example.net)');
  });
});

describe('a link written as its own address that could mislead', () => {
  const lookAlike = 'https://bаnk.example/login';

  it.each([
    ['with a user part, as a labelled link', '[https://bank.example@other.example/](https://bank.example@other.example/)', 'https://bank.example@other.example/', '(other.example)'],
    ['with a user part, written bare', 'Sign in at https://bank.example@other.example/login now', 'https://bank.example@other.example/login', '(other.example)'],
    ['with a look-alike letter in the host', `Sign in at ${lookAlike} now`, lookAlike, `(${new URL(lookAlike).host})`],
    ['with a punycode host', 'Sign in at https://xn--bnk-sna.example/login now', 'https://xn--bnk-sna.example/login', '(xn--bnk-sna.example)'],
    ['followed by bracketed text that looks like a host', 'Pay at https://other.example/pay (bank.example) today', 'https://other.example/pay', '(other.example)'],
  ])('shows its host %s', (_what, text, label, host) => {
    render(React.createElement(Markdown, { text }));
    expect(hostNextTo(label)).toBe(host);
  });

  it('shows the real host after a link text that ends in a host of its own', () => {
    render(React.createElement(Markdown, { text: '[Pay (bank.example)](https://other.example/pay)' }));
    expect(hostNextTo('Pay (bank.example)')).toBe('(other.example)');
  });
});

function makeApi({ answers = [LABELLED] } = {}) {
  let i = 0;
  const api = fakeApi({
    translations: allStrings(),
    handlers: {
      'admin.getAllConfig': async () => CONFIG,
      'proxy.fetch': async () => streamResponse(anthropicSse([answers[Math.min(i++, answers.length - 1)]])),
      'email.get': async () => EMAIL,
    },
  });
  void api.storage.set('consent:v2:anthropic:http://localhost:18099', true);
  return api;
}
async function mount(api) {
  await act(async () => { render(React.createElement(AssistantPanel, { api, email: EMAIL, selection: { text: '' }, focusRequest: 0 })); });
  return screen.findByRole('textbox', { name: 'Message to the assistant' });
}
const settled = () => waitFor(() => expect(document.querySelector('[data-turn="assistant"][data-status="running"]')).toBeNull());
const click = async (el) => { await act(async () => { fireEvent.click(el); }); };

describe('a link in the assistant panel', () => {
  it('shows its host in an answer before anything is opened', async () => {
    const api = makeApi();
    const box = await mount(api);
    await act(async () => { fireEvent.change(box, { target: { value: 'What is this about?' } }); });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    await settled();
    expect(hostNextTo('View invoice')).toBe('(pay.example.net)');
    expect(api.calls('ui.openExternalUrl')).toEqual([]);
  });

  it('shows its host in a saved answer after the panel opens again', async () => {
    const api = makeApi();
    const at = Date.now();
    await api.storage.set('chat:reader', {
      id: 'c1', started: at, at,
      turns: [
        { id: 'q1', role: 'user', at, content: 'What is this about?', label: 'What is this about?', emailId: 'M1' },
        { id: 'a1', role: 'assistant', at, content: LABELLED, status: 'done', task: 'chat', show: 'chat', steps: [], replyTo: { id: 'M1', subject: 'Invoice 4471' } },
      ],
    });
    await mount(api);
    await waitFor(() => expect(screen.getByRole('button', { name: 'View invoice' })).toBeTruthy());
    expect(hostNextTo('View invoice')).toBe('(pay.example.net)');
  });

  it('shows its host in an earlier chat opened from the history', async () => {
    const api = makeApi();
    await archiveChat(api, [
      { id: 'q1', role: 'user', at: 1, content: 'Who sent the invoice?', label: 'Who sent the invoice?' },
      { id: 'a1', role: 'assistant', at: 1, content: LABELLED, status: 'done', task: 'chat', show: 'chat', steps: [] },
    ], { id: 'h1', at: Date.parse('2026-11-10T10:00:00Z') });
    await mount(api);
    await click(screen.getByRole('button', { name: 'Earlier chats' }));
    await click(screen.getByText('Who sent the invoice?').closest('button'));
    await waitFor(() => expect(document.querySelector('[data-read-only]')).toBeTruthy());
    expect(hostNextTo('View invoice')).toBe('(pay.example.net)');
  });
});
