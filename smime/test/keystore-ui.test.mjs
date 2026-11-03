// @vitest-environment jsdom
// The settings page and the banner with OS keys, drawn with a fake api.keystore.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fakeApi as bareFakeApi } from '../../test-utils/fake-api.mjs';
import { fakeKeystore } from './helpers/fake-keystore.mjs';
import { createOsKeys } from '../src/os-keys.js';
import { makeUi, bannerRows } from '../src/ui.js';
import { publishComposeActions } from '../src/compose-actions.js';

const DIR = path.join(process.cwd(), 'smime');
const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const en = manifest.locales.en;
const fixture = (name) => readFileSync(path.join(DIR, 'test', 'fixtures', name), 'utf8');
const RSA = { certificate: fixture('cert.pem'), key: fixture('key.pem') };
const EC = { certificate: fixture('ec-p256-cert.pem'), key: fixture('ec-p256-key.pem') };
const t = (key, vars) => bareFakeApi({ translations: manifest.locales }).i18n.t(key, vars);

afterEach(cleanup);

function setup({ specs = [RSA], features = { keystore: true }, imported = [], onKeysChanged = async () => {}, handlers = {} } = {}) {
  const ks = fakeKeystore(specs);
  const api = bareFakeApi({ translations: manifest.locales, hostFeatures: features, handlers: { ...ks.handlers, ...handlers } });
  const osKeys = createOsKeys(api);
  const deps = {
    VERIFY_PREFIX: 'verify:',
    FRESH_PREFIX: 'fresh:',
    DEFAULT_PREFS: { defaultSign: false, defaultEncrypt: false },
    settings: () => ({}),
    isCapable: async () => true,
    getPrefs: async () => ({ defaultSign: false, defaultEncrypt: false }),
    setPrefs: async () => {},
    detectSmime: () => ({ type: null }),
    ensureKeyUnlocked: async () => null,
    listKeyRecords: async () => imported,
    getSessionKeys: async () => null,
    listPublicCerts: async () => [],
    onKeysChanged,
    osKeys,
  };
  return { api, ks, osKeys, deps, ...makeUi(api, deps) };
}

async function openSettings(context) {
  await act(async () => { render(React.createElement(context.SettingsSection)); });
}

