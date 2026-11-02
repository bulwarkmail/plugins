// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { IDLE_MS, archiveChat, loadIndex } from '../src/lib/chat-history.js';
import { loadNotes, removeNote } from '../src/lib/chat-memory.js';
import { adminPrompts, matchCommands, slashName } from '../src/lib/chat-prompts.js';
import chatArea, { fillTemplate } from '../src/lib/areas/chat.js';
import { AssistantPanel } from '../src/ui/Panel.jsx';
import { SettingsPanel } from '../src/ui/SettingsPanel.jsx';

// Package E of the 2.2 work: history, saved prompts, slash commands, edit
// and regenerate, notes to remember, templates.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { cleanup(); vi.useRealTimers(); });

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const EMAIL = { id: 'M1', subject: 'Thursday', receivedAt: '2026-10-12T09:00:00Z', from: [{ name: 'Carol', email: 'carol@example.org' }], text: 'Can we meet?' };
const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const toolCall = (name, input) => ev('message_start', { type: 'message_start' })
  + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name } })
  + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  + ev('message_stop', { type: 'message_stop' });

function makeApi({ turns = [], prefs, config = {}, handlers = {} } = {}) {
  let i = 0;
  const api = fakeApi({
    translations: allStrings(),
    handlers: {
      'admin.getAllConfig': async () => ({ ...CONFIG, ...config }),
      'proxy.fetch': async () => streamResponse(i < turns.length ? turns[i++] : anthropicSse(['Done.'])),
      ...handlers,
    },
  });
  void api.storage.set('consent:v2:anthropic:http://localhost:18099', true);
  if (prefs) void api.storage.set('prefs', prefs);
  return api;
}
const sent = (api, n = -1) => JSON.parse(api.calls('proxy.fetch').at(n).args[2].body);
async function mount(api, props = { email: EMAIL, selection: { text: '' }, focusRequest: 0 }) {
  await act(async () => { render(React.createElement(AssistantPanel, { api, ...props })); });
  return screen.findByRole('textbox', { name: 'Message to the assistant' });
}
const type = async (box, text) => { await act(async () => { box.focus(); fireEvent.change(box, { target: { value: text, selectionStart: text.length } }); }); };
const key = async (el, k, extra = {}) => { await act(async () => { fireEvent.keyDown(el, { key: k, ...extra }); }); };
const settled = () => waitFor(() => expect(document.querySelector('[data-turn="assistant"][data-status="running"]')).toBeNull());
const click = async (el) => { await act(async () => { fireEvent.click(el); }); };
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

