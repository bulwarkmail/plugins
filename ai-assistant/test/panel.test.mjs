// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { AssistantPanel, sourceFor, taskForAction } from '../src/ui/Panel.jsx';
import { undoHint } from '../src/ui/panel/Turns.jsx';
import { chatKey, pendingKey, COMPOSER_CONTEXT_KEY } from '../src/lib/background.js';
import { allStrings } from '../src/lib/i18n.js';

// The chat panel next to the composer and next to an open message.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const CONSENT = 'consent:v2:anthropic:http://localhost:18099';
const EMAIL = { id: 'M1', subject: 'Thursday', receivedAt: '2026-10-12T09:00:00Z', from: [{ name: 'Carol', email: 'carol@example.org' }], text: 'Can we meet on Thursday at 3?' };

/** A model that answers each request in turn; the last answer repeats. */
function makeApi({ answers = ['Answer.'], body = 'Hello Bob, can we meet tuesday? Thanks', consent = true, handlers = {}, timeZone } = {}) {
  let i = 0;
  const api = fakeApi({
    translations: allStrings(),
    ...(timeZone ? { timeZone } : {}),
    handlers: {
      'admin.getAllConfig': async () => CONFIG,
      'composer.getBody': async () => ({ html: `<p>${body}</p>`, text: body }),
      'composer.replaceSelection': async () => true,
      'composer.replaceBody': async () => true,
      'compose.reply': async () => true,
      'proxy.fetch': async () => streamResponse(anthropicSse(answers[Math.min(i++, answers.length - 1)].match(/.{1,8}/gs))),
      ...handlers,
    },
  });
  if (consent) void api.storage.set(CONSENT, true);
  return api;
}

const sentPrompt = (api, n = -1) => JSON.parse(api.calls('proxy.fetch').at(n).args[2].body);
const button = (name) => screen.getByRole('button', { name });
/** A quick action: open the Actions menu, pick the entry. */
const quickAction = async (name) => { await click(button('Actions')); await click(screen.getByRole('menuitem', { name })); };
const click = async (el) => { await act(async () => { fireEvent.click(el); }); };
const type = async (text) => {
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'Message to the assistant' }), { target: { value: text } }); });
};
const pressEnter = async () => {
  await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message to the assistant' }), { key: 'Enter' }); });
};
async function mount(api, props) {
  let view;
  await act(async () => { view = render(React.createElement(AssistantPanel, { api, ...props })); });
  await screen.findByRole('textbox', { name: 'Message to the assistant' });
  return view;
}
const settled = () => waitFor(() => expect(document.querySelector('[data-turn="assistant"][data-status="running"]')).toBeNull());

describe('what the panel works on', () => {
  it('is the selection, else the message, else nothing', () => {
    expect(sourceFor('composer', { selection: { text: 'part', empty: false }, body: 'whole' })).toEqual({ scope: 'selection', text: 'part' });
    expect(sourceFor('composer', { selection: { text: '', empty: true }, body: 'whole' })).toEqual({ scope: 'body', text: 'whole' });
    expect(sourceFor('composer', { selection: null, body: '  ' })).toEqual({ scope: 'empty', text: '' });
    expect(sourceFor('reader', { selection: { text: 'clause' }, email: EMAIL })).toEqual({ scope: 'passage', text: 'clause' });
    expect(sourceFor('reader', { selection: null, email: EMAIL })).toEqual({ scope: 'message', text: EMAIL.text });
  });

  it('maps quick actions to the tasks and how their answer is shown', () => {
    expect(taskForAction('composer', 'shorter', { scope: 'selection', text: 'x' })).toMatchObject({ task: 'rewrite', input: { style: 'shorter' }, show: 'proposal' });
    expect(taskForAction('composer', 'grammar', { scope: 'body', text: 'x' })).toMatchObject({ task: 'grammar', show: 'grammar' });
    expect(taskForAction('reader', 'summary', { scope: 'message', text: 'x' }, { email: EMAIL })).toMatchObject({ task: 'summary', show: 'text' });
    expect(taskForAction('reader', 'explain', { scope: 'passage', text: 'clause' }, { email: EMAIL })).toMatchObject({ task: 'explain', input: { text: 'clause' }, show: 'text' });
    expect(taskForAction('reader', 'replies', { scope: 'message', text: 'x' }, { email: EMAIL })).toMatchObject({ show: 'replies' });
  });
});