describe('the settings page', () => {
  it('lists OS keys when it opens, marked as from the system store', async () => {
    const context = setup();
    await openSettings(context);
    await screen.findByText('smime-test@example.com');
    expect(context.ks.calls.list).toHaveLength(1);
    expect(screen.getByText(en['keys.fromSystem'])).toBeTruthy();
    expect(screen.queryByText(en['keys.empty'])).toBeNull();
  });

  it('offers neither unlock nor delete for an OS key', async () => {
    const context = setup();
    await openSettings(context);
    await screen.findByText('smime-test@example.com');
    expect(screen.queryByRole('button', { name: en['unlock.confirm'] })).toBeNull();
    expect(screen.queryByRole('button', { name: en['keys.delete'] })).toBeNull();
  });

  it('shows imported keys next to it, with their actions', async () => {
    const imported = [{ id: 'k', email: 'old@example.com', algorithm: 'RSA-2048', notBefore: '2020-01-01', notAfter: '2120-01-01', capabilities: {} }];
    const context = setup({ imported });
    await openSettings(context);
    await screen.findByText('smime-test@example.com');
    expect(screen.getByText('old@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: en['unlock.confirm'] })).toBeTruthy();
    expect(screen.getAllByText(en['keys.fromSystem'])).toHaveLength(1);
  });

  it('says when a key can only sign', async () => {
    const context = setup({ specs: [{ ...EC, canAgree: false }] });
    await openSettings(context);
    await screen.findByText('smime-ec@example.com');
    expect(screen.getByText(new RegExp(en['keys.signOnly']))).toBeTruthy();
  });

  it('does not say so for an EC key with key agreement', async () => {
    const context = setup({ specs: [EC] });
    await openSettings(context);
    await screen.findByText('smime-ec@example.com');
    expect(screen.queryByText(new RegExp(en['keys.signOnly']))).toBeNull();
  });

  it('names a smart card', async () => {
    const context = setup({ specs: [{ ...RSA, source: 'smartcard' }] });
    await openSettings(context);
    await screen.findByText(new RegExp(en['keys.smartcard']));
  });

  it('tells a refusal apart from an empty store, and the import keeps working', async () => {
    const context = setup();
    context.ks.refuse('list', 'keystore:cancelled');
    await openSettings(context);
    await screen.findByText(en['keys.systemDenied']);
    expect(screen.getByText(en['keys.empty'])).toBeTruthy();
    expect(screen.getByRole('button', { name: en['keys.import'] })).toBeTruthy();
  });

  it('says so when the store could not be read', async () => {
    const context = setup();
    context.ks.refuse('list', 'keystore:failed');
    await openSettings(context);
    await screen.findByText(en['keys.systemFailed']);
  });

  it('looks again on request', async () => {
    const context = setup();
    await openSettings(context);
    await screen.findByText('smime-test@example.com');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['keys.systemRefresh'] })); });
    await waitFor(() => expect(context.ks.calls.list).toHaveLength(2));
  });

  it('tells the composer once it knows', async () => {
    let told = 0;
    const context = setup({ onKeysChanged: async () => { told += 1; } });
    await openSettings(context);
    await screen.findByText('smime-test@example.com');
    expect(told).toBeGreaterThan(0);
  });

  it('shows nothing about the system store without the flag', async () => {
    const context = setup({ features: {} });
    await openSettings(context);
    await screen.findByText(en['keys.empty']);
    expect(context.ks.calls.list).toHaveLength(0);
    expect(screen.queryByRole('button', { name: en['keys.systemRefresh'] })).toBeNull();
    expect(screen.queryByText(en['keys.systemHint'])).toBeNull();
  });
});

describe('the composer menu', () => {
  const deps = (over) => ({ getPrefs: async () => ({}), listKeyRecords: async () => [], detached: () => true, ...over });

  it('stays usable while OS keys may exist', async () => {
    const api = bareFakeApi({ translations: manifest.locales });
    expect((await publishComposeActions(api, deps({ mayHaveOsKeys: () => true }))).ready).toBe(true);
  });

  it('says to import a key once looked and found nothing', async () => {
    const api = bareFakeApi({ translations: manifest.locales });
    expect((await publishComposeActions(api, deps({ mayHaveOsKeys: () => false }))).ready).toBe(false);
  });
});

