// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { AssistantPanel } from '../src/ui/Panel.jsx';
import { SettingsPanel } from '../src/ui/SettingsPanel.jsx';
import { allStrings } from '../src/lib/i18n.js';

// The context area in the reader panel: a chip per attachment, the
// conversation, the messages ticked in the list, @ mentions, and what the
// privacy notice says about them.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const CONSENT = 'consent:v2:anthropic:http://localhost:18099';
const FEATURES = { attachmentText: true, attachmentImages: true, threads: true, listSelection: true };
const ATT = (blobId, name, type = 'application/pdf', extra = {}) => ({ blobId, name, type, size: 20480, inline: false, ...extra });
const EMAIL = {
  id: 'M1', threadId: 'T1', subject: 'Plan for Friday', receivedAt: '2026-10-30T09:00:00Z',
  from: [{ name: 'Carol', email: 'carol@example.org' }], text: 'See the agenda.',
  attachments: [ATT('b1', 'agenda.pdf'), ATT('b2', 'whiteboard.jpg', 'image/jpeg'), ATT('b3', 'spacer.gif', 'image/gif', { inline: true, size: 43, cid: 's@x' })],
};

function makeApi({ handlers = {}, hostFeatures = FEATURES, consent = true, config = CONFIG } = {}) {
  const api = fakeApi({
    translations: allStrings(),
    ...(hostFeatures ? { hostFeatures } : {}),
    handlers: {
      'admin.getAllConfig': async () => config,
      'email.getThreadCount': async () => 3,
      'proxy.fetch': async () => streamResponse(anthropicSse(['Done.'])),
      ...handlers,
    },
  });
  if (consent) void api.storage.set(CONSENT, true);
  return api;
}

const input = () => screen.getByRole('textbox', { name: 'Message to the assistant' });
const click = async (el) => { await act(async () => { fireEvent.click(el); }); };
const type = async (text) => { await act(async () => { fireEvent.change(input(), { target: { value: text } }); }); };
const key = async (k) => { await act(async () => { fireEvent.keyDown(input(), { key: k }); }); };
const chip = (name) => screen.getByRole('group', { name });
const sent = (api, n = -1) => JSON.parse(api.calls('proxy.fetch').at(n).args[2].body);
const settled = () => waitFor(() => expect(document.querySelector('[data-turn="assistant"][data-status="running"]')).toBeNull());
async function mount(api, props) {
  await act(async () => { render(React.createElement(AssistantPanel, { api, selection: { text: '' }, focusRequest: 0, ...props })); });
  await screen.findByRole('textbox', { name: 'Message to the assistant' });
}
async function ask(api, text) {
  await type(text);
  await key('Enter');
  await settled();
  return sent(api);
}