describe('the composer panel', () => {
  it('rewrites the selected text on a quick action, shows the change marked, and replaces the selection', async () => {
    const api = makeApi({ answers: ['could we meet on Tuesday?'] });
    await mount(api, { composerId: 'composer-7', selection: { text: 'can we meet tuesday?', empty: false }, focusRequest: 0 });
    expect(screen.getByText('Selected text')).toBeTruthy();
    expect(screen.getByText('can we meet tuesday?')).toBeTruthy();

    await quickAction('Shorten');
    await settled();
    // Only the selection went to the model, with the quick action's own prompt.
    expect(sentPrompt(api).messages[0].content).toBe('<draft>\ncan we meet tuesday?\n</draft>');
    expect(sentPrompt(api).tools).toBeUndefined();
    expect(screen.getByText('Shorten · selected text')).toBeTruthy();
    expect(document.querySelector('del').textContent).toContain('can');
    expect(document.querySelector('ins').textContent).toContain('could');

    await click(button('Replace'));
    await waitFor(() => expect(screen.getByText('Replaced')).toBeTruthy());
    expect(api.calls('composer.replaceSelection').map((c) => c.args)).toEqual([['composer-7', { text: 'could we meet on Tuesday?' }]]);
    expect(screen.getByText('Ctrl+Z takes it back')).toBeTruthy();
    // The transcript is kept for the composer.
    await waitFor(async () => expect((await api.storage.get(chatKey('composer', 'composer-7')))?.turns).toHaveLength(2));
  });

  it('answers a typed request as a chat, with the message in the system prompt and the tools offered, and inserts a tagged proposal', async () => {
    const api = makeApi({ answers: ['Here it is:\n<text>\nHello Bob, can we meet on Tuesday? I am away on Friday.\n</text>'] });
    await api.storage.set(COMPOSER_CONTEXT_KEY, { mode: 'reply', inReplyToId: 'M9', originalSubject: 'Lunch', at: Date.now() });
    await mount(api, { composerId: 'c1', selection: { text: '', empty: true }, focusRequest: 0 });
    expect(screen.getByText('Your message')).toBeTruthy();

    await type('add that I am away on Friday');
    await pressEnter();
    await settled();
    const prompt = sentPrompt(api);
    expect(prompt.system).toContain('<draft>\nHello Bob, can we meet tuesday? Thanks\n</draft>');
    expect(prompt.system).toContain('writing a reply to "Lunch"');
    expect(prompt.system).toContain('<text></text>');
    expect(prompt.tools.map((t) => t.name)).toEqual(['read_original_message', 'check_calendar', 'find_contact', 'search_mail', 'read_message', 'read_my_settings', 'find_setting', 'list_templates']);
    expect(prompt.messages.at(-1)).toEqual({ role: 'user', content: 'add that I am away on Friday' });
    expect(screen.getByText('Here it is:')).toBeTruthy();
    expect([...document.querySelectorAll('ins')].map((x) => x.textContent).join(' ')).toContain('away on Friday');

    await click(button('Replace message'));
    await waitFor(() => expect(api.calls('composer.replaceBody')).toHaveLength(1));
    expect(api.calls('composer.replaceBody')[0].args).toEqual(['c1', { text: 'Hello Bob, can we meet on Tuesday? I am away on Friday.' }]);
  });

  it('writes an empty message from a description and sends the earlier turns along', async () => {
    const api = makeApi({ body: '', answers: ['<text>Dear Anna,\nthank you for the offer.</text>', '<text>Dear Anna,\nthanks a lot for the offer!</text>'] });
    await mount(api, { composerId: 'c1', selection: { text: '', empty: true }, focusRequest: 0 });
    // Nothing to work on yet: no chip, a placeholder that asks for a description.
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to the assistant' }).getAttribute('placeholder')).toBe('Describe what the email should say…'));
    expect(screen.queryByText('Empty message')).toBeNull();
    expect(document.querySelector('[data-context-chip]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Shorten' })).toBeNull();

    await click(screen.getByRole('button', { name: 'Thank Anna for the offer and propose a call on Tuesday at 10' }));
    await pressEnter();
    await settled();
    expect(sentPrompt(api).system).toContain('The message is still empty');
    expect(screen.getByText(/thank you for the offer/)).toBeTruthy();
    await click(button('Insert'));
    await waitFor(() => expect(api.calls('composer.replaceBody')[0].args).toEqual(['c1', { text: 'Dear Anna,\nthank you for the offer.' }]));

    await type('warmer');
    await pressEnter();
    await settled();
    const messages = sentPrompt(api).messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1].content).toContain('<text>');
  });

  it('runs a request handed over from the right-click menu on the text it carries', async () => {
    const api = makeApi({ answers: ['Could we meet on Tuesday?'] });
    await api.storage.set(pendingKey('composer', 'c1'), { action: 'improve', text: 'can we meet tuesday?', at: Date.now() });
    await mount(api, { composerId: 'c1', selection: { text: 'can we meet tuesday?', empty: false }, focusRequest: 1 });
    await settled();
    expect(screen.getByText('Improve · selected text')).toBeTruthy();
    expect(sentPrompt(api).messages[0].content).toBe('<draft>\ncan we meet tuesday?\n</draft>');
    expect(await api.storage.get(pendingKey('composer', 'c1'))).toBeNull();
  });

  it('goes through spelling fixes one by one', async () => {
    const api = makeApi({ body: 'Teh cat sat on teh mat', answers: ['The cat sat on the mat'] });
    await mount(api, { composerId: 'c1', selection: { text: '', empty: true }, focusRequest: 0 });
    await quickAction('Fix spelling');
    await settled();
    expect(screen.getByText('2 of 2 suggestions left')).toBeTruthy();
    await click(screen.getAllByRole('button', { name: /Accept/ })[0]);
    expect(screen.getByText('1 of 2 suggestions left')).toBeTruthy();
    await click(button('Replace'));
    await waitFor(() => expect(api.calls('composer.replaceBody')[0].args).toEqual(['c1', { text: 'The cat sat on teh mat' }]));
  });

  it('retries a failed quick action with the same request', async () => {
    let n = 0;
    const api = makeApi({ handlers: { 'proxy.fetch': async () => (n++ === 0
      ? { status: 429, ok: false, headers: { 'retry-after': '1' }, body: '' }
      : streamResponse(anthropicSse(['shorter.']))) } });
    await mount(api, { composerId: 'c1', selection: { text: 'can we meet tuesday?', empty: false }, focusRequest: 0 });
    await quickAction('Shorten');
    await settled();
    expect(await screen.findByRole('alert')).toBeTruthy();
    await waitFor(() => expect(button('Try again').disabled).toBe(false), { timeout: 3000 });
    await click(button('Try again'));
    await settled();
    const sent = sentPrompt(api);
    expect(sent.system).toContain('noticeably shorter');
    expect(sent.messages[0].content).toBe('<draft>\ncan we meet tuesday?\n</draft>');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelectorAll('[data-turn="user"]')).toHaveLength(1);
  });

  it('asks for the privacy notice before the first request and does nothing when declined', async () => {
    const api = makeApi({ consent: false });
    await mount(api, { composerId: 'c1', selection: { text: 'x', empty: false }, focusRequest: 0 });
    await quickAction('Improve');
    expect(await screen.findByText('Send text to the AI service?')).toBeTruthy();
    await click(button('Cancel'));
    expect(api.calls('proxy.fetch')).toHaveLength(0);
    expect(document.querySelectorAll('[data-turn]')).toHaveLength(0);
  });

  it('says so when no service is set up', async () => {
    const api = makeApi({ handlers: { 'admin.getAllConfig': async () => ({}) } });
    await act(async () => { render(React.createElement(AssistantPanel, { api, composerId: 'c1', selection: { text: '', empty: true } })); });
    expect(await screen.findByText('The assistant is not set up yet.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('actions in the reader panel', () => {
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  /** A model turn that calls the given tools. */
  const toolTurn = (...calls) => ev('message_start', { type: 'message_start' })
    + calls.map(({ id, name, input }, i) => ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id, name } })
      + ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
      + ev('content_block_stop', { type: 'content_block_stop', index: i })).join('')
    + ev('message_stop', { type: 'message_stop' });
  const MESSAGE = { ...EMAIL, mailboxIds: ['inbox-id'], isRead: true, isFlagged: false };

  /** A model that archives the open message, then says so. */
  function actingApi(actions, extra = {}) {
    let n = 0;
    const api = makeApi({ handlers: {
      'proxy.fetch': async () => streamResponse(n++ === 0
        ? toolTurn({ id: 'tu1', name: 'archive_message', input: { id: 'M1' } })
        : anthropicSse(['Archived.'])),
      'email.get': async () => MESSAGE,
      ...extra,
    } });
    void api.storage.set('prefs', { actions });
    return api;
  }
  const ask = async () => {
    await type('archive this');
    await pressEnter();
  };

  it('asks first: the card waits for Do it, then the message is archived', async () => {
    const api = actingApi('manual');
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await ask();
    const card = await waitFor(() => {
      const el = document.querySelector('[data-action="archive_message"][data-action-state="waiting"]');
      expect(el).toBeTruthy();
      return el;
    });
    expect(card.textContent).toContain('Archive “Thursday”');
    expect(api.calls('email.archive')).toHaveLength(0);
    // The prompt told the model about actions and the open message's id.
    const first = sentPrompt(api, 0);
    expect(first.tools.map((t) => t.name)).toContain('archive_message');
    expect(first.system).toContain('confirms each action');
    expect(first.system).toContain('The open email has the id M1');
    await click(button('Do it'));
    await settled();
    expect(api.calls('email.archive').map((c) => c.args)).toEqual([[['M1']]]);
    expect(document.querySelector('[data-action="archive_message"]').dataset.actionState).toBe('done');
    expect(screen.getByText('Archived.')).toBeTruthy();
  });

  it('asks first: Skip leaves the message alone and tells the model', async () => {
    const api = actingApi('manual');
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await ask();
    await waitFor(() => expect(document.querySelector('[data-action-state="waiting"]')).toBeTruthy());
    await click(button('Skip'));
    await settled();
    expect(api.calls('email.archive')).toHaveLength(0);
    expect(document.querySelector('[data-action="archive_message"]').dataset.actionState).toBe('skipped');
    expect(JSON.stringify(sentPrompt(api).messages.at(-1))).toContain('did not allow');
  });

  it('acts at once in automatic mode, with Undo', async () => {
    const api = actingApi('auto');
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await ask();
    await settled();
    expect(api.calls('email.archive')).toHaveLength(1);
    const card = document.querySelector('[data-action="archive_message"]');
    expect(card.dataset.actionState).toBe('done');
    expect(sentPrompt(api, 0).system).toContain('Actions run at once');
    await click(button('Undo'));
    await waitFor(() => expect(document.querySelector('[data-action="archive_message"]').dataset.actionState).toBe('undone'));
    expect(api.calls('email.move').map((c) => c.args)).toEqual([[['M1'], 'inbox-id']]);
  });

  it('stops for the OK after a few automatic actions in one answer', async () => {
    let n = 0;
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `tu${i}`, name: 'mark_message', input: { id: 'M1', read: true } }));
    const api = makeApi({ handlers: {
      'proxy.fetch': async () => streamResponse(n++ === 0 ? toolTurn(...many) : anthropicSse(['Done.'])),
      'email.get': async () => MESSAGE,
    } });
    void api.storage.set('prefs', { actions: 'auto' });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await ask();
    await waitFor(() => expect(document.querySelector('[data-action-state="waiting"]')).toBeTruthy());
    expect(api.calls('email.setKeyword')).toHaveLength(5);
    await click(button('Skip'));
    await settled();
    expect(api.calls('email.setKeyword')).toHaveLength(5);
  });

  it('offers no actions while they are off, or when the administrator does not allow them', async () => {
    for (const [prefs, config] of [[{}, CONFIG], [{ actions: 'auto' }, { ...CONFIG, actions: 'off' }]]) {
      const api = makeApi({ answers: ['Fine.'], handlers: { 'admin.getAllConfig': async () => config } });
      void api.storage.set('prefs', prefs);
      await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
      await type('archive this');
      await pressEnter();
      await settled();
      const prompt = sentPrompt(api);
      expect((prompt.tools ?? []).map((t) => t.name)).not.toContain('archive_message');
      expect(prompt.system).not.toContain('action tools');
      cleanup();
    }
  });

  it('shows an action that waited when the panel closed as not done', async () => {
    const api = makeApi();
    await api.storage.set('chat:reader', { turns: [
      { id: 'u1', role: 'user', content: 'archive', label: 'archive', emailId: 'M1' },
      { id: 'a1', role: 'assistant', content: '', status: 'running', show: 'chat', steps: [{ id: 'tu1', name: 'archive_message', status: 'running', action: { summary: 'Archive “Thursday”', state: 'waiting' } }] },
    ] });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await waitFor(() => expect(document.querySelector('[data-action="archive_message"]').dataset.actionState).toBe('skipped'));
    expect(screen.queryByRole('button', { name: 'Do it' })).toBeNull();
  });
});

