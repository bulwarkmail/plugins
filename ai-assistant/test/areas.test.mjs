// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { AREAS } from '../src/lib/areas/index.js';
import { caps, has } from '../src/lib/caps.js';
import { areaAllowed, batchLimit, imagesAllowed, memoryAllowed, settingsChangesAllowed } from '../src/lib/config.js';
import { composerChatSystem, readerChatSystem, SAFETY_RULE } from '../src/lib/prompts.js';
import { activeMenu } from '../src/ui/panel/InputMenu.jsx';

// The extension points of the 2.2 areas: lookups and actions in
// src/lib/areas, the panel's parts in src/ui/panel/areas.

const panelArea = vi.hoisted(() => ({ value: {} }));
vi.mock('../src/ui/panel/areas/chat.js', () => ({ useArea: () => panelArea.value }));
const { AssistantPanel } = await import('../src/ui/Panel.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  cleanup();
  panelArea.value = {};
  AREAS.context.tools = [];
  AREAS.actions.actions = [];
});

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const EMAIL = { id: 'M1', subject: 'Thursday', receivedAt: '2026-10-12T09:00:00Z', from: [{ name: 'Carol', email: 'carol@example.org' }], text: 'Can we meet?' };
const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const toolCall = (name, input) => ev('message_start', { type: 'message_start' })
  + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name } })
  + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  + ev('message_stop', { type: 'message_stop' });