describe('attachments in the chat', () => {
  it('shows a chip per attachment, names it for screen readers, and lists it for the model', async () => {
    const api = makeApi();
    await mount(api, { email: EMAIL });
    expect(chip('Attachment agenda.pdf, 20 KB')).toBeTruthy();
    expect(chip('Picture whiteboard.jpg, 20 KB')).toBeTruthy();
    // A tracking pixel is no context.
    expect(screen.queryByRole('group', { name: /spacer\.gif/ })).toBeNull();
    const body = await ask(api, 'what is on the agenda?');
    expect(body.system).toContain('1. agenda.pdf (application/pdf, 20 KB)');
    expect(body.system).toContain('2. whiteboard.jpg');
    expect(body.system).not.toContain('spacer.gif');
    expect(body.tools.map((t) => t.name)).toContain('read_attachment');
  });

  it('leaves an attachment out once its chip is removed', async () => {
    const api = makeApi();
    await mount(api, { email: EMAIL });
    await click(screen.getByRole('button', { name: 'Leave agenda.pdf out' }));
    expect(screen.queryByRole('group', { name: /agenda\.pdf/ })).toBeNull();
    const body = await ask(api, 'and now?');
    expect(body.system).not.toContain('agenda.pdf');
    expect(body.system).toContain('2. whiteboard.jpg');
  });

  it('puts many attachments in one chip', async () => {
    const api = makeApi();
    const many = { ...EMAIL, attachments: ['a', 'b', 'c', 'd', 'e'].map((x) => ATT(x, `${x}.pdf`)) };
    await mount(api, { email: many });
    expect(chip('5 attachments: a.pdf, b.pdf, c.pdf, d.pdf, e.pdf')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Leave the attachments out' }));
    expect(screen.queryByRole('group', { name: /attachments/ })).toBeNull();
  });

  it('shows nothing of it on a webmail without the calls', async () => {
    const api = makeApi({ hostFeatures: null });
    await mount(api, { email: EMAIL });
    expect(screen.queryByRole('group', { name: /agenda\.pdf/ })).toBeNull();
    const body = await ask(api, 'hi');
    expect(body.tools.map((t) => t.name)).not.toContain('read_attachment');
    expect(api.calls('email.getThread')).toHaveLength(0);
  });

  it('shows nothing of it when the admin switched the area off', async () => {
    const api = makeApi({ config: { ...CONFIG, allowContext: false } });
    await mount(api, { email: EMAIL, listSelection: { emails: [{ id: 'A' }, { id: 'B' }], total: 2 } });
    expect(screen.queryByRole('group', { name: /agenda\.pdf/ })).toBeNull();
    expect(screen.queryByRole('group', { name: /selected messages/ })).toBeNull();
    expect(screen.queryByRole('group', { name: /This conversation/ })).toBeNull();
  });
});

describe('a message of a login this webmail can\'t read', () => {
  it('shows no attachment or conversation chips and offers no reads of it', async () => {
    const api = makeApi();
    await mount(api, { email: { ...EMAIL, blobsReadable: false } });
    // Past the moment the panel would count the conversation.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(screen.queryByRole('group', { name: /agenda\.pdf/ })).toBeNull();
    expect(screen.queryByRole('group', { name: /This conversation/ })).toBeNull();
    const body = await ask(api, 'what is attached?');
    expect(body.tools.map((t) => t.name)).not.toContain('read_attachment');
    expect(body.tools.map((t) => t.name)).not.toContain('read_thread');
    expect(body.system).not.toContain('agenda.pdf');
    expect(api.calls('email.getThreadCount')).toHaveLength(0);
  });
});

describe('the conversation', () => {
  it('shows "This conversation" with its size and offers read_thread', async () => {
    const api = makeApi();
    await mount(api, { email: EMAIL });
    await waitFor(() => expect(chip('This conversation, 3 messages')).toBeTruthy());
    // Only counted: no message of it is read until the model asks.
    expect(api.calls('email.getThread')).toHaveLength(0);
    const body = await ask(api, 'what was decided?');
    expect(body.system).toContain('part of a conversation of 3 messages');
    expect(body.tools.map((t) => t.name)).toContain('read_thread');
    await click(screen.getByRole('button', { name: 'Leave This conversation out' }));
    const after = await ask(api, 'and?');
    expect(after.tools.map((t) => t.name)).not.toContain('read_thread');
  });

  it('shows no chip for a message on its own', async () => {
    const api = makeApi({ handlers: { 'email.getThreadCount': async () => 1 } });
    await mount(api, { email: EMAIL });
    await waitFor(() => expect(api.calls('email.getThreadCount')).toHaveLength(1));
    expect(screen.queryByRole('group', { name: /This conversation/ })).toBeNull();
  });
});

describe('messages selected in the list', () => {
  const listSelection = { emails: [{ id: 'A', accountId: 'acc' }, { id: 'B' }, { id: 'C' }], total: 3 };

  it('becomes one chip and one context, with quick actions for it', async () => {
    const api = makeApi({ handlers: { 'email.get': async (id) => ({ id, subject: `S ${id}`, from: [{ email: `${id}@x.org` }], text: `Body ${id}` }) } });
    await mount(api, { email: null, listSelection });
    expect(chip('3 selected messages')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem', { name: 'What do I have to do?' })).toBeTruthy();
    // Actions are off by default, so no reply.
    expect(screen.queryByRole('menuitem', { name: 'One reply to all' })).toBeNull();
    await click(screen.getByRole('menuitem', { name: 'Summarize these' }));
    await settled();
    const body = sent(api);
    expect(body.system).toContain('The user selected 3 messages in the list');
    expect(body.tools.map((t) => t.name)).toContain('read_messages');
    expect(body.messages.at(-1).content).toMatch(/Summarise the messages I selected/);
  });

  it('offers one reply to all when actions are on', async () => {
    const api = makeApi();
    await api.storage.set('prefs', { actions: 'auto' });
    await mount(api, { email: null, listSelection });
    await click(screen.getByRole('button', { name: 'Actions' }));
    await click(screen.getByRole('menuitem', { name: 'One reply to all' }));
    await settled();
    const body = sent(api);
    expect(body.tools.map((t) => t.name)).toContain('draft_reply_to_senders');
    expect(body.messages.at(-1).content).toMatch(/draft_reply_to_senders/);
  });

  it('says when only the first fifty are read, and goes away when removed', async () => {
    const api = makeApi();
    const emails = Array.from({ length: 50 }, (_, i) => ({ id: `E${i}` }));
    await mount(api, { email: null, listSelection: { emails, total: 120 } });
    expect(chip('120 selected messages, the first 50 are read')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Leave 120 messages out' }));
    expect(screen.queryByRole('group', { name: /selected messages/ })).toBeNull();
  });

  it('needs two messages at least', async () => {
    const api = makeApi();
    await mount(api, { email: null, listSelection: { emails: [{ id: 'A' }], total: 1 } });
    expect(screen.queryByRole('group', { name: /selected messages/ })).toBeNull();
  });
});

describe('the @ menu', () => {
  const handlers = {
    'email.search': async () => [{ id: 'Q1', subject: 'Quarterly report', from: [{ name: 'Bob', email: 'bob@example.org' }], receivedAt: '2026-10-01T08:00:00Z' }],
    'contacts.search': async () => [{ id: 'c1', name: { full: 'Quinn Baker' }, emails: { e: { address: 'quinn@example.org' } } }],
  };

  it('finds contacts and messages, and picks one by keyboard', async () => {
    const api = makeApi({ handlers });
    await mount(api, { email: EMAIL });
    await type('Compare with @quar');
    const list = await screen.findByRole('listbox', { name: 'Mention a message or contact' });
    expect(input().getAttribute('aria-controls')).toBe(list.id);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Quinn Bakerquinn@example.org', 'Quarterly reportBob']);
    expect(input().getAttribute('aria-activedescendant')).toBe(options[0].id);
    await key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe(options[1].id);
    await key('Enter');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input().value).toBe('Compare with ');
    expect(chip('Message “Quarterly report” (Bob)')).toBeTruthy();
    const body = await ask(api, 'Compare with this');
    expect(body.system).toContain('The user mentioned these messages');
    expect(body.system).toContain('id Q1');
    expect(body.tools.map((t) => t.name)).toContain('read_messages');
  });

  it('closes with Escape and keeps what was typed', async () => {
    const api = makeApi({ handlers });
    await mount(api, { email: EMAIL });
    await type('@quinn');
    await screen.findByRole('listbox');
    await key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input().value).toBe('@quinn');
  });

  it('puts a mentioned contact in the prompt', async () => {
    const api = makeApi({ handlers });
    await mount(api, { email: EMAIL });
    await type('@quinn');
    await screen.findByRole('listbox');
    await key('Enter');
    expect(chip('Contact Quinn Baker (quinn@example.org)')).toBeTruthy();
    const body = await ask(api, 'write to them');
    expect(body.system).toContain('- Quinn Baker <quinn@example.org>');
  });
});

describe('what the notice says about it', () => {
  it('names attachments, pictures, conversations, the selection and mentions when they are on', async () => {
    const api = makeApi({ consent: false });
    await mount(api, { email: EMAIL });
    await type('hi');
    await key('Enter');
    const notice = (await screen.findByText(/sends your request to Anthropic/)).textContent;
    expect(notice).toContain('the names of its attachments and the descriptions of its pictures');
    expect(notice).toContain('Pictures it looks at go along as images.');
    // The photo's date and place only with its switch on.
    expect(notice).not.toContain('date and place');
    expect(notice).toContain('how many messages its conversation has');
    expect(notice).toContain('When you select messages in the list, it says how many');
    expect(notice).toContain('mention with @');
  });

  it('leaves pictures out when the model can\'t see them', async () => {
    const api = makeApi({ consent: false, config: { ...CONFIG, anthropicImages: 'no' } });
    await mount(api, { email: EMAIL });
    await type('hi');
    await key('Enter');
    const notice = (await screen.findByText(/sends your request to Anthropic/)).textContent;
    expect(notice).not.toContain('photo');
    expect(notice).toContain('the names of its attachments');
  });
});

describe('the settings', () => {
  async function show(config, hostFeatures = FEATURES) {
    const api = fakeApi({ translations: allStrings(), ...(hostFeatures ? { hostFeatures } : {}), handlers: { 'admin.getAllConfig': async () => config } });
    await act(async () => { render(React.createElement(SettingsPanel, { api })); });
    await screen.findByText('Let the assistant look things up');
    return api;
  }

  it('has a switch for attachments, images and the conversation, and saves them', async () => {
    const api = await show(CONFIG);
    for (const name of ['Read attachments', 'Look at images', 'Read the whole conversation']) {
      expect(screen.getByRole('switch', { name }).getAttribute('aria-checked')).toBe('true');
    }
    await click(screen.getByRole('switch', { name: 'Look at images' }));
    await waitFor(async () => expect((await api.storage.get('prefs'))?.ctxImages).toBe(false));
  });

  it('sends a photo\'s date and place only after the user switches it on', async () => {
    const api = await show(CONFIG);
    const photo = screen.getByRole('switch', { name: 'Send a photo\'s date and place' });
    expect(photo.getAttribute('aria-checked')).toBe('false');
    await click(photo);
    await waitFor(async () => expect((await api.storage.get('prefs'))?.ctxPhotoDetails).toBe(true));
  });

  it('says when the model can\'t see images', async () => {
    await show({ openaiBaseUrl: 'http://ollama:11434/v1' });
    expect(screen.queryByRole('switch', { name: 'Look at images' })).toBeNull();
    expect(screen.getByText('This model can\'t see images. The assistant only gets the file name.')).toBeTruthy();
  });

  it('is not there on a webmail without the calls', async () => {
    await show(CONFIG, null);
    expect(screen.queryByText('More context')).toBeNull();
  });
});