describe('the input box', () => {
  it('shows focus on the box, not as a second frame around the text field', async () => {
    const api = makeApi();
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    const field = screen.getByRole('textbox', { name: 'Message to the assistant' });
    const box = document.querySelector('[data-assistant-input]');
    // The kit's focus outline is !important; only an inline !important beats it.
    expect(field.style.getPropertyValue('outline')).toBe('none');
    expect(field.style.getPropertyPriority('outline')).toBe('important');
    field.blur();
    await act(async () => { fireEvent.blur(field); });
    expect(box.hasAttribute('data-focused')).toBe(false);
    await act(async () => { fireEvent.focus(field); });
    expect(box.hasAttribute('data-focused')).toBe(true);
    expect(box.getAttribute('style')).toContain('border: 1px solid var(--color-ring)');
  });

  it('puts the cursor in the text field on a click on the box, but not on its buttons', async () => {
    const api = makeApi();
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    const field = screen.getByRole('textbox', { name: 'Message to the assistant' });
    const box = document.querySelector('[data-assistant-input]');
    field.blur();
    await act(async () => { fireEvent.mouseDown(box); });
    expect(document.activeElement).toBe(field);
    field.blur();
    await act(async () => { fireEvent.mouseDown(button('Actions')); });
    expect(document.activeElement).not.toBe(field);
  });

  it('keeps Send off until there is text', async () => {
    const api = makeApi();
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    expect(button('Send').disabled).toBe(true);
    await type('  ');
    expect(button('Send').disabled).toBe(true);
    await type('when?');
    expect(button('Send').disabled).toBe(false);
  });
});