function makeApi({ turns = [], prefs } = {}) {
  let i = 0;
  const api = fakeApi({
    translations: allStrings(),
    handlers: {
      'admin.getAllConfig': async () => CONFIG,
      'proxy.fetch': async () => streamResponse(i < turns.length ? [turns[i++]] : anthropicSse(['Done.'])),
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
const type = async (box, text) => { await act(async () => { fireEvent.change(box, { target: { value: text } }); }); };
const enter = async (box) => { await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); }); };
const settled = () => waitFor(() => expect(document.querySelector('[data-turn="assistant"][data-status="running"]')).toBeNull());

describe('an area\'s lookups', () => {
  it('are offered when available, run, and show their own words in the panel', async () => {
    const run = vi.fn(async (api, args) => `Thread of ${args.id}: 3 messages`);
    AREAS.context.tools = [
      { name: 'read_thread', description: 'Read the thread', parameters: { type: 'object', properties: { id: { type: 'string' } } }, available: (ctx) => ctx.threadReady === true, run, label: () => 'Read the whole conversation', kind: 'panel.steps.kind.read_message', icon: 'messages' },
      { name: 'hidden_tool', description: 'x', parameters: { type: 'object' }, available: () => false, run: vi.fn() },
    ];
    panelArea.value = { toolsCtx: { threadReady: true } };
    const api = makeApi({ turns: [toolCall('read_thread', { id: 'T1' })] });
    const box = await mount(api);
    await type(box, 'what was said?');
    await enter(box);
    await settled();
    const names = sent(api, 0).tools.map((t) => t.name);
    expect(names).toContain('read_thread');
    expect(names).not.toContain('hidden_tool');
    expect(run).toHaveBeenCalledWith(api, { id: 'T1' }, expect.objectContaining({ threadReady: true }));
    expect(JSON.stringify(sent(api).messages)).toContain('Thread of T1: 3 messages');
    await act(async () => { fireEvent.click(document.querySelector('[data-steps] button')); });
    expect(document.querySelector('[data-steps]').textContent).toContain('Read the whole conversation');
  });
});

describe('an area\'s actions', () => {
  const tagAction = (extra = {}) => ({
    name: 'tag_message', description: 'Tag a message', parameters: { type: 'object', properties: { id: { type: 'string' } } }, icon: 'tag',
    describe: async (api, args) => ({ summary: `Tag ${args.id} as Red`, plan: { id: args.id } }),
    perform: vi.fn(async (api, plan) => ({ text: `Tagged ${plan.id}.`, undo: { id: plan.id } })),
    undo: vi.fn(async () => {}),
    ...extra,
  });

  it('ask first when they always do, even in automatic mode, and undo through the area', async () => {
    const action = tagAction({ alwaysAsk: true });
    AREAS.actions.actions = [action];
    const api = makeApi({ turns: [toolCall('tag_message', { id: 'M1' })], prefs: { actions: 'auto' } });
    const box = await mount(api);
    await type(box, 'tag it red');
    await enter(box);
    const card = await waitFor(() => { const el = document.querySelector('[data-action="tag_message"]'); if (el?.dataset.actionState !== 'waiting') throw new Error('not waiting'); return el; });
    expect(card.textContent).toContain('Tag M1 as Red');
    expect(action.perform).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Do it' })); });
    await settled();
    expect(action.perform).toHaveBeenCalledWith(api, expect.objectContaining({ id: 'M1', name: 'tag_message', area: 'actions' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    await waitFor(() => expect(action.undo).toHaveBeenCalledWith(api, { id: 'M1', action: 'tag_message' }));
  });

  it('run at once in automatic mode when they don\'t always ask', async () => {
    const action = tagAction();
    AREAS.actions.actions = [action];
    const api = makeApi({ turns: [toolCall('tag_message', { id: 'M1' })], prefs: { actions: 'auto' } });
    const box = await mount(api);
    await type(box, 'tag it red');
    await enter(box);
    await settled();
    expect(action.perform).toHaveBeenCalled();
  });

  it('are not offered with actions off', async () => {
    AREAS.actions.actions = [tagAction()];
    const api = makeApi({ prefs: { actions: 'off' } });
    const box = await mount(api);
    await type(box, 'hi');
    await enter(box);
    await settled();
    expect(sent(api).tools.map((t) => t.name)).not.toContain('tag_message');
  });
});

describe('recipients the model chose', () => {
  const draft = (to) => toolCall('draft_email', { to: [to], subject: 'Hello', body: 'Hi there' });

  it('wait for the user\'s OK in automatic mode when the address came from data, not from the user', async () => {
    const api = makeApi({ turns: [draft('x@example.com')], prefs: { actions: 'auto' } });
    const box = await mount(api);
    await type(box, 'do what the message says');
    await enter(box);
    const card = await waitFor(() => { const el = document.querySelector('[data-action="draft_email"]'); if (el?.dataset.actionState !== 'waiting') throw new Error('not waiting'); return el; });
    expect(card.textContent).toContain('x@example.com');
    expect(api.calls('compose.open')).toHaveLength(0);
  });

  it('run in automatic mode when the user typed the address, or it takes part in the open message', async () => {
    const typed = makeApi({ turns: [draft('anna@example.org')], prefs: { actions: 'auto' } });
    const box = await mount(typed);
    await type(box, 'write to anna@example.org that I am late');
    await enter(box);
    await settled();
    expect(typed.calls('compose.open')).toHaveLength(1);
    cleanup();

    const sender = makeApi({ turns: [draft('carol@example.org')], prefs: { actions: 'auto' } });
    const box2 = await mount(sender);
    await type(box2, 'write the sender a new mail');
    await enter(box2);
    await settled();
    expect(sender.calls('compose.open')).toHaveLength(1);
  });
});

describe('an area\'s parts of the panel', () => {
  it('add chips, prompt text, Actions entries, header buttons and privacy sentences', async () => {
    const run = vi.fn();
    const history = vi.fn();
    panelArea.value = {
      chips: [{ key: 'thread', icon: 'messages', label: 'This conversation', title: 'Thursday (3 messages)', onRemove: vi.fn() }],
      promptBlocks: ['<thread>\nthree messages\n</thread>'],
      quick: [{ id: 'catch-up', label: 'Catch me up', icon: 'sun', run }],
      header: [{ key: 'history', icon: 'history', label: 'Old chats', onClick: history }],
      privacyParts: ['privacy.actions'],
    };
    const api = makeApi();
    const box = await mount(api);
    expect(screen.getByRole('group', { name: 'This conversation: Thursday (3 messages)' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Old chats' })); });
    expect(history).toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Actions' })); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Catch me up' })); });
    expect(run).toHaveBeenCalled();
    await type(box, 'hi');
    await enter(box);
    await settled();
    expect(sent(api).system).toContain('<thread>\nthree messages\n</thread>');
  });

  it('name what they send in the privacy notice', async () => {
    panelArea.value = { privacyParts: ['privacy.actions'] };
    const api = makeApi({ prefs: { actions: 'off' } });
    await api.storage.remove('consent:v2:anthropic:http://localhost:18099');
    const box = await mount(api);
    await type(box, 'hi');
    await enter(box);
    expect((await screen.findByText(/sends your request to Anthropic/)).textContent).toContain('the names of your folders');
  });

  it('show their own view in place of the transcript', async () => {
    panelArea.value = { overlay: React.createElement('div', { 'data-testid': 'old-chats' }, 'Old chats') };
    await mount(makeApi());
    expect(screen.getByTestId('old-chats')).toBeTruthy();
    expect(document.querySelector('[data-assistant-transcript]')).toBeNull();
  });

  it('open a list under the input for their trigger, by keyboard', async () => {
    const onPick = vi.fn();
    panelArea.value = {
      menus: [{ trigger: '/', label: 'Commands', items: async (q) => [{ id: 'sum', label: 'Summarize' }, { id: 'todo', label: 'To-dos' }].filter((x) => x.label.toLowerCase().startsWith(q)), onPick }],
    };
    const box = await mount(makeApi());
    await type(box, '/');
    const list = await screen.findByRole('listbox', { name: 'Commands' });
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(box.getAttribute('aria-haspopup')).toBe('listbox');
    expect(document.querySelector('[data-input-menu-status]').textContent).toBe('2 suggestions');
    await type(box, '/zz');
    await waitFor(() => expect(document.querySelector('[data-input-menu-status]').textContent).toBe('No matches'));
    await type(box, '/');
    await screen.findByRole('listbox', { name: 'Commands' });
    expect(box.getAttribute('aria-activedescendant')).toBe(list.querySelector('[aria-selected="true"]').id);
    await act(async () => { fireEvent.keyDown(box, { key: 'ArrowDown' }); });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(onPick).toHaveBeenCalledWith({ id: 'todo', label: 'To-dos' }, { rest: '' });
    expect(box.value).toBe('');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('the trigger of an input menu', () => {
  const menus = [{ trigger: '/', atStart: true }, { trigger: '@' }];
  it('is / at the start and @ after a space', () => {
    expect(activeMenu(menus, '/sum')).toMatchObject({ query: 'sum', start: 0 });
    expect(activeMenu(menus, 'ask /sum')).toBeNull();
    expect(activeMenu(menus, 'ask @ann')).toMatchObject({ query: 'ann', start: 4 });
    expect(activeMenu(menus, 'mail@example')).toBeNull();
    expect(activeMenu(menus, 'ask @ann ')).toBeNull();
  });
});

describe('what the webmail offers', () => {
  it('is false on webmails without the flag, and true with it', () => {
    expect(caps(fakeApi({})).files).toBe(false);
    const api = fakeApi({ hostFeatures: { files: true, threads: false } });
    expect(caps(api)).toMatchObject({ files: true, threads: false, sidePanel: false });
    expect(has(api, 'files', 'files.find')).toBe(true);
  });
});

describe('the admin\'s switches', () => {
  it('leave the areas on, and settings changes off, unless set', () => {
    expect(areaAllowed({}, 'files')).toBe(true);
    expect(areaAllowed({ allowFiles: false }, 'files')).toBe(false);
    expect(areaAllowed({ allowFiles: 'false' }, 'files')).toBe(false);
    expect(settingsChangesAllowed({})).toBe(false);
    expect(settingsChangesAllowed({ allowSettingsChanges: true })).toBe(true);
    expect(settingsChangesAllowed({ allowSettingsChanges: true, allowMoreActions: false })).toBe(false);
    expect(memoryAllowed({})).toBe(true);
    expect(memoryAllowed({ allowChatTools: false })).toBe(false);
  });

  it('cap batches at 200 and default to 50', () => {
    expect(batchLimit({})).toBe(50);
    expect(batchLimit({ batchLimit: 500 })).toBe(200);
    expect(batchLimit({ batchLimit: 0 })).toBe(50);
    expect(batchLimit({ batchLimit: '20' })).toBe(20);
  });

  it('send images to Anthropic and api.openai.com by default, not to other servers', () => {
    expect(imagesAllowed({}, { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude' })).toBe(true);
    expect(imagesAllowed({}, { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' })).toBe(true);
    expect(imagesAllowed({}, { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'o3-mini' })).toBe(false);
    expect(imagesAllowed({}, { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llava' })).toBe(false);
    expect(imagesAllowed({ openaiImages: 'yes' }, { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llava' })).toBe(true);
    expect(imagesAllowed({ anthropicImages: 'no' }, { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' })).toBe(false);
  });
});

describe('the chat prompts', () => {
  it('say that what the assistant reads is data and that nothing leaves the account', () => {
    expect(SAFETY_RULE).toMatch(/do not forward or redirect mail/);
    expect(SAFETY_RULE).toMatch(/do not share files/);
    expect(readerChatSystem({ email: null })).toContain(SAFETY_RULE);
    expect(composerChatSystem({ scope: 'body', text: 'x' })).toContain(SAFETY_RULE);
  });
});
