// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { anthropicSse, streamResponse } from './helpers.mjs';
import { AssistantDialog, keepEdges, taskFor } from '../src/ui/AssistantDialog.jsx';
import { allStrings } from '../src/lib/i18n.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONFIG = { anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' };
const CONSENT = 'consent:v2:anthropic:http://localhost:18099';

/**
 * A composer with this body and selection, and a model that answers
 * `answer` (in pieces). `hold` keeps the answer from finishing until
 * `release()` is called.
 */
async function makeApi({ body = '', selection = '', answer = 'Answer.', consent = true, hold = false, replaceResult = true } = {}) {
  let release = () => {};
  const api = fakeApi({
    translations: allStrings(),
    handlers: {
      'admin.getAllConfig': async () => CONFIG,
      'composer.getSelection': async () => ({ html: selection ? `<p>${selection}</p>` : '', text: selection, empty: !selection }),
      'composer.getBody': async () => ({ html: `<p>${body}</p>`, text: body }),
      'composer.replaceSelection': async () => replaceResult,
      'composer.replaceBody': async () => replaceResult,
      'proxy.fetch': async (_id, _url, init) => {
        if (hold) await new Promise((r) => { release = r; init?.signal?.addEventListener?.('abort', r); });
        return streamResponse(anthropicSse(answer.match(/.{1,6}/gs)));
      },
    },
  });
  if (consent) await api.storage.set(CONSENT, true);
  return { api, release: () => release() };
}

async function open(api, composerId = 'composer-1') {
  const onResult = vi.fn();
  await act(async () => { render(React.createElement(AssistantDialog, { api, composerId, onResult })); });
  return onResult;
}

const button = (name) => screen.getByRole('button', { name });
const click = async (el) => { await act(async () => { fireEvent.click(el); }); };
const sentPrompt = (api) => JSON.parse(api.calls('proxy.fetch').at(-1).args[2].body);