describe('the history', () => {
  const old = (at) => [
    { id: 'q1', role: 'user', at, content: 'Who is Jan?', label: 'Who is Jan?' },
    { id: 'a1', role: 'assistant', at, content: 'Your manager.', status: 'done', task: 'chat', show: 'chat', steps: [] },
  ];

  it('keeps a chat idle for 8 hours and opens with a fresh one', async () => {
    const api = makeApi();
    const at = Date.now() - IDLE_MS - 60_000;
    await api.storage.set('chat:reader', { id: 'c-old', started: at, turns: old(at), at });
    await mount(api);
    expect(document.querySelector('[data-turn="user"]')).toBeNull();
    expect((await loadIndex(api)).map((e) => e.title)).toEqual(['Who is Jan?']);
    expect((await api.storage.get('chat:reader')).turns).toEqual([]);
  });

  it('keeps a chat used less than 8 hours ago', async () => {
    const api = makeApi();
    const at = Date.now() - IDLE_MS + 60_000;
    await api.storage.set('chat:reader', { id: 'c1', started: at, turns: old(at), at });
    await mount(api);
    expect(screen.getByText('Who is Jan?')).toBeTruthy();
    expect(await loadIndex(api)).toEqual([]);
  });

  it('lists old chats, opens one to read and continues it, by keyboard', async () => {
    const api = makeApi();
    await archiveChat(api, old(1000), { id: 'h1', at: Date.parse('2026-10-30T10:00:00Z') });
    await archiveChat(api, [{ id: 'q2', role: 'user', at: 2, content: 'Lunch?', label: 'Lunch?' }], { id: 'h2', at: Date.parse('2026-10-31T10:00:00Z') });
    await mount(api);
    const button = screen.getByRole('button', { name: 'Earlier chats' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    const list = screen.getByRole('list', { name: 'Earlier chats' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toBe('Chats: 2');
    const search = screen.getByRole('searchbox', { name: 'Search chats' });
    await act(frame);
    expect(document.activeElement).toBe(search);
    // Down from the search field goes to the newest chat, then the next.
    await key(search, 'ArrowDown');
    expect(document.activeElement.textContent).toContain('Lunch?');
    await key(document.activeElement, 'ArrowDown');
    expect(document.activeElement.textContent).toContain('Who is Jan?');
    expect(document.activeElement.getAttribute('aria-describedby')).toBeTruthy();
    await click(document.activeElement);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Who is Jan?' })).toBeTruthy());
    expect(document.querySelector('[data-read-only]').textContent).toContain('Your manager.');
    expect(screen.queryByRole('button', { name: 'Answer again' })).toBeNull();
    // Escape goes back to the list, a second Escape back to the chat.
    await key(screen.getByRole('heading', { name: 'Who is Jan?' }), 'Escape');
    expect(screen.getByRole('list', { name: 'Earlier chats' })).toBeTruthy();
    await key(screen.getByRole('searchbox'), 'Escape');
    expect(screen.queryByRole('list', { name: 'Earlier chats' })).toBeNull();
    // Continue: the old chat becomes the running one and leaves the history.
    await click(button);
    await click(screen.getByText('Who is Jan?').closest('button'));
    await click(await screen.findByRole('button', { name: 'Continue this chat' }));
    await waitFor(() => expect(document.querySelector('[data-assistant-transcript]').textContent).toContain('Your manager.'));
    expect((await api.storage.get('chat:reader')).turns.map((t) => t.id)).toEqual(['q1', 'a1']);
    expect((await loadIndex(api)).map((e) => e.id)).toEqual(['h2']);
  });

  it('searches, renames and deletes', async () => {
    const api = makeApi({ handlers: { 'ui.confirm': async () => true } });
    await archiveChat(api, old(1), { id: 'h1', at: 1 });
    await archiveChat(api, [{ id: 'q2', role: 'user', at: 2, content: 'Lunch on Friday?', label: 'Lunch on Friday?' }, { id: 'a2', role: 'assistant', at: 2, content: 'At the Thai place.', status: 'done' }], { id: 'h2', at: 2 });
    await mount(api);
    await click(screen.getByRole('button', { name: 'Earlier chats' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'thai' } });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Matching chats: 1'));
    expect(screen.getByRole('listitem').textContent).toContain('Lunch on Friday?');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    await click(screen.getByRole('button', { name: 'Rename “Who is Jan?”' }));
    const name = screen.getByRole('textbox', { name: 'New name for “Who is Jan?”' });
    fireEvent.change(name, { target: { value: 'Team' } });
    await act(async () => { fireEvent.submit(name.closest('form')); });
    await waitFor(() => expect(screen.getByText('Team')).toBeTruthy());
    expect((await loadIndex(api)).find((e) => e.id === 'h1').title).toBe('Team');
    await click(screen.getByRole('button', { name: 'Delete “Team”' }));
    await waitFor(async () => expect((await loadIndex(api)).map((e) => e.id)).toEqual(['h2']));
    expect(api.calls('ui.confirm')[0].args[0]).toMatchObject({ title: 'Delete this chat?', danger: true });
    expect(await api.storage.get('history:h1')).toBeNull();
  });

  it('puts the chat into the history on New chat', async () => {
    const api = makeApi();
    const box = await mount(api);
    await type(box, 'hello there');
    await key(box, 'Enter');
    await settled();
    await click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(async () => expect((await loadIndex(api)).map((e) => e.title)).toEqual(['hello there']));
  });

  it('is not there when the administrator switched chat tools off', async () => {
    const api = makeApi({ config: { allowChatTools: false } });
    const box = await mount(api);
    expect(screen.queryByRole('button', { name: 'Earlier chats' })).toBeNull();
    await type(box, '/');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('is not in the composer, which keeps a chat per draft', async () => {
    const api = makeApi({ handlers: { 'composer.getBody': async () => ({ text: '' }) } });
    await mount(api, { composerId: 'c1', selection: { text: '' }, focusRequest: 0 });
    expect(screen.queryByRole('button', { name: 'Earlier chats' })).toBeNull();
  });
});

describe('slash commands and saved prompts', () => {
  it('match names by start, word and part', () => {
    const list = [{ label: 'Summarize' }, { label: 'To-dos and dates' }, { label: 'Reply ideas' }];
    expect(matchCommands(list, 'to').map((e) => e.label)).toEqual(['To-dos and dates']);
    expect(matchCommands(list, 'ideas').map((e) => e.label)).toEqual(['Reply ideas']);
    expect(matchCommands(list, 'mma').map((e) => e.label)).toEqual(['Summarize']);
    expect(slashName('To-dos and dates')).toBe('to-dos-and-dates');
  });

  it('read the administrator\'s prompts one per line', () => {
    expect(adminPrompts({ prompts: 'Weekly: What happened this week?\n\n# note\nNo colon here\n: no name' })).toEqual([
      { id: 'admin-1', name: 'Weekly', text: 'What happened this week?', admin: true },
      { id: 'admin-2', name: 'No colon here', text: 'No colon here', admin: true },
    ]);
  });

  it('open with / at the start, filter as the user types, move with arrows, complete with Tab and run with Enter', async () => {
    const api = makeApi({ prefs: { prompts: [{ id: 'p1', name: 'Polite no', text: 'Write a polite no to this.' }] } });
    const box = await mount(api);
    await type(box, '/');
    const list = await screen.findByRole('listbox', { name: 'Commands and saved prompts' });
    const names = within(list).getAllByRole('option').map((o) => o.textContent);
    expect(names[0]).toContain('Summarize');
    expect(names.some((n) => n.includes('Polite no'))).toBe(true);
    expect(box.getAttribute('aria-controls')).toBe(list.id);
    await type(box, '/to');
    await waitFor(() => expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['To-dos and dates/to-dos-and-dates']));
    expect(box.getAttribute('aria-activedescendant')).toBe(within(screen.getByRole('listbox')).getByRole('option').id);
    await key(box, 'Tab');
    expect(box.value).toBe('/to-dos-and-dates');
    expect(api.calls('proxy.fetch')).toHaveLength(0);
    // Escape closes the list and keeps the text.
    await key(box, 'Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box.value).toBe('/to-dos-and-dates');
    // A saved prompt by keyboard: down to it, Enter runs it with the open message.
    await type(box, '/pol');
    await screen.findByRole('listbox');
    await key(box, 'Enter');
    await settled();
    expect(box.value).toBe('');
    const body = sent(api);
    expect(body.messages.at(-1).content).toContain('Write a polite no to this.');
    expect(body.system).toContain('Can we meet?');
  });

  it('run a quick action from the list', async () => {
    const api = makeApi();
    const box = await mount(api);
    await type(box, '/sum');
    await screen.findByRole('listbox');
    await key(box, 'Enter');
    await settled();
    expect(sent(api).system).toMatch(/summar/i);
    expect(screen.getByText('Summarize')).toBeTruthy();
  });

  it('show saved prompts in the Actions menu, the administrator\'s too', async () => {
    const api = makeApi({ config: { prompts: 'Weekly: What happened this week?' }, prefs: { prompts: [{ id: 'p1', name: 'Polite no', text: 'Write a polite no.' }] } });
    await mount(api);
    await click(screen.getByRole('button', { name: /Actions/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Polite no' })).toBeTruthy();
    await click(within(menu).getByRole('menuitem', { name: 'Weekly' }));
    await settled();
    expect(sent(api).messages.at(-1).content).toContain('What happened this week?');
  });
});

describe('edit and regenerate', () => {
  it('edit puts the last question back, and sending replaces that exchange', async () => {
    const api = makeApi({ turns: [anthropicSse(['First answer.']), anthropicSse(['Second answer.'])] });
    const box = await mount(api);
    await type(box, 'lunch on tuesday?');
    await key(box, 'Enter');
    await settled();
    expect(screen.getByRole('button', { name: 'Answer again' })).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Edit this message' }));
    expect(box.value).toBe('lunch on tuesday?');
    expect(screen.getByText('Editing your last message')).toBeTruthy();
    await type(box, 'lunch on wednesday?');
    await key(box, 'Enter');
    await settled();
    const users = [...document.querySelectorAll('[data-turn="user"]')].map((el) => el.textContent);
    expect(users).toEqual(['lunch on wednesday?']);
    expect(screen.queryByText('First answer.')).toBeNull();
    expect(screen.getByText('Second answer.')).toBeTruthy();
    expect(JSON.stringify(sent(api).messages)).not.toContain('tuesday');
  });

  it('stopping an edit leaves the chat as it was', async () => {
    const api = makeApi();
    const box = await mount(api);
    await type(box, 'one');
    await key(box, 'Enter');
    await settled();
    await click(screen.getByRole('button', { name: 'Edit this message' }));
    await click(screen.getByRole('button', { name: 'Stop editing' }));
    expect(box.value).toBe('');
    await type(box, 'two');
    await key(box, 'Enter');
    await settled();
    expect([...document.querySelectorAll('[data-turn="user"]')].map((el) => el.textContent)).toEqual(['one', 'two']);
  });

  it('regenerate asks again for the last answer only', async () => {
    const api = makeApi({ turns: [anthropicSse(['One.']), anthropicSse(['Two.']), anthropicSse(['Three.'])] });
    const box = await mount(api);
    await type(box, 'first');
    await key(box, 'Enter');
    await settled();
    await type(box, 'second');
    await key(box, 'Enter');
    await settled();
    expect(screen.getAllByRole('button', { name: 'Answer again' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Edit this message' })).toHaveLength(1);
    await click(screen.getByRole('button', { name: 'Answer again' }));
    await settled();
    expect(screen.queryByText('Two.')).toBeNull();
    expect(screen.getByText('Three.')).toBeTruthy();
    expect([...document.querySelectorAll('[data-turn="user"]')].map((el) => el.textContent)).toEqual(['first', 'second']);
    expect(sent(api).messages.at(-1).content).toBe('second');
  });

  it('are not offered for a quick action\'s bubble, nor with chat tools off', async () => {
    const api = makeApi({ config: { allowChatTools: 'false' } });
    const box = await mount(api);
    await type(box, 'hi');
    await key(box, 'Enter');
    await settled();
    expect(screen.queryByRole('button', { name: 'Edit this message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Answer again' })).toBeNull();
  });
});

describe('notes to remember', () => {
  it('always ask first, then go with every request, and are gone after delete', async () => {
    const api = makeApi({ turns: [toolCall('remember', { note: 'My manager is Jan' }), anthropicSse(['Noted.'])], prefs: { actions: 'auto' } });
    const box = await mount(api);
    await type(box, 'remember that my manager is Jan');
    await key(box, 'Enter');
    const card = await waitFor(() => { const el = document.querySelector('[data-action="remember"]'); if (el?.dataset.actionState !== 'waiting') throw new Error('not waiting'); return el; });
    expect(card.textContent).toContain('Remember: “My manager is Jan”?');
    expect(await loadNotes(api)).toEqual([]);
    await click(screen.getByRole('button', { name: 'Do it' }));
    await settled();
    expect((await loadNotes(api)).map((n) => n.text)).toEqual(['My manager is Jan']);
    expect(sent(api, 0).tools.map((t) => t.name)).toContain('remember');

    await type(box, 'who is my manager?');
    await key(box, 'Enter');
    await settled();
    expect(sent(api).system).toContain('Notes the user asked you to remember');
    expect(sent(api).system).toContain('- My manager is Jan');

    // Deleted in the settings (another frame); this one reads them again when it gets the focus.
    const [note] = await loadNotes(api);
    await removeNote(api, note.id);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { await Promise.resolve(); });
    await type(box, 'and now?');
    await key(box, 'Enter');
    await settled();
    expect(sent(api).system).not.toContain('My manager is Jan');
  });

  it('undo takes the note back', async () => {
    const api = makeApi({ turns: [toolCall('remember', { note: 'Sign with Linus' })], prefs: { actions: 'auto' } });
    const box = await mount(api);
    await type(box, 'remember to sign with Linus');
    await key(box, 'Enter');
    await waitFor(() => screen.getByRole('button', { name: 'Do it' }));
    await click(screen.getByRole('button', { name: 'Do it' }));
    await settled();
    await click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await loadNotes(api)).toEqual([]));
  });

  it('are neither offered nor sent when the user or the administrator switched them off', async () => {
    for (const setup of [{ prefs: { actions: 'auto', memory: false } }, { prefs: { actions: 'auto' }, config: { allowMemory: false } }]) {
      const api = makeApi(setup);
      await api.storage.set('memory', { notes: [{ id: 'n1', text: 'My manager is Jan', at: 1 }] });
      const box = await mount(api);
      await type(box, 'hi');
      await key(box, 'Enter');
      await settled();
      expect(sent(api).tools.map((t) => t.name)).not.toContain('remember');
      expect(sent(api).system).not.toContain('My manager is Jan');
      cleanup();
    }
  });

  it('are named in the privacy notice', async () => {
    const api = makeApi({ prefs: { actions: 'manual' } });
    await api.storage.remove('consent:v2:anthropic:http://localhost:18099');
    const box = await mount(api);
    await type(box, 'hi');
    await key(box, 'Enter');
    await waitFor(() => expect(document.body.textContent).toContain('It also sends the notes you asked it to remember.'));
  });
});

describe('templates', () => {
  const action = (name) => chatArea.actions.find((a) => a.name === name);
  const TEMPLATES = [{ id: 't1', name: 'Thanks', category: '', subject: 'Thanks {{name}}', body: 'Dear {{name}},\nthank you for {{thing}}.', isHTML: false }];

  it('lists the user\'s templates for the model', async () => {
    const api = fakeApi({ handlers: { 'templates.list': async () => TEMPLATES } });
    const tool = chatArea.tools.find((x) => x.name === 'list_templates');
    expect(tool.available({ chatTemplates: true })).toBe(true);
    expect(tool.available({ chatTemplates: true, lookups: false })).toBe(false);
    const text = await tool.run(api);
    expect(text).toContain('id t1: "Thanks"');
    expect(text).toContain('{{name}} {{thing}}');
  });

  it('inserts one into the open draft, with the placeholders the model knows', async () => {
    const api = fakeApi({ translations: allStrings(), handlers: { 'templates.get': async () => TEMPLATES[0], 'composer.replaceSelection': async () => true } });
    const insert = action('insert_template');
    expect(insert.available({ chatTemplates: true })).toBe(false);
    const { summary, plan } = await insert.describe(api, { id: 't1', values: { name: 'Jan' } }, { chatComposerId: 'c1' });
    expect(summary).toBe('Put the template “Thanks” into your message?');
    const done = await insert.perform(api, plan);
    expect(api.calls('composer.replaceSelection')[0].args).toEqual(['c1', { text: 'Dear Jan,\nthank you for {{thing}}.' }]);
    expect(done.text).toContain('Still to fill in: {{thing}}');
    expect(fillTemplate('{{a}} {{b}}', { a: 'x' })).toBe('x {{b}}');
  });

  it('saves a written reply as a template, always asking first, and undo deletes it', async () => {
    const api = fakeApi({ translations: allStrings(), handlers: {
      'templates.list': async () => TEMPLATES,
      'templates.create': async (tpl) => ({ id: 't9', ...tpl }),
      'composer.getBody': async () => ({ text: 'Happy to help!\n\n-- \nLinus' }),
    } });
    const save = action('save_template');
    expect(save.alwaysAsk).toBe(true);
    await expect(save.describe(api, { name: 'thanks' }, { chatComposerId: 'c1' })).rejects.toThrow(/already a template/);
    const { summary, plan } = await save.describe(api, { name: 'Helping' }, { chatComposerId: 'c1' });
    expect(summary).toContain('“Helping”');
    expect(plan.template.body).toBe('Happy to help!');
    const done = await save.perform(api, plan);
    expect(api.calls('templates.create')[0].args[0]).toEqual({ name: 'Helping', subject: '', body: 'Happy to help!', isHTML: false });
    await save.undo(api, done.undo);
    expect(api.calls('templates.delete')[0].args).toEqual(['t9']);
  });
});

describe('the chat settings', () => {
  async function show(config = {}, seed = async () => {}) {
    const api = fakeApi({ translations: allStrings(), handlers: { 'admin.getAllConfig': async () => ({ ...CONFIG, ...config }) } });
    await seed(api);
    await act(async () => { render(React.createElement(SettingsPanel, { api })); });
    await screen.findByText('Saved prompts');
    return api;
  }

  it('add, change and delete saved prompts, and list the administrator\'s', async () => {
    const api = await show({ prompts: 'Weekly: What happened?' });
    expect(screen.getByText('From your administrator: Weekly')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Add a prompt' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Polite no' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'What to ask' }), { target: { value: 'Write a polite no.' } });
    await click(screen.getByRole('button', { name: 'Save prompt' }));
    await waitFor(async () => expect((await api.storage.get('prefs')).prompts).toEqual([{ id: expect.any(String), name: 'Polite no', text: 'Write a polite no.' }]));
    await click(await screen.findByRole('button', { name: 'Change “Polite no”' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'No thanks' } });
    await click(screen.getByRole('button', { name: 'Save prompt' }));
    await waitFor(async () => expect((await api.storage.get('prefs')).prompts[0].name).toBe('No thanks'));
    await click(await screen.findByRole('button', { name: 'Delete “No thanks”' }));
    await waitFor(async () => expect((await api.storage.get('prefs')).prompts).toEqual([]));
  });

  it('show the notes to change and delete, with the switch', async () => {
    const api = await show({}, (a) => a.storage.set('memory', { notes: [{ id: 'n1', text: 'My manager is Jan', at: 1 }, { id: 'n2', text: 'Sign with Linus', at: 2 }] }));
    const list = await screen.findByRole('list', { name: 'Notes' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['My manager is Jan', 'Sign with Linus']);
    await click(screen.getByRole('button', { name: 'Change the note “My manager is Jan”' }));
    const box = screen.getByRole('textbox', { name: 'Note' });
    fireEvent.change(box, { target: { value: 'Sign with Linus' } });
    await click(within(list).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'My manager is Jana' } });
    await click(within(list).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await loadNotes(api)).map((n) => n.text)).toEqual(['My manager is Jana', 'Sign with Linus']));
    await click(screen.getByRole('button', { name: 'Delete the note “Sign with Linus”' }));
    await waitFor(async () => expect((await loadNotes(api)).map((n) => n.id)).toEqual(['n1']));
    await click(screen.getByRole('switch', { name: 'Remember notes' }));
    await waitFor(async () => expect((await api.storage.get('prefs')).memory).toBe(false));
  });

  it('hide the notes when the administrator doesn\'t allow them', async () => {
    await show({ allowMemory: false });
    expect(screen.queryByRole('switch', { name: 'Remember notes' })).toBeNull();
  });
});
