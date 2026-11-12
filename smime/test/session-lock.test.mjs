// Unlocked keys sit in a store on disk with the browser profile, protected by the device
// rather than by the passphrase. So they don't outlive the page: the store is wiped when
// the page goes away (pagehide), and a key nobody used for 30 minutes locks, also while
// the page stays open. What a browser leaves on disk after that can't be checked here;
// these tests check that the store is empty and that a decrypt or a signature asks for
// the passphrase again.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';
import { fakeKeystore } from './helpers/fake-keystore.mjs';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { importPkcs12, unlockPrivateKey } from '../src/pkcs12.js';
import { saveKeyRecord, saveSessionKeys } from '../src/key-storage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));

const FROM = 'smime-test@example.com';
const PASS = 'storage passphrase';
const MINUTE = 60_000;
const T0 = new Date('2026-11-12T09:00:00Z').getTime();

let code;
let keyRecord;
let idb;

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(here, '../src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    alias: { crypto: path.join(here, '../src/node-crypto-shim.js') },
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  });
  code = out.outputFiles[0].text;
  const p12 = Uint8Array.from(fixture('test.p12'));
  ({ keyRecord } = await importPkcs12(p12.buffer.slice(p12.byteOffset, p12.byteOffset + p12.byteLength), 'fixture', PASS));
}, 120_000);

beforeEach(async () => {
  idb = fakeIndexedDB();
  globalThis.indexedDB = idb;
  await saveKeyRecord(keyRecord);
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.addEventListener;
});

// The imported key only (no OS store), as in a browser.
function plugin() {
  const ks = fakeKeystore([]);
  const api = fakeApi({
    id: 'smime',
    translations: manifest.locales,
    handlers: {
      ...ks.handlers,
      'jmap.fetchBlob': async () => Uint8Array.from(fixture('cbc.p7m')),
      'jmap.sendRaw': async () => {},
      'ui.prompt': async () => null,
      'ui.rerenderEmail': async () => {},
      'ui.setActions': async () => {},
    },
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === '@plugin-host') return api;
    if (id === '@plugin-host/ui') return kit;
    return require(id);
  });
  return { api, ...mod.exports };
}

async function unlock() {
  const { signingKey, decryptionKey, sealedPkcs8 } = await unlockPrivateKey(keyRecord, PASS);
  await saveSessionKeys({ id: keyRecord.id, signingKey, decryptionKey, sealedPkcs8 });
}

const sessionEntries = () => idb.rows('smime-plugin-store', 'session-keys')?.size ?? 0;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function decrypt(hooks) {
  const result = await hooks.onRenderEmailBody({ html: '', text: '' }, {
    id: `mail-${Math.random()}`, contentType: 'application/pkcs7-mime; smime-type=enveloped-data', blobId: 'blob', from: ['a@example.org'],
  });
  return result.verification;
}

describe('when the page goes away', () => {
  it('empties the store of unlocked keys, and the next decrypt asks for the passphrase', async () => {
    const listeners = [];
    globalThis.addEventListener = (type, fn) => listeners.push([type, fn]);
    const { api, hooks, activate } = plugin();
    await activate(api);
    await unlock();
    expect(sessionEntries()).toBe(1);
    expect(await decrypt(hooks)).toMatchObject({ decryptionSuccess: true });

    for (const [type, fn] of listeners) if (type === 'pagehide') fn({ persisted: false });
    await settle();
    expect(sessionEntries()).toBe(0);
    expect(await decrypt(hooks)).toMatchObject({ decryptionSuccess: false, decryptionError: 'locked' });
  });
});

describe('a key nobody uses for 30 minutes', () => {
  it('locks, and a decrypt asks for the passphrase again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { hooks } = plugin();
    await unlock();
    expect(await decrypt(hooks)).toMatchObject({ decryptionSuccess: true });
    vi.setSystemTime(T0 + 31 * MINUTE);
    expect(await decrypt(hooks)).toMatchObject({ decryptionSuccess: false, decryptionError: 'locked' });
    expect(sessionEntries()).toBe(0);
  });

  it('stays unlocked while it is used, and locks 30 minutes after the last use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { hooks } = plugin();
    await unlock();
    vi.setSystemTime(T0 + 20 * MINUTE);
    expect(await decrypt(hooks)).toMatchObject({ decryptionSuccess: true });
    vi.setSystemTime(T0 + 45 * MINUTE);
    expect(await decrypt(hooks)).toMatchObject({ decryptionSuccess: true });
    vi.setSystemTime(T0 + 76 * MINUTE);
    expect(await decrypt(hooks)).toMatchObject({ decryptionError: 'locked' });
  });

  it('asks for the passphrase again before signing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { api, hooks } = plugin();
    await unlock();
    const send = () => hooks.onComposeSend({ identityId: 'identity', fromEmail: FROM, to: ['someone@example.org'], subject: 'Hi', textBody: 'Hi', sign: true, encrypt: false });
    vi.setSystemTime(T0 + 20 * MINUTE);
    await expect(send()).resolves.toBe(false);
    vi.setSystemTime(T0 + 45 * MINUTE);
    await expect(send()).resolves.toBe(false);
    expect(api.calls('ui.prompt')).toHaveLength(0);
    vi.setSystemTime(T0 + 80 * MINUTE);
    await expect(send()).resolves.toEqual({ abort: true });
    expect(api.calls('ui.prompt')).toHaveLength(1);
  });

  it('is removed from the store while the page stays open, without anything reading it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);
    const { api, activate } = plugin();
    await activate(api);
    await unlock();
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(sessionEntries()).toBe(1);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(sessionEntries()).toBe(0);
  });
});
