// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fakeApi as bareFakeApi } from '../../test-utils/fake-api.mjs';
import { makeUi, bannerRows } from '../src/ui.js';
import { composeActions, handleComposeAction, publishComposeActions, resetComposeIntent, INTENT_KEY } from '../src/compose-actions.js';

const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'smime', 'manifest.json'), 'utf8'));
const fakeApi = (opts = {}) => bareFakeApi({ translations: manifest.locales, ...opts });
const t = (key, vars) => fakeApi().i18n.t(key, vars);

afterEach(cleanup);

function deps(over = {}) {
  return {
    VERIFY_PREFIX: 'verify:',
    DEFAULT_PREFS: { defaultSign: false, defaultEncrypt: false },
    NOT_PRIVILEGED_MSG: 'not privileged',
    settings: () => ({}),
    isCapable: async () => true,
    getPrefs: async () => ({ defaultSign: false, defaultEncrypt: false }),
    setPrefs: async () => {},
    detectSmime: () => ({ type: null }),
    ensureKeyUnlocked: async () => null,
    listKeyRecords: async () => [],
    getSessionKeys: async () => null,
    listPublicCerts: async () => [],
    detached: () => true,
    ...over,
  };
}

describe('composer Options entries', () => {
  it('are check items carrying the stored intent', () => {
    const actions = composeActions({ intent: { sign: true, encrypt: false }, ready: true, detached: true, t });
    expect(actions.map((a) => [a.id, a.checked])).toEqual([['sign', true], ['encrypt', false]]);
    expect(actions[0].description).toMatch(/Detached/);
    for (const a of actions) expect(a.description.length).toBeLessThanOrEqual(120);
  });

  it('stay unchecked and say why without a key', () => {
    const actions = composeActions({ intent: { sign: true, encrypt: true }, ready: false, detached: true, t });
    expect(actions.every((a) => a.checked === false)).toBe(true);
    expect(actions[0].description).toMatch(/Import your S\/MIME key/);
  });

  it('a click flips that entry, stores it for the send, and republishes the menu', async () => {
    const api = fakeApi();
    const d = deps({ listKeyRecords: async () => [{ id: 'k' }] });
    await publishComposeActions(api, d);
    await handleComposeAction(api, d, { surface: 'composer-options-menu', actionId: 'encrypt', context: { composerId: 'c1' } });
    expect(await api.storage.get(INTENT_KEY)).toEqual({ sign: false, encrypt: true });
    const last = api.calls('ui.setActions').at(-1).args;
    expect(last[0]).toBe('composer-options-menu');
    expect(last[1].find((a) => a.id === 'encrypt').checked).toBe(true);
  });

  it('a click without a key changes nothing and explains', async () => {
    const api = fakeApi();
    await handleComposeAction(api, deps(), { surface: 'composer-options-menu', actionId: 'sign' });
    expect(await api.storage.get(INTENT_KEY)).toBeNull();
    expect(api.calls('toast.info')).toHaveLength(1);
  });

  it('a new composer starts from the defaults in Settings', async () => {
    const api = fakeApi();
    await api.storage.set(INTENT_KEY, { sign: false, encrypt: true });
    const d = deps({ listKeyRecords: async () => [{ id: 'k' }], getPrefs: async () => ({ defaultSign: true, defaultEncrypt: false }) });
    await resetComposeIntent(api, d);
    const last = api.calls('ui.setActions').at(-1).args[1];
    expect(last.map((a) => [a.id, a.checked])).toEqual([['sign', true], ['encrypt', false]]);
  });
});

describe('reader banner', () => {
  it('shows one info bar per status, in the status tone', async () => {
    const api = fakeApi();
    await api.storage.set('verify:m1', { isEncrypted: true, decryptionSuccess: true, isSigned: true, signatureValid: true, signerCert: { email: 'a@x.org', notAfter: '2999-01-01', notBefore: '2000-01-01' }, signerEmailMatch: true });
    const { EmailBanner } = makeUi(api, deps());
    await act(async () => { render(React.createElement(EmailBanner, { email: { id: 'm1' } })); });
    const bars = document.querySelectorAll('.bk-infobar');
    expect([...bars].map((b) => b.getAttribute('data-tone'))).toEqual(['success', 'success']);
    expect(bars[1].textContent).toMatch(/Valid signature by a@x.org/);
    fireEvent.click(screen.getByRole('button', { name: /Show certificate details/ }));
    expect(screen.getByText(/Certificate is for the sender's address/)).toBeTruthy();
    expect(document.querySelector('[style]')).toBeNull();
  });

  it('turns into the verdict when verification finishes after the banner opened', async () => {
    const api = fakeApi();
    const { EmailBanner } = makeUi(api, deps({ detectSmime: () => ({ type: 'detached-sig' }) }));
    const email = { id: 'm2', headers: { 'Content-Type': 'multipart/signed; protocol="application/pkcs7-signature"' } };
    await act(async () => { render(React.createElement(EmailBanner, { email })); });
    expect(document.querySelector('.bk-infobar').textContent).toMatch(/Signed message/);
    // The render hook in the background instance stores its result later.
    await api.storage.set('verify:m2', { isSigned: true, signatureValid: true, signerCert: { email: 'a@x.org', notAfter: '2999-01-01', notBefore: '2000-01-01' }, signerEmailMatch: true });
    await waitFor(() => expect(document.querySelector('.bk-infobar').textContent).toMatch(/Valid signature by a@x.org/));
    expect(document.querySelector('.bk-infobar').getAttribute('data-tone')).toBe('success');
  });

  it('offers Unlock now on a locked message', () => {
    const rows = bannerRows({ isEncrypted: true, decryptionError: 'locked' }, { t });
    expect(rows).toEqual([expect.objectContaining({ tone: 'warning', action: 'unlock' })]);
  });
});

describe('settings section', () => {
  it('lists keys as rows with Unlock and Delete, and defaults as switches', async () => {
    const api = fakeApi();
    const d = deps({
      listKeyRecords: async () => [{ id: 'k1', email: 'me@x.org', algorithm: 'RSA', notBefore: '2020-01-01', notAfter: '2000-01-01', capabilities: { canSign: true } }],
    });
    const { SettingsSection } = makeUi(api, d);
    await act(async () => { render(React.createElement(SettingsSection)); });
    const row = screen.getAllByRole('listitem')[0];
    expect(row.textContent).toMatch(/me@x.org/);
    expect(row.textContent).toMatch(/Expired/);
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete key' })).toBeTruthy();
    expect(screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toEqual(['Sign new messages', 'Encrypt new messages']);
    expect(document.querySelector('input[type=checkbox]')).toBeNull();
  });

  it('tells the composer when a default changes', async () => {
    const api = fakeApi();
    let told = 0;
    const saved = [];
    const { SettingsSection } = makeUi(api, deps({ setPrefs: async (p) => { saved.push(p); }, onKeysChanged: async () => { told++; } }));
    await act(async () => { render(React.createElement(SettingsSection)); });
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Sign new messages' })); });
    expect(saved).toEqual([{ defaultSign: true, defaultEncrypt: false }]);
    expect(told).toBe(1);
  });
});