describe('taking context out', () => {
  const OTHER = { id: 'M2', subject: 'Invoice 42', receivedAt: '2026-10-13T09:00:00Z', from: [{ name: 'Dan', email: 'dan@example.org' }], text: 'Please pay invoice 42.' };
  const removeButton = () => screen.getByRole('button', { name: 'Remove from context' });

  it('shows the x while the pointer is over the chip', async () => {
    const api = makeApi();
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    const chip = document.querySelector('[data-context-chip=""]');
    expect(removeButton().style.opacity).toBe('0');
    await act(async () => { fireEvent.mouseEnter(chip); });
    expect(removeButton().style.opacity).toBe('1');
    await act(async () => { fireEvent.mouseLeave(chip); });
    expect(removeButton().style.opacity).toBe('0');
  });

  it('leaves the message out of the next question until the user adds it back', async () => {
    const api = makeApi({ answers: ['Sure.'] });
    const view = await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await click(removeButton());
    expect(screen.queryByText('This message')).toBeNull();
    // Actions stays, with ways to start instead of the message's actions.
    expect(screen.getByRole('button', { name: 'Actions' })).toBeTruthy();
    await type('write a haiku about autumn');
    await pressEnter();
    await settled();
    const system = sentPrompt(api).system;
    expect(system).not.toContain('Can we meet on Thursday');
    expect(system).toContain('(not available)');
    // Brought back by hand...
    await click(screen.getByRole('button', { name: 'Add “Thursday”' }));
    expect(screen.getByText('This message')).toBeTruthy();
    // ...or by opening another message.
    await click(removeButton());
    await act(async () => { view.rerender(React.createElement(AssistantPanel, { api, email: OTHER, selection: { text: '' }, focusRequest: 0 })); });
    expect(screen.getByText('This message')).toBeTruthy();
    expect(screen.getByText('Invoice 42')).toBeTruthy();
  });

  it('falls back from a highlighted passage to the whole message', async () => {
    const api = makeApi();
    await mount(api, { email: EMAIL, selection: { text: 'Thursday at 3' }, focusRequest: 0 });
    expect(screen.getByText('Highlighted passage')).toBeTruthy();
    await click(removeButton());
    expect(screen.queryByText('Highlighted passage')).toBeNull();
    expect(screen.getByText('This message')).toBeTruthy();
  });

  it('in the composer, falls back from the selection to the draft, which stays', async () => {
    const api = makeApi();
    await mount(api, { composerId: 'c1', selection: { text: 'tuesday', empty: false } });
    expect(screen.getByText('Selected text')).toBeTruthy();
    await click(removeButton());
    await waitFor(() => expect(screen.getByText('Your message')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Remove from context' })).toBeNull();
  });
});

describe('what the assistant knows about the app', () => {
  it('tells the model the app, its version, the account and server, and where things are', async () => {
    const api = makeApi({ answers: ['This is Rath Mail.'], handlers: {
      'app.getInfo': async () => ({ product: 'Bulwark Mail', name: 'Rath Mail', version: '1.17.1', edition: 'full', stalwartFeatures: true, demoMode: false }),
      'user.getAccounts': async () => [{ email: 'linus@rath.li', serverUrl: 'https://mail.rath.li', isActive: true }],
    } });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('What webmail is this?');
    await pressEnter();
    await settled();
    const system = sentPrompt(api).system;
    expect(system).toContain('a plugin inside Rath Mail, which runs Bulwark Mail 1.17.1');
    expect(system).toContain('signed in as linus@rath.li on the mail server mail.rath.li');
    expect(system).toContain('Out of Office (automatic replies)');
    expect(system).toContain('to the right of the open message');
  });
});

describe('the reader panel across messages', () => {
  const OTHER = { id: 'M2', subject: 'Invoice 42', receivedAt: '2026-10-13T09:00:00Z', from: [{ name: 'Dan', email: 'dan@example.org' }], text: 'Please pay invoice 42.' };

  it('keeps one conversation while the user opens other messages, and marks the switch', async () => {
    const api = makeApi({ answers: ['On Thursday at 3.', 'By Friday.'] });
    const view = await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('when?');
    await pressEnter();
    await settled();
    expect(screen.getByText('On Thursday at 3.')).toBeTruthy();

    await act(async () => { view.rerender(React.createElement(AssistantPanel, { api, email: OTHER, selection: { text: '' }, focusRequest: 0 })); });
    // The transcript stays, and the chip names the new message.
    expect(screen.getByText('On Thursday at 3.')).toBeTruthy();
    expect(screen.getByText('Invoice 42')).toBeTruthy();
    expect(document.querySelector('[data-turn="context"]')).toBeNull();

    await type('until when?');
    await pressEnter();
    await settled();
    // A line names the message the new question is about, and the model hears of the switch.
    expect(document.querySelector('[data-turn="context"]').textContent).toContain('Now about: Invoice 42');
    const sent = sentPrompt(api).messages;
    expect(sent.at(-1).content).toContain('Now about another message: "Invoice 42" from Dan');
    expect(sent.some((msg) => msg.content === 'On Thursday at 3.')).toBe(true);
    await waitFor(async () => expect((await api.storage.get('chat:reader'))?.turns.filter((turn) => turn.role === 'context')).toHaveLength(1));
  });

  it('says in the transcript when the message leaves the conversation, and names it on the chip that brings it back', async () => {
    const api = makeApi({ answers: ['On Thursday.', 'Sure.', 'Again.', 'Back.'] });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('when?');
    await pressEnter();
    await settled();
    await click(screen.getByRole('button', { name: 'Remove from context' }));
    // The chip names the message it brings back.
    expect(screen.getByRole('button', { name: 'Add “Thursday”' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add this message' })).toBeNull();
    await type('write a haiku');
    await pressEnter();
    await settled();
    const markers = () => [...document.querySelectorAll('[data-turn="context"]')].map((el) => el.textContent);
    expect(markers()).toEqual(['No longer about: Thursday']);
    expect(sentPrompt(api).messages.at(-1).content).toContain('took the message out');
    // Only once.
    await type('another');
    await pressEnter();
    await settled();
    expect(markers()).toEqual(['No longer about: Thursday']);
    // Back to the message: the switch is marked again.
    await click(screen.getByRole('button', { name: 'Add “Thursday”' }));
    await type('and now?');
    await pressEnter();
    await settled();
    expect(markers()).toEqual(['No longer about: Thursday', 'Now about: Thursday']);
  });

  it('works with no message open: chat yes, actions to start with', async () => {
    const api = makeApi();
    await mount(api, { email: null, selection: null, focusRequest: 0 });
    expect(screen.queryByText('No message open')).toBeNull();
    expect(document.querySelector('[data-context-chip]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Actions' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message to the assistant' }).getAttribute('placeholder')).toBe('Ask anything, or search your mail…');
  });

  it('leaves the focus alone when another message opens, and takes it when asked', async () => {
    const api = makeApi();
    const view = await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    const input = screen.getByRole('textbox', { name: 'Message to the assistant' });
    input.blur();
    await act(async () => { view.rerender(React.createElement(AssistantPanel, { api, email: OTHER, selection: { text: '' }, focusRequest: 0 })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(document.activeElement).not.toBe(input);
    await act(async () => { view.rerender(React.createElement(AssistantPanel, { api, email: OTHER, selection: { text: '' }, focusRequest: 1 })); });
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});

describe('the reader panel', () => {
  it('summarises the open message and lets the user ask about it', async () => {
    const api = makeApi({ answers: ['- Carol asks for a meeting on Thursday at 3', 'Yes, at 3 pm.'] });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    expect(screen.getByText('This message')).toBeTruthy();
    // The chip names the message by its subject, not by the start of its body.
    expect(screen.getByText('Thursday')).toBeTruthy();
    expect(screen.queryByText(/Can we meet on Thursday/)).toBeNull();
    await quickAction('Summarize');
    await settled();
    expect(sentPrompt(api).messages[0].content).toContain('Subject: Thursday');
    // The answer stands on its own: no Copy link under it (the text can be selected).
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    // Markdown: the bullet becomes a list item.
    expect(screen.getByRole('listitem').textContent).toBe('Carol asks for a meeting on Thursday at 3');

    await type('is there a time?');
    await pressEnter();
    await settled();
    expect(sentPrompt(api).system).toContain('<email>');
    expect(sentPrompt(api).system).toContain('Can we meet on Thursday at 3?');
    expect(screen.getByText('Yes, at 3 pm.')).toBeTruthy();
  });

  it('works on a highlighted passage: explains it, and opens a drafted reply', async () => {
    const api = makeApi({ answers: ['It means Thursday afternoon.', '<text>Hi Carol, Thursday at 3 works for me.</text>'] });
    await mount(api, { email: EMAIL, selection: { text: 'Thursday at 3' }, focusRequest: 0 });
    expect(screen.getByText('Highlighted passage')).toBeTruthy();
    await quickAction('Explain');
    await settled();
    expect(sentPrompt(api).messages[0].content).toContain('<passage>\nThursday at 3\n</passage>');
    expect(screen.getByText('It means Thursday afternoon.')).toBeTruthy();

    await quickAction('Draft a reply');
    await settled();
    expect(sentPrompt(api).messages.at(-1).content).toContain('answers the passage I highlighted');
    await click(button('Open as reply'));
    await waitFor(() => expect(api.calls('compose.reply').map((c) => c.args)).toEqual([['M1', { text: 'Hi Carol, Thursday at 3 works for me.' }]]));
    expect(screen.getByText('Reply opened')).toBeTruthy();
  });

  it('with no message open, opens a draft as a new message to the recipients the model named', async () => {
    const api = makeApi({
      answers: ['Here is a draft.\n<text to="info@it-media-hof.de" subject="Kurzes Gespräch">Hallo Jannis,\nhast du Zeit?</text>'],
      handlers: { 'compose.open': async () => 'opened' },
    });
    await mount(api, { email: null, selection: null, focusRequest: 0 });
    await type('Schreib Jannis eine Mail');
    await pressEnter();
    await settled();
    expect(screen.queryByRole('button', { name: 'Open as reply' })).toBeNull();
    expect(screen.getByText('To: info@it-media-hof.de')).toBeTruthy();
    expect(screen.getByText('Subject: Kurzes Gespräch')).toBeTruthy();
    await click(button('Open as new message'));
    await waitFor(() => expect(api.calls('compose.open').map((c) => c.args)).toEqual([[{ to: ['info@it-media-hof.de'], subject: 'Kurzes Gespräch', body: 'Hallo Jannis,\nhast du Zeit?' }]]));
    expect(api.calls('compose.reply')).toEqual([]);
    expect(screen.getByText('New message opened')).toBeTruthy();
    expect(screen.queryByText(/couldn't change your message/)).toBeNull();
  });

  it('with no message open, offers a time for a new email, not a reply', async () => {
    const api = makeApi({ answers: ['Free then:\n<widget>{"type":"times","items":[{"start":"2026-10-30T15:00:00","end":"2026-10-30T16:00:00"}]}</widget>'] });
    await mount(api, { email: null, selection: null, focusRequest: 0 });
    await type('when am I free?');
    await pressEnter();
    await settled();
    expect(screen.queryByRole('button', { name: 'Reply with this time' })).toBeNull();
    await click(button('Propose this time'));
    await settled();
    expect(sentPrompt(api).messages.at(-1).content).toMatch(/^Draft an email proposing .+\.$/);
  });

  it('opens a drafted reply to the message it was written for, after another one was opened', async () => {
    const OTHER = { id: 'M2', subject: 'Invoice 42', receivedAt: '2026-10-13T09:00:00Z', from: [{ name: 'Dan', email: 'dan@example.org' }], text: 'Please pay invoice 42.' };
    const api = makeApi({ answers: ['<text>Hi Carol, Thursday works.</text>'], handlers: { 'ui.openEmail': async () => true } });
    const view = await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('draft a reply');
    await pressEnter();
    await settled();
    await act(async () => { view.rerender(React.createElement(AssistantPanel, { api, email: OTHER, selection: { text: '' }, focusRequest: 0 })); });
    await click(button('Open as reply'));
    // The host replies only to the open message: the panel opens M1 first.
    await waitFor(() => expect(api.calls('compose.reply').map((c) => c.args)).toEqual([['M1', { text: 'Hi Carol, Thursday works.' }]]));
    expect(api.calls('ui.openEmail').map((c) => c.args[0])).toEqual(['M1']);
  });

  it('shows the model\'s lookups as steps', async () => {
    const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const toolTurn = ev('message_start', { type: 'message_start' })
      + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'check_calendar' } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"from":"2026-10-15","to":"2026-10-15"}' } })
      + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
      + ev('message_stop', { type: 'message_stop' });
    let n = 0;
    const api = makeApi({ handlers: {
      'proxy.fetch': async () => streamResponse(n++ === 0 ? toolTurn : anthropicSse(['You are free then.'])),
      'calendar.getEvents': async () => [],
    } });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('am I free?');
    await pressEnter();
    await settled();
    // The lookups fold into one line; the details open on request.
    const group = document.querySelector('[data-steps]');
    expect(group.textContent).toContain('Looked up');
    expect(group.textContent).toContain('Calendar');
    expect(group.textContent).not.toContain('Checked your calendar');
    expect(document.querySelector('[data-step="check_calendar"]')).toBeNull();
    await click(document.querySelector('[data-steps] button'));
    const step = document.querySelector('[data-step="check_calendar"]');
    expect(step.dataset.stepStatus).toBe('done');
    expect(document.querySelector('[data-widget="calendar"]')).toBeTruthy();
    expect(screen.getByText('You are free then.')).toBeTruthy();
    expect(api.calls('calendar.getEvents')[0].args).toEqual([{ from: '2026-10-15', to: '2026-10-16' }]);
  });

  it('tells the model who the user is and their standing instructions, the user\'s last', async () => {
    const api = makeApi({ answers: ['Done.'], handlers: {
      'admin.getAllConfig': async () => ({ ...CONFIG, instructions: 'Write in British English.' }),
      'user.getIdentities': async () => [{ id: 'i1', name: 'Anna Example', email: 'anna@example.org', textSignature: 'Kind regards,\nAnna' }],
      'user.getAccounts': async () => [{ id: 'a1', email: 'anna@example.org', displayName: 'Anna', isActive: true }],
      'user.getTimeZone': async () => 'Europe/Zurich',
    } });
    await api.storage.set('prefs', { instructions: 'Keep it short.' });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('ok?');
    await pressEnter();
    await settled();
    const system = sentPrompt(api).system;
    expect(system).toContain('Name: Anna Example');
    expect(system).toContain('Email addresses: anna@example.org');
    expect(system).toContain('Signs emails with:\nKind regards,\nAnna');
    expect(system).toContain('Time zone: Europe/Zurich');
    expect(system).toMatch(/Now it is \w+day, \d{4}-\d{2}-\d{2}, \d\d:\d\d in the user's time zone/);
    expect(system).toContain('Standing instructions from the administrator:\nWrite in British English.');
    expect(system).toContain('Standing instructions from the user (these win over the administrator\'s):\nKeep it short.');
    expect(system.indexOf('administrator')).toBeLessThan(system.indexOf('Keep it short.'));
    // The quick actions get the same context.
    await quickAction('Summarize');
    await settled();
    expect(sentPrompt(api).system).toContain('Keep it short.');
  });

  it('gives the model the user\'s own date at 00:30 in Berlin, not the UTC date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T23:30:00Z'));
    try {
      const api = makeApi({ answers: ['Done.'], timeZone: 'Europe/Berlin', handlers: { 'user.getTimeZone': async () => 'Europe/Berlin' } });
      await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
      await type('Was habe ich morgen?');
      await pressEnter();
      await settled();
      const system = sentPrompt(api).system;
      expect(system).toContain('Now it is Saturday, 2026-10-31, 00:30');
      expect(system).toContain('Tomorrow is Sunday, 2026-11-01');
      expect(system).not.toMatch(/Today is 2026-10-30/);
      // The quick action for to-dos gets the same date.
      await quickAction('To-dos and dates');
      await settled();
      expect(sentPrompt(api).system).toContain('Now it is Saturday, 2026-10-31, 00:30');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the model the user\'s own date at 23:30 in Los Angeles', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T06:30:00Z'));
    try {
      const api = makeApi({ answers: ['Done.'], timeZone: 'America/Los_Angeles', handlers: { 'user.getTimeZone': async () => 'America/Los_Angeles' } });
      await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
      await type('What do I have tomorrow?');
      await pressEnter();
      await settled();
      const system = sentPrompt(api).system;
      expect(system).toContain('Now it is Saturday, 2026-10-31, 23:30');
      expect(system).toContain('Tomorrow is Sunday, 2026-11-01');
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws the widgets the model adds and sends a chip as the next request', async () => {
    const api = makeApi({ answers: [
      'Two options:\n<widget>{"type":"choices","items":["Yes, Thursday works","Propose Friday"]}</widget>\n<widget>{"type":"times","items":[{"start":"2026-10-15T15:00","end":"2026-10-15T16:00"}]}</widget>',
      'Sure.',
    ] });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('when?');
    await pressEnter();
    await settled();
    expect(document.querySelector('[data-widget="choices"]')).toBeTruthy();
    expect(document.querySelector('[data-widget="times"]')).toBeTruthy();
    expect(screen.queryByText(/<widget>/)).toBeNull();
    await click(button('Yes, Thursday works'));
    await settled();
    expect(sentPrompt(api).messages.at(-1)).toEqual({ role: 'user', content: 'Yes, Thursday works' });
    expect(screen.getAllByText('Yes, Thursday works').length).toBeGreaterThan(0);
  });

  it('shows what a lookup found as a card, and the mail search as messages to summarise', async () => {
    const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const toolTurn = ev('message_start', { type: 'message_start' })
      + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'search_mail' } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"invoice"}' } })
      + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
      + ev('message_stop', { type: 'message_stop' });
    let n = 0;
    const api = makeApi({ handlers: {
      'proxy.fetch': async () => streamResponse(n++ === 0 ? toolTurn : anthropicSse(['Found one.'])),
      'email.search': async () => [{ id: 'M7', subject: 'Invoice 42', from: [{ name: 'Carol', email: 'carol@example.org' }], receivedAt: '2026-10-12T09:00:00Z' }],
    } });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('find the invoice');
    await pressEnter();
    await settled();
    expect(document.querySelector('[data-steps]').textContent).toContain('Mail');
    await click(document.querySelector('[data-steps] button'));
    expect(document.querySelector('[data-step="search_mail"]').textContent).toContain('Searched your mail for “invoice”');
    expect(document.querySelector('[data-widget="emails"]').textContent).toContain('Invoice 42');
    await click(button('Summarize this message'));
    await settled();
    expect(sentPrompt(api).messages.at(-1).content).toBe('Read the message "Invoice 42" (id M7) and summarise it.');
  });

  it('offers no lookups when the user turned them off, only where a setting is', async () => {
    const api = makeApi({ answers: ['Fine.'] });
    await api.storage.set('prefs', { lookups: false });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('ok?');
    await pressEnter();
    await settled();
    expect(sentPrompt(api).tools.map((t) => t.name)).toEqual(['find_setting']);
  });
});

describe('quick action names', () => {
  const userBubble = () => [...document.querySelectorAll('[data-turn="user"]')].at(-1)?.textContent;

  it('name only the action when it works on the whole message or draft', async () => {
    const reader = makeApi({ answers: ['- a point'] });
    await mount(reader, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await quickAction('Summarize');
    await settled();
    expect(userBubble()).toBe('Summarize');
    cleanup();

    const composer = makeApi({ answers: ['Hello Bob, can we meet on Tuesday?'] });
    await mount(composer, { composerId: 'c1', selection: { text: '', empty: true }, focusRequest: 0 });
    await quickAction('Improve');
    await settled();
    expect(userBubble()).toBe('Improve');
  });

  it('keep the scope when it works on part of the text', async () => {
    const api = makeApi({ answers: ['It means Thursday afternoon.'] });
    await mount(api, { email: EMAIL, selection: { text: 'Thursday at 3' }, focusRequest: 0 });
    await quickAction('Explain');
    await settled();
    expect(userBubble()).toBe('Explain · highlighted text');
  });

  it('ask for the language when Translate… comes from the right-click menu', async () => {
    const api = makeApi({ answers: ['Donnerstag um 3'] });
    await api.storage.set(pendingKey('reader', 'M1'), { action: 'translate', text: 'Thursday at 3', at: Date.now() });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 1 });
    const picker = await screen.findByRole('combobox', { name: 'Translate into' });
    expect(document.activeElement).toBe(picker);
    // Nothing goes out before the language is chosen.
    expect(api.calls('proxy.fetch')).toHaveLength(0);
    await act(async () => { fireEvent.change(picker, { target: { value: 'de' } }); });
    await settled();
    expect(userBubble()).toBe('Translate to German · highlighted text');
    expect(JSON.stringify(sentPrompt(api).messages)).toContain('Thursday at 3');
    expect(screen.queryByRole('combobox', { name: 'Translate into' })).toBeNull();
  });
});

describe('words for every platform and lookup', () => {
  it('names the undo key of a Mac on a Mac', () => {
    const t = (key) => allStrings().de[key];
    expect(undoHint(t, 'Win32')).toBe('Strg+Z macht es rückgängig');
    expect(undoHint(t, 'MacIntel')).toBe('⌘Z macht es rückgängig');
    expect(undoHint((key) => allStrings().ja[key], 'macOS')).toBe('⌘Zで元に戻せます');
  });

  it('never shows the code name of a lookup it has no words for', async () => {
    const api = makeApi();
    // A saved answer with a lookup this version has no words for.
    await api.storage.set('chat:reader', { turns: [
      { id: 'u1', role: 'user', content: 'what is in the file?', label: 'what is in the file?', emailId: 'M1' },
      { id: 'a1', role: 'assistant', content: 'A list.', status: 'done', task: 'chat', show: 'chat', steps: [{ id: 's1', name: 'read_punch_card', args: { name: 'list.txt' }, status: 'done', result: 'milk, eggs' }] },
    ] });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    const box = await waitFor(() => { const el = document.querySelector('[data-steps]'); if (!el) throw new Error('no steps'); return el; });
    expect(box.textContent).not.toContain('read_punch_card');
    expect(box.textContent).toContain('Other');
    await click(within(box).getByRole('button'));
    expect(box.textContent).toContain('Looked something up');
  });
});

describe('the saved chat', () => {
  it('keeps only the start of a long message with each reader turn', async () => {
    const long = { ...EMAIL, text: 'x'.repeat(9000) };
    const api = makeApi({ answers: ['- point'] });
    await mount(api, { email: long, selection: { text: '' }, focusRequest: 0 });
    await quickAction('Summarize');
    await settled();
    // The model got all of it...
    expect(sentPrompt(api).messages[0].content.length).toBeGreaterThan(9000);
    // ...the storage keeps 2,000 characters.
    await waitFor(async () => expect((await api.storage.get('chat:reader'))?.turns).toHaveLength(2));
    const saved = (await api.storage.get('chat:reader')).turns[1];
    expect(saved.source.length).toBe(2000);
    expect(JSON.stringify(saved).length).toBeLessThan(5000);
  });

  it('says once when the storage is full', async () => {
    const api = makeApi({ answers: ['One.', 'Two.'] });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    api.storage.set = async () => { throw new Error('Plugin storage is full (1024 KB per account)'); };
    await type('first');
    await pressEnter();
    await settled();
    await waitFor(() => expect(api.calls('toast.error')).toHaveLength(1));
    expect(api.calls('toast.error')[0].args[0]).toBe("The assistant's storage is full. Start a new chat to free space.");
    await type('second');
    await pressEnter();
    await settled();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.calls('toast.error')).toHaveLength(1);
  });
});

describe('a failed action', () => {
  it('says why in the user\'s words, and keeps the model\'s text for the model', async () => {
    const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const call = ev('message_start', { type: 'message_start' })
      + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'archive_message' } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":"M1"}' } })
      + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
      + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
      + ev('message_stop', { type: 'message_stop' });
    let n = 0;
    const api = makeApi({ handlers: {
      'proxy.fetch': async () => streamResponse(n++ === 0 ? [call] : anthropicSse(['It is gone.'])),
      'email.get': async () => EMAIL,
      'email.archive': async () => { throw new Error('email.archive: The tool failed: notFound'); },
    } });
    await api.storage.set('prefs', { actions: 'auto' });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('archive it');
    await pressEnter();
    await settled();
    const card = document.querySelector('[data-action="archive_message"]');
    expect(card.dataset.actionState).toBe('failed');
    expect(card.textContent).toContain("The message isn't there any more.");
    expect(card.textContent).not.toContain('notFound');
    // The model still hears what went wrong.
    expect(JSON.stringify(sentPrompt(api).messages)).toContain('notFound');
  });
});

describe('Escape', () => {
  const escape = async (el) => { await act(async () => { fireEvent.keyDown(el, { key: 'Escape' }); }); };

  it('closes the reader panel from an empty input, like the composer one', async () => {
    const api = makeApi({ handlers: { 'ui.closePanel': async () => true } });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    const box = screen.getByRole('textbox', { name: 'Message to the assistant' });
    await type('half a question');
    await escape(box);
    expect(api.calls('ui.closePanel')).toHaveLength(0);
    await type('');
    await escape(box);
    expect(api.calls('ui.closePanel').map((c) => c.args)).toEqual([['email-detail-sidebar']]);
  });

  it('keeps a dialog around the chat open while there is text, and lets it close without', async () => {
    const api = makeApi({ handlers: { 'ui.closePanel': async () => true } });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    const box = screen.getByRole('textbox', { name: 'Message to the assistant' });
    await type('half a question');
    let notPrevented;
    await act(async () => { notPrevented = fireEvent.keyDown(box, { key: 'Escape' }); });
    expect(notPrevented).toBe(false);
    await type('');
    await act(async () => { notPrevented = fireEvent.keyDown(box, { key: 'Escape' }); });
    expect(notPrevented).toBe(true);
  });

  it('closes the language picker and goes back to the input', async () => {
    const api = makeApi();
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await quickAction('Translate');
    const picker = screen.getByRole('combobox', { name: 'Translate into' });
    await escape(picker);
    expect(screen.queryByRole('combobox', { name: 'Translate into' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message to the assistant' }));
  });
});

describe('the privacy notice', () => {
  it('waits for the answer without saying the assistant is thinking', async () => {
    const api = makeApi({ consent: false, answers: ['Hello.'] });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('hi');
    await pressEnter();
    await screen.findByRole('button', { name: 'Continue' });
    expect(screen.queryByText('Thinking…')).toBeNull();
    expect(api.calls('proxy.fetch')).toHaveLength(0);
    await click(button('Continue'));
    await settled();
    expect(screen.getByText('Hello.')).toBeTruthy();
  });
});

describe('what the notice says is sent', () => {
  it('names what goes with every request, and lookups and actions only when they are on', async () => {
    const api = makeApi({ consent: false, answers: ['Hello.'] });
    await api.storage.set('prefs', { lookups: false, actions: 'off' });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('hi');
    await pressEnter();
    const notice = (await screen.findByText(/sends your request to Anthropic/)).textContent;
    expect(notice).toContain('your name, addresses and signature');
    expect(notice).toContain('the names of the app and your mail server');
    expect(notice).toContain('the earlier messages of this chat');
    expect(notice).not.toContain('calendar events');
    expect(notice).not.toContain('folders');
    expect(notice.endsWith('Nothing is sent until you ask.')).toBe(true);
    cleanup();

    const on = makeApi({ consent: false });
    await on.storage.set('prefs', { lookups: true, actions: 'manual' });
    await mount(on, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('hi');
    await pressEnter();
    const full = (await screen.findByText(/sends your request to Anthropic/)).textContent;
    expect(full).toContain('messages from a mail search, calendar events, contacts and your settings');
    expect(full).toContain('the names of your folders');
  });

  it('asks again once after the update, since it now names more', async () => {
    const api = makeApi({ consent: false, answers: ['Hello.'] });
    await api.storage.set('consent:anthropic:http://localhost:18099', true);
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await type('hi');
    await pressEnter();
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('does not promise lookups in the empty panel when they are off', async () => {
    const api = makeApi();
    await api.storage.set('prefs', { lookups: false });
    await mount(api, { email: null, selection: null, focusRequest: 0 });
    expect(screen.getByText('Open a message to work on it, or ask anything.')).toBeTruthy();
  });
});

describe('the header', () => {
  it('is as high as the side panel headers of the app, with or without a conversation', async () => {
    const api = makeApi({ answers: ['Sure.'] });
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    const header = document.querySelector('[data-assistant-header]');
    expect(header.style.height).toBe('56px');
    // The border comes on top, as under the app's h-14 rows.
    expect(header.style.boxSizing).toBe('content-box');
    expect(screen.getByRole('heading', { name: 'AI assistant' })).toBeTruthy();
    // New chat keeps its place while hidden, so the title doesn't move when it appears.
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
    const slot = header.lastElementChild;
    expect(slot.style.visibility).toBe('hidden');
    await type('hello');
    await pressEnter();
    await settled();
    expect(document.querySelector('[data-assistant-header]').style.height).toBe('56px');
    expect(slot.style.visibility).toBe('visible');
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
  });
});

describe('the Actions menu with nothing to work on', () => {
  const entries = async () => {
    await click(button('Actions'));
    const names = screen.getAllByRole('menuitem').map((el) => el.textContent);
    return names;
  };

  it('offers ways to start in the reader with no message open', async () => {
    const api = makeApi({ answers: ['Nothing today.'] });
    await mount(api, { email: null, selection: null, focusRequest: 0 });
    // Catch me up (the everywhere area) joins them after a line.
    expect(await entries()).toEqual(["What's on my calendar today?", 'Find a message', 'Catch me up']);
    await click(screen.getByRole('menuitem', { name: "What's on my calendar today?" }));
    await settled();
    expect(sentPrompt(api).messages.at(-1).content).toBe("What's on my calendar today?");
  });

  it('starts a search in the input, and leaves out the calendar when lookups are off', async () => {
    const api = makeApi();
    await api.storage.set('prefs', { lookups: false });
    await mount(api, { email: null, selection: null, focusRequest: 0 });
    // Catch me up reads mail, the calendar and tasks: not with lookups off.
    expect(await entries()).toEqual(['Find a message']);
    await click(screen.getByRole('menuitem', { name: 'Find a message' }));
    const box = screen.getByRole('textbox', { name: 'Message to the assistant' });
    expect(box.value).toBe('Find the message about ');
    expect(document.activeElement).toBe(box);
    expect(api.calls('proxy.fetch')).toHaveLength(0);
  });

  it('stays when the user takes the message out of the context', async () => {
    const api = makeApi();
    await mount(api, { email: EMAIL, selection: { text: '' }, focusRequest: 0 });
    await click(button('Remove from context'));
    expect(await entries()).toEqual(["What's on my calendar today?", 'Find a message']);
  });

  it('offers the examples for an empty draft', async () => {
    const api = makeApi({ body: '' });
    await mount(api, { composerId: 'c1', selection: { text: '', empty: true }, focusRequest: 0 });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to the assistant' }).getAttribute('placeholder')).toBe('Describe what the email should say…'));
    expect(await entries()).toEqual([
      'Thank Anna for the offer and propose a call on Tuesday at 10',
      'Decline the invitation politely and suggest next month instead',
      'Ask for a corrected invoice: the VAT number is missing',
    ]);
    await click(screen.getByRole('menuitem', { name: 'Ask for a corrected invoice: the VAT number is missing' }));
    expect(screen.getByRole('textbox', { name: 'Message to the assistant' }).value).toBe('Ask for a corrected invoice: the VAT number is missing');
  });
});