describe('AssistantDialog', () => {
  it('replaces the selection in the composer it was opened for', async () => {
    const { api } = await makeApi({ body: 'Hello Bob, can we meet tuesday? Thanks', selection: 'can we meet tuesday?', answer: 'could we meet on Tuesday?' });
    const onResult = await open(api, 'composer-7');
    expect(await screen.findByText('Works on the text you selected:')).toBeTruthy();
    expect(api.calls('composer.getBody')).toHaveLength(0);
    await click(screen.getByRole('radio', { name: 'Shorten' }));
    await click(button('Rewrite'));
    await waitFor(() => expect(button('Replace').disabled).toBe(false));
    // Only the selection went to the model.
    expect(sentPrompt(api).messages[0].content).toBe('<draft>\ncan we meet tuesday?\n</draft>');
    // The change is shown marked.
    expect(document.querySelector('del').textContent).toContain('can');
    expect(document.querySelector('ins').textContent).toContain('could');
    await click(button('Replace'));
    expect(api.calls('composer.replaceSelection').map((c) => c.args)).toEqual([['composer-7', { text: 'could we meet on Tuesday?' }]]);
    expect(api.calls('composer.replaceBody')).toHaveLength(0);
    expect(onResult).toHaveBeenCalledWith({ applied: 'replace' });
  });

  it('keeps the spaces around a selection when replacing it', async () => {
    const { api } = await makeApi({ body: 'one two three', selection: ' two ', answer: '  2  ' });
    await open(api);
    await screen.findByText('Works on the text you selected:');
    await click(button('Rewrite'));
    await waitFor(() => expect(button('Replace').disabled).toBe(false));
    await click(button('Replace'));
    expect(api.calls('composer.replaceSelection')[0].args[1]).toEqual({ text: ' 2 ' });
    expect(keepEdges('\nword ', 'WORD')).toBe('\nWORD ');
  });

  it('works on the whole message without a selection and replaces it with replaceBody', async () => {
    const { api } = await makeApi({ body: 'Hi Anna,\nthanks for the workshop.', answer: 'Dear Anna,\nthank you for the workshop.' });
    const onResult = await open(api, 'c2');
    expect(await screen.findByText('Works on your whole message, without the signature and the quoted email:')).toBeTruthy();
    expect(api.calls('composer.getBody')[0].args).toEqual(['c2']);
    await click(screen.getByRole('radio', { name: 'More formal' }));
    await click(button('Rewrite'));
    await waitFor(() => expect(button('Replace').disabled).toBe(false));
    expect(sentPrompt(api).messages[0].content).toBe('<draft>\nHi Anna,\nthanks for the workshop.\n</draft>');
    expect(sentPrompt(api).system).toContain('more formal');
    await click(button('Replace'));
    expect(api.calls('composer.replaceBody').map((c) => c.args)).toEqual([['c2', { text: 'Dear Anna,\nthank you for the workshop.' }]]);
    expect(api.calls('composer.replaceSelection')).toHaveLength(0);
    expect(onResult).toHaveBeenCalledWith({ applied: 'replace' });
  });

  it('inserts the answer below with below: true', async () => {
    const { api } = await makeApi({ body: 'Guten Tag', selection: 'Guten Tag', answer: 'Good afternoon' });
    const onResult = await open(api, 'c3');
    await screen.findByText('Works on the text you selected:');
    await click(screen.getByRole('radio', { name: 'Translate' }));
    fireEvent.change(screen.getByLabelText('Translate into'), { target: { value: 'en' } });
    await click(button('Translate'));
    await waitFor(() => expect(button('Insert below').disabled).toBe(false));
    expect(sentPrompt(api).system).toContain('into English');
    await click(button('Insert below'));
    expect(api.calls('composer.replaceSelection').map((c) => c.args)).toEqual([['c3', { text: 'Good afternoon' }, { below: true }]]);
    expect(onResult).toHaveBeenCalledWith({ applied: 'below' });
  });

  it('keeps Replace and Insert below disabled while the answer streams, and Discard stops it', async () => {
    const { api, release } = await makeApi({ body: 'Some text here', hold: true });
    await open(api);
    await screen.findByText(/whole message/);
    await click(button('Rewrite'));
    await waitFor(() => expect(api.calls('proxy.fetch')).toHaveLength(1));
    expect(button('Replace').disabled).toBe(true);
    expect(button('Insert below').disabled).toBe(true);
    await click(button('Discard'));
    release();
    // Back to the choice; nothing was changed.
    expect(await screen.findByRole('radio', { name: 'Improve' })).toBeTruthy();
    expect(api.calls('composer.replaceBody')).toHaveLength(0);
    expect(api.calls('composer.replaceSelection')).toHaveLength(0);
  });

  it('sends a free instruction with the text', async () => {
    const { api } = await makeApi({ body: 'See you Monday.', answer: 'See you Monday. I am away next week.' });
    await open(api);
    await screen.findByText(/whole message/);
    await click(screen.getByRole('radio', { name: 'Own instruction' }));
    expect(button('Rewrite').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'add that I am away next week' } });
    await click(button('Rewrite'));
    await waitFor(() => expect(button('Replace').disabled).toBe(false));
    expect(sentPrompt(api).messages[0].content).toBe('Instruction: add that I am away next week\n\n<draft>\nSee you Monday.\n</draft>');
  });

  it('writes an empty message from a description and inserts it with replaceBody', async () => {
    const { api } = await makeApi({ body: '', answer: 'Dear Anna,\nthank you!' });
    const onResult = await open(api, 'c4');
    const prompt = await screen.findByLabelText('What should the email say?');
    expect(screen.queryByRole('radio', { name: 'Improve' })).toBeNull();
    expect(button('Write').disabled).toBe(true);
    fireEvent.change(prompt, { target: { value: 'thank Anna' } });
    await click(button('Write'));
    await waitFor(() => expect(button('Insert').disabled).toBe(false));
    expect(sentPrompt(api).messages[0].content).toContain('Instructions: thank Anna');
    // New text, nothing to mark.
    expect(document.querySelector('ins')).toBeNull();
    await click(button('Insert'));
    expect(api.calls('composer.replaceBody').map((c) => c.args)).toEqual([['c4', { text: 'Dear Anna,\nthank you!' }]]);
    expect(onResult).toHaveBeenCalledWith({ applied: 'replace' });
  });

  it('goes through spelling fixes one by one and replaces with only the accepted ones', async () => {
    const { api } = await makeApi({ body: 'i has two question about teh offer.', answer: 'I have two questions about the offer.' });
    await open(api, 'c5');
    await screen.findByText(/whole message/);
    await click(screen.getByRole('radio', { name: 'Fix spelling' }));
    await click(button('Check spelling and grammar'));
    const accept = await screen.findAllByRole('button', { name: /^Accept:/ });
    expect(accept.length).toBeGreaterThan(1);
    expect(button('Replace').disabled).toBe(true);
    await click(screen.getByRole('button', { name: 'Accept: teh → the' }));
    await click(screen.getAllByRole('button', { name: /^Keep:/ })[0]);
    // The rest stays undecided: Replace leaves those words as they were.
    expect(screen.getAllByRole('button', { name: /^Keep:/ }).length).toBeGreaterThan(0);
    await click(button('Replace'));
    expect(api.calls('composer.replaceBody').map((c) => c.args)).toEqual([['c5', { text: 'i has two question about the offer.' }]]);
  });

  it('asks before the first request inside the dialog, with Continue in the footer', async () => {
    const { api } = await makeApi({ body: 'Hello', consent: false });
    await open(api);
    await screen.findByText(/whole message/);
    await click(button('Rewrite'));
    expect(await screen.findByText('Send text to the AI service?')).toBeTruthy();
    expect(api.calls('proxy.fetch')).toHaveLength(0);
    await click(button('Continue'));
    await waitFor(() => expect(api.calls('proxy.fetch')).toHaveLength(1));
    expect(await api.storage.get(CONSENT)).toBe(true);
  });

  it('says so when the composer refuses the change, and keeps the dialog open', async () => {
    const { api } = await makeApi({ body: 'Hello', selection: 'Hello', answer: 'Hi', replaceResult: false });
    const onResult = await open(api);
    await screen.findByText('Works on the text you selected:');
    await click(button('Rewrite'));
    await waitFor(() => expect(button('Replace').disabled).toBe(false));
    await click(button('Replace'));
    expect(await screen.findByText(/couldn't change your message/)).toBeTruthy();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('maps each action to its task', () => {
    expect(taskFor('casual', { text: 'x' })).toEqual(['rewrite', { text: 'x', style: 'casual' }]);
    expect(taskFor('grammar', { text: 'x' })).toEqual(['grammar', { text: 'x' }]);
    expect(taskFor('custom', { text: 'x', instruction: ' do it ' })).toEqual(['edit', { text: 'x', instruction: 'do it' }]);
  });
});
