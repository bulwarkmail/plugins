// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { ReaderBar } from '../src/ui/Reader.jsx';
import { allStrings } from '../src/lib/i18n.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const EMAIL = { id: 'M1', subject: 'Thursday', receivedAt: '2026-10-12T09:00:00Z', from: [{ name: 'Carol', email: 'carol@example.org' }], text: 'Can we meet on Thursday?' };

async function makeApi(answer, { consent = true, confirm = true, reply } = {}) {
  const api = fakeApi({
    translations: allStrings(),
    handlers: {
      'admin.getAllConfig': async () => ({ anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' }),
      'proxy.fetch': async () => streamResponse(anthropicSse([answer])),
      'ui.confirm': async () => confirm,
      'compose.reply': reply ?? (async () => true),
    },
  });
  if (consent) await api.storage.set('consent:anthropic:http://localhost:18099', true);
  return api;
}

const click = async (el) => { await act(async () => { fireEvent.click(el); }); };

async function open(api) {
  await act(async () => { render(React.createElement(ReaderBar, { api, email: EMAIL, deviceType: 'mobile' })); });
}

describe('ReaderBar', () => {
  it('shows the summary inside the bar', async () => {
    const api = await makeApi('- Carol wants to meet on Thursday.\n- No time given.');
    await open(api);
    await click(screen.getByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('- Carol wants to meet on Thursday.')).toBeTruthy();
    expect(screen.getByText('- No time given.')).toBeTruthy();
    expect(screen.getByText('Summary')).toBeTruthy();
    // While a result is shown the bar has its own buttons only; Close brings the actions back.
    expect(screen.queryByRole('button', { name: 'Reply ideas' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Summary')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reply ideas' })).toBeTruthy();
  });

  it('opens a reply that already says the chosen idea', async () => {
    const api = await makeApi('["Yes, Thursday works.", "Could we do Friday instead?", "Sorry, I can\'t this week."]');
    await open(api);
    await click(screen.getByRole('button', { name: 'Reply ideas' }));
    expect(await screen.findByText('Could we do Friday instead?')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Reply' });
    expect(buttons).toHaveLength(3);
    await click(buttons[1]);
    expect(api.calls('compose.reply').map((c) => c.args)).toEqual([['M1', { text: 'Could we do Friday instead?' }]]);
  });

  it('tells the user when the reply could not be opened', async () => {
    const api = await makeApi('["Yes."]', { reply: async () => { throw new Error('compose.reply: the message is not open in the reader'); } });
    await open(api);
    await click(screen.getByRole('button', { name: 'Reply ideas' }));
    await click(await screen.findByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(api.calls('toast.error')).toHaveLength(1));
    expect(api.calls('toast.error')[0].args[0]).toMatch(/Couldn't open the reply/);
  });

  it('asks with the host\'s confirm before the first request, and sends nothing when declined', async () => {
    const api = await makeApi('Summary', { consent: false, confirm: false });
    await open(api);
    await click(screen.getByRole('button', { name: 'Summarize' }));
    await waitFor(() => expect(api.calls('ui.confirm')).toHaveLength(1));
    expect(api.calls('ui.confirm')[0].args[0].title).toBe('Send text to the AI service?');
    expect(api.calls('proxy.fetch')).toHaveLength(0);
  });

  it('lists to-dos and dates', async () => {
    const api = await makeApi('{"tasks":[{"text":"Send the slides","due":null}],"dates":[{"text":"Meeting","date":"2026-10-15","time":"14:00"}]}');
    await open(api);
    await click(screen.getByRole('button', { name: 'To-dos and dates' }));
    expect(await screen.findByText('• Send the slides')).toBeTruthy();
    expect(screen.getByText(/Meeting$/).textContent).toMatch(/^• .*15.*: Meeting$/);
    expect(screen.getByRole('button', { name: 'Copy list' })).toBeTruthy();
  });
});
