// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { AssistantPanel } from '../src/ui/Panel.jsx';
import { SettingsPanel } from '../src/ui/SettingsPanel.jsx';
import { allStrings } from '../src/lib/i18n.js';
import { clearFileMentions } from '../src/ui/panel/areas/files.js';

// The files area in the panel: files in the @ menu, their chips, what the
// model is told, the privacy sentence and the two settings switches.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { cleanup(); clearFileMentions(); });

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const CONSENT = 'consent:v2:anthropic:http://localhost:18099';
const FEATURES = { files: true };
const NOTES = { id: 'n1', name: 'Quarter notes.md', path: '/Documents', parentId: 'docs', kind: 'file', mimeType: 'text/markdown', size: 120, modified: '2026-10-30T10:00:00Z' };
const EMAIL = { id: 'M1', subject: 'Plan', from: [{ email: 'carol@example.org' }], text: 'Hello', attachments: [] };

function makeApi({ hostFeatures = FEATURES, consent = true, config = CONFIG, handlers = {} } = {}) {
  const api = fakeApi({
    translations: allStrings(),
    ...(hostFeatures ? { hostFeatures } : {}),
    handlers: {
      'admin.getAllConfig': async () => config,
      'files.find': async () => [NOTES],
      'email.search': async () => [],
      'contacts.search': async () => [],
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
const sent = (api, n = -1) => JSON.parse(api.calls('proxy.fetch').at(n).args[2].body);
const settled = () => waitFor(() => expect(document.querySelector('[data-turn="assistant"][data-status="running"]')).toBeNull());
async function mount(api, props = {}) {
  await act(async () => { render(React.createElement(AssistantPanel, { api, selection: { text: '' }, focusRequest: 0, email: EMAIL, ...props })); });
  await screen.findByRole('textbox', { name: 'Message to the assistant' });
}

describe('files in the chat', () => {
  it('lists files in the @ menu, makes the pick a chip and tells the model', async () => {
    const api = makeApi();
    await mount(api);
    await type('Summarise @quarter');
    const list = await screen.findByRole('listbox', { name: 'Mention a message, contact or file' });
    expect(list).toBeTruthy();
    const option = screen.getByRole('option');
    expect(option.textContent).toBe('Quarter notes.md/Documents');
    await key('Enter');
    expect(input().value).toBe('Summarise ');
    const chip = screen.getByRole('group', { name: 'File Quarter notes.md in /Documents' });
    expect(chip).toBeTruthy();
    await type('Summarise this');
    await key('Enter');
    await settled();
    const body = sent(api);
    expect(body.system).toContain('The user mentioned these files and folders');
    expect(body.system).toContain('- id n1 | "Quarter notes.md" | in /Documents');
    expect(body.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['find_file', 'list_folder', 'read_file']));
  });

  it('takes a file out again with its chip\'s button', async () => {
    const api = makeApi();
    await mount(api);
    await type('@quarter');
    await screen.findByRole('listbox');
    await key('Enter');
    await click(screen.getByRole('button', { name: 'Leave Quarter notes.md out' }));
    expect(screen.queryByRole('group', { name: /Quarter notes/ })).toBeNull();
  });

  it('offers no files where the webmail has none', async () => {
    const api = makeApi({ hostFeatures: { files: false } });
    await mount(api);
    await type('hello');
    await key('Enter');
    await settled();
    expect(sent(api).tools.map((t) => t.name)).not.toContain('find_file');
    expect(api.calls('files.find')).toHaveLength(0);
  });

  it('says in the notice what goes along from Files', async () => {
    const api = makeApi({ consent: false });
    await mount(api);
    await type('hi');
    await key('Enter');
    const notice = (await screen.findByText(/sends your request to Anthropic/)).textContent;
    expect(notice).toContain('the names and folder paths of the files it lists and the contents of the files it reads');
  });
});

describe('the Files settings', () => {
  async function show(config, hostFeatures = FEATURES) {
    const api = fakeApi({ translations: allStrings(), ...(hostFeatures ? { hostFeatures } : {}), handlers: { 'admin.getAllConfig': async () => config } });
    await act(async () => { render(React.createElement(SettingsPanel, { api })); });
    await screen.findByText('Let the assistant look things up');
    return api;
  }

  it('has a switch for reading and one for writing, and saves them', async () => {
    const api = await show(CONFIG);
    for (const name of ['Find and read files', 'Save and create files']) {
      expect(screen.getByRole('switch', { name }).getAttribute('aria-checked')).toBe('true');
    }
    await click(screen.getByRole('switch', { name: 'Save and create files' }));
    await waitFor(async () => expect((await api.storage.get('prefs'))?.filesWrite).toBe(false));
  });

  it('is not there without Files, or when the admin switched it off', async () => {
    await show(CONFIG, null);
    expect(screen.queryByRole('switch', { name: 'Find and read files' })).toBeNull();
    cleanup();
    await show({ ...CONFIG, allowFiles: false });
    expect(screen.queryByRole('switch', { name: 'Find and read files' })).toBeNull();
  });
});