describe('the banner', () => {
  const rows = (decryptionError) => bannerRows({ isEncrypted: true, decryptionSuccess: false, decryptionError }, { t });

  it.each([
    ['os-cancelled', 'banner.osCancelled'],
    ['os-busy', 'banner.osBusy'],
    ['os-pending', 'banner.osPending'],
  ])('words %s and offers another try', (status, key) => {
    expect(rows(status)).toEqual([expect.objectContaining({ text: en[key], tone: 'warning', action: 'retry' })]);
  });

  const email = { id: 'm1', headers: {} };
  const key = 'verify:m1';
  const verdict = (over) => ({ isEncrypted: true, decryptionSuccess: false, decryptionError: 'os-cancelled', at: Date.now(), ...over });
  const openBanner = async (context) => {
    await act(async () => { render(React.createElement(context.EmailBanner, { email })); });
  };

  it('Try again marks the message to run afresh, renders it again, and shows the new verdict', async () => {
    let flagged;
    const context = setup({
      handlers: {
        'ui.rerenderEmail': async () => {
          flagged = await context.api.storage.get('fresh:m1');
          await context.api.storage.set(key, { isEncrypted: true, decryptionSuccess: true, at: Date.now() });
        },
      },
    });
    await context.api.storage.set(key, verdict({ at: 1 }));
    await openBanner(context);
    const button = await screen.findByRole('button', { name: en['banner.tryAgain'] });
    await act(async () => { fireEvent.click(button); });
    await screen.findByText(en['banner.decrypted']);
    expect(flagged).toBe(true);
    expect(context.api.calls('ui.rerenderEmail')).toHaveLength(1);
  });

  it('Try again ends its busy state when the same answer comes again', async () => {
    const context = setup({
      handlers: { 'ui.rerenderEmail': async () => { await context.api.storage.set(key, verdict()); } },
    });
    await context.api.storage.set(key, verdict({ at: 1 }));
    await openBanner(context);
    const button = await screen.findByRole('button', { name: en['banner.tryAgain'] });
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(screen.getByRole('button', { name: en['banner.tryAgain'] }).disabled).toBe(false), { timeout: 3000 });
  });

  it('keeps looking while the consent dialog is up, and picks up the verdict', async () => {
    const context = setup();
    await context.api.storage.set(key, verdict({ decryptionError: 'os-pending' }));
    await openBanner(context);
    await screen.findByText(en['banner.osPending']);
    await context.api.storage.set(key, { isEncrypted: true, decryptionSuccess: true, at: Date.now() });
    await screen.findByText(en['banner.decrypted'], undefined, { timeout: 3000 });
  });

  it('replaces an old verdict from an earlier opening when the new result comes', async () => {
    const context = setup();
    await context.api.storage.set(key, { isEncrypted: true, decryptionSuccess: true, at: Date.now() - 60_000 });
    await openBanner(context);
    await screen.findByText(en['banner.decrypted']);
    await context.api.storage.set(key, verdict());
    await screen.findByText(en['banner.osCancelled'], undefined, { timeout: 3000 });
  });

  it('shows no verdict while the message is in progress', async () => {
    const context = setup();
    await context.api.storage.set(key, { isEncrypted: true, inProgress: true, at: Date.now() });
    await openBanner(context);
    await screen.findByText(en['banner.encrypted']);
    expect(screen.queryByText(en['banner.decrypted'])).toBeNull();
  });

  it('watches past half a minute, as a PIN can take longer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const context = setup();
      await context.api.storage.set(key, { isEncrypted: true, inProgress: true, at: Date.now() });
      await openBanner(context);
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      await context.api.storage.set(key, { isEncrypted: true, decryptionSuccess: true, at: Date.now() });
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(screen.getByText(en['banner.decrypted'])).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops watching once it has a verdict from this opening', async () => {
    const context = setup();
    await context.api.storage.set(key, { isEncrypted: true, inProgress: true, at: Date.now() });
    await openBanner(context);
    const fresh = { isEncrypted: true, decryptionSuccess: true, at: Date.now() + 1000 };
    await context.api.storage.set(key, fresh);
    await screen.findByText(en['banner.decrypted'], undefined, { timeout: 3000 });
    await context.api.storage.set(key, verdict({ at: Date.now() + 2000 }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(screen.getByText(en['banner.decrypted'])).toBeTruthy();
  });

  it('notes missing integrity protection in one line', () => {
    const rows = bannerRows({ isEncrypted: true, decryptionSuccess: true, noIntegrity: true }, { t });
    expect(rows.map((r) => r.text)).toEqual([en['banner.decrypted'], en['banner.noIntegrity']]);
  });

  it('has no retry for a refused store, which only a restart can undo', () => {
    expect(bannerRows({ isEncrypted: true, decryptionSuccess: false, decryptionError: 'os-list-denied' }, { t })[0])
      .toMatchObject({ text: en['banner.osListDenied'], tone: 'warning' });
    expect(bannerRows({ isEncrypted: true, decryptionSuccess: false, decryptionError: 'os-list-denied' }, { t })[0].action).toBeUndefined();
  });
});
