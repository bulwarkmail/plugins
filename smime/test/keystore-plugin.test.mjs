// The built bundle against the fake api, the way the webmail's sandbox runs it: what
// happens in the hooks when OS keys are there, aren't, or the user says no. A hook that
// throws or runs out of time counts towards the plugin being switched off, so what's
// checked here includes that these return.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';
import { fakeKeystore } from './helpers/fake-keystore.mjs';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { importPkcs12 } from '../src/pkcs12.js';
import { saveKeyRecord, savePublicCert } from '../src/key-storage.js';
import { extractDetachedSigned } from '../src/mime-parse.js';
import { smimeVerifyDetached } from '../src/smime-verify.js';
import { bannerRows } from '../src/ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));
const fixtureBytes = (name) => Uint8Array.from(fixture(name));

const RSA = { certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() };
const EC = { certificate: fixture('ec-p256-cert.pem').toString(), key: fixture('ec-p256-key.pem').toString() };
const FROM = 'smime-test@example.com';
const PLAINTEXT = 'Hello from the S/MIME test fixture.';
const ABORT = { abort: true };
const STORAGE_PASS = 'storage passphrase';

let code;
let importedKey;

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(here, '../src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    alias: { crypto: path.join(here, '../src/node-crypto-shim.js') },
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  });
  code = out.outputFiles[0].text;
  const p12 = fixtureBytes('test.p12');
  ({ keyRecord: importedKey } = await importPkcs12(p12.buffer.slice(p12.byteOffset, p12.byteOffset + p12.byteLength), 'fixture', STORAGE_PASS));
}, 120_000);

function load(api) {
  const mod = { exports: {} };
  const req = (name) => {
    if (name === '@plugin-host') return api;
    if (name === '@plugin-host/ui') return kit;
    if (name === 'react' || name === 'react/jsx-runtime' || name === 'react-dom') return require(name);
    throw new Error(`module ${name} is not available`);
  };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
  return mod.exports;
}

let idb;

beforeEach(() => {
  idb = fakeIndexedDB();
  globalThis.indexedDB = idb;
});

function plugin({ specs = [RSA], features = { keystore: true }, handlers = {} } = {}) {
  const ks = fakeKeystore(specs);
  const sent = [];
  const api = fakeApi({
    id: 'smime',
    translations: manifest.locales,
    hostFeatures: features,
    handlers: {
      ...ks.handlers,
      'jmap.sendRaw': async (bytes, identity, options) => { sent.push({ bytes: new Uint8Array(bytes), identity, options }); },
      'ui.rerenderEmail': async () => {},
      'ui.setActions': async () => {},
      ...handlers,
    },
  });
  return { api, ks, sent, ...load(api) };
}

const sendRequest = (over = {}) => ({
  identityId: 'identity', fromEmail: FROM, to: ['someone@example.org'], subject: 'Hi', textBody: 'Hello', sign: true, encrypt: false, ...over,
});

const toasts = (api, kind) => api.calls(`toast.${kind}`).map((c) => c.args[0]);
const en = manifest.locales.en;

async function saveImported() {
  await saveKeyRecord(importedKey);
}

const bodyOf = () => ({ html: '', text: '' });
const encryptedMail = (over = {}) => ({
  id: 'mail-1', contentType: 'application/pkcs7-mime; smime-type=enveloped-data', blobId: 'blob-1', from: ['a@example.org'], ...over,
});
const withMail = (name) => ({ 'jmap.fetchBlob': async () => fixtureBytes(name) });

async function bannerFor(api, id = 'mail-1') {
  const status = await api.storage.get(`verify:${id}`);
  return bannerRows(status, { t: (key, vars) => api.i18n.t(key, vars) })[0];
}

describe('the manifest', () => {
  it('asks for keystore as optional, so older webmails still install it', () => {
    expect(manifest.optionalPermissions).toEqual(['keystore']);
    expect(manifest.permissions).not.toContain('keystore');
    expect(manifest.tier).toBe('privileged');
  });
});

describe('starting up', () => {
  it('does not list, which could bring up the consent dialog', async () => {
    const { api, ks, activate } = plugin();
    await activate(api);
    expect(ks.calls.list).toHaveLength(0);
  });

  it('offers Sign and Encrypt in the composer without listing, as a key may be there', async () => {
    const { api, ks, activate } = plugin();
    await activate(api);
    const [, actions] = api.calls('ui.setActions').at(-1).args;
    expect(actions[0].description).not.toBe(en['compose.noKey']);
    expect(ks.calls.list).toHaveLength(0);
  });

  it('says to import a key without the flag', async () => {
    const { api, activate } = plugin({ features: {} });
    await activate(api);
    const [, actions] = api.calls('ui.setActions').at(-1).args;
    expect(actions[0].description).toBe(en['compose.noKey']);
  });
});

describe('sending', () => {
  it('signs with the OS key, and sends the result', async () => {
    const { ks, sent, hooks } = plugin();
    await expect(hooks.onBeforeEmailSend({ fromEmail: FROM })).resolves.toBe(true);
    await expect(hooks.onComposeSend(sendRequest())).resolves.toBe(false);
    expect(ks.calls.list).toHaveLength(1);
    expect(ks.calls.sign).toHaveLength(1);
    expect(ks.calls.sign[0].scheme).toEqual({ scheme: 'rsa-pkcs1', hash: 'SHA-256' });
    expect(sent).toHaveLength(1);
    const signed = extractDetachedSigned(sent[0].bytes);
    const { status } = await smimeVerifyDetached(signed.signatureDer, signed.entityBytes, FROM);
    expect(status.cryptoValid).toBe(true);
  });

  it('keeps OS keys out of IndexedDB', async () => {
    const { ks, hooks } = plugin();
    await hooks.onComposeSend(sendRequest());
    expect(ks.calls.sign).toHaveLength(1);
    expect([...idb.rows('smime-plugin-store', 'key-records').keys()]).toEqual([]);
    expect([...idb.rows('smime-plugin-store', 'session-keys').keys()]).toEqual([]);
  });

  it('asks for no passphrase with an OS key', async () => {
    const { api, hooks } = plugin();
    await saveImported();
    await hooks.onBeforeEmailSend({ fromEmail: FROM });
    await hooks.onComposeSend(sendRequest());
    expect(api.calls('ui.prompt')).toHaveLength(0);
  });

  it.each([
    ['RSA', RSA, FROM, 'decrypt'],
    ['ECDH', EC, 'smime-ec@example.com', 'agree'],
  ])('can read its own signed and encrypted mail with the same %s OS key', async (_, spec, from, method) => {
    const { ks, sent, hooks } = plugin({ specs: [spec], handlers: { 'jmap.fetchBlob': async () => sent[0].bytes } });
    const recipient = new X509Certificate(fixture('ec-p384-cert.pem')).raw;
    await savePublicCert({ id: 'c', email: 'someone@example.org', certificate: recipient.buffer.slice(recipient.byteOffset, recipient.byteOffset + recipient.byteLength) });
    await expect(hooks.onComposeSend(sendRequest({ encrypt: true, fromEmail: from }))).resolves.toBe(false);
    expect(ks.calls.sign).toHaveLength(1);

    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail({ from: [from] }));
    expect(result.text).toContain('Hello');
    expect(result.verification).toMatchObject({ decryptionSuccess: true, cryptoValid: true });
    expect(ks.calls[method]).toHaveLength(1);
  });

  it('refuses to encrypt without a certificate for the recipient, as before', async () => {
    const { sent, api, hooks } = plugin();
    await expect(hooks.onComposeSend(sendRequest({ encrypt: true }))).resolves.toEqual(ABORT);
    expect(toasts(api, 'error').at(-1)).toContain('someone@example.org');
    expect(sent).toHaveLength(0);
  });

  it('leaves everything to the imported key without the flag', async () => {
    const { api, ks, sent, hooks } = plugin({
      features: {},
      handlers: { 'ui.prompt': async () => ({ pass: STORAGE_PASS }) },
    });
    await saveImported();
    await expect(hooks.onComposeSend(sendRequest())).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    expect(ks.calls.list).toHaveLength(0);
    expect(ks.calls.sign).toHaveLength(0);
    expect(api.calls('ui.prompt')).toHaveLength(1);
  }, 30_000);

  it('uses the imported key when the OS has none for this address', async () => {
    const { ks, sent, hooks, api } = plugin({
      specs: [EC],
      handlers: { 'ui.prompt': async () => ({ pass: STORAGE_PASS }) },
    });
    await saveImported();
    await expect(hooks.onComposeSend(sendRequest())).resolves.toBe(false);
    expect(ks.calls.list).toHaveLength(1);
    expect(ks.calls.sign).toHaveLength(0);
    expect(api.calls('ui.prompt')).toHaveLength(1);
    expect(sent).toHaveLength(1);
  }, 30_000);

  it.each(['keystore:unsupported', 'keystore:failed', 'keystore:not-found'])('falls back to the imported key on %s', async (refusal) => {
    const { ks, sent, api, hooks } = plugin({ handlers: { 'ui.prompt': async () => ({ pass: STORAGE_PASS }) } });
    await saveImported();
    ks.refuse('sign', refusal);
    await expect(hooks.onComposeSend(sendRequest())).resolves.toBe(false);
    expect(ks.calls.sign).toHaveLength(1);
    expect(api.calls('ui.prompt')).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const signed = extractDetachedSigned(sent[0].bytes);
    expect((await smimeVerifyDetached(signed.signatureDer, signed.entityBytes, FROM)).status.cryptoValid).toBe(true);
  }, 30_000);

  it.each([
    ['keystore:cancelled', 'send.osCancelled'],
    ['keystore:locked', 'send.osBusy'],
    ['keystore:invalid', 'send.osFailed'],
    ['keystore:unsupported', 'send.osFailed'],
  ])('on %s with no other key, keeps the draft and says so in plain words', async (refusal, key) => {
    const { ks, sent, api, hooks } = plugin();
    ks.refuse('sign', refusal);
    await expect(hooks.onComposeSend(sendRequest())).resolves.toEqual(ABORT);
    expect(sent).toHaveLength(0);
    expect(toasts(api, 'error')).toEqual([en[key]]);
    expect(toasts(api, 'error')[0]).not.toContain('keystore:');
  });

  it('does not fall back on a No, then signs with the imported key on the next try', async () => {
    const { ks, sent, api, hooks } = plugin({ handlers: { 'ui.prompt': async () => ({ pass: STORAGE_PASS }) } });
    await saveImported();
    ks.refuse('sign', 'keystore:cancelled');
    await expect(hooks.onComposeSend(sendRequest())).resolves.toEqual(ABORT);
    expect(api.calls('ui.prompt')).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const second = await hooks.onComposeSend(sendRequest());
    expect(second).toBe(false);
    expect(ks.calls.sign).toHaveLength(1);
    expect(sent).toHaveLength(1);
  }, 30_000);

  it('goes on without OS keys after a No to the list', async () => {
    const { ks, sent, api, hooks } = plugin({ handlers: { 'ui.prompt': async () => ({ pass: STORAGE_PASS }) } });
    await saveImported();
    ks.refuse('list', 'keystore:cancelled');
    await expect(hooks.onComposeSend(sendRequest())).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    expect(toasts(api, 'error')).toEqual([]);
  }, 30_000);

  it('says there is no key after a No to the list, with no other key', async () => {
    const { ks, api, hooks } = plugin();
    ks.refuse('list', 'keystore:cancelled');
    await expect(hooks.onComposeSend(sendRequest())).resolves.toEqual(ABORT);
    expect(toasts(api, 'error')[0]).toContain(FROM);
  });

  it('waits through a consent dialog that outlasts the RPC timeout', async () => {
    const { ks, sent, hooks } = plugin();
    let tries = 0;
    ks.refuse('list', () => {
      tries += 1;
      if (tries === 1) throw new Error('API call keystore.list timed out after 30s');
    });
    await expect(hooks.onComposeSend(sendRequest())).resolves.toBe(false);
    expect(tries).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it('never throws out of onBeforeEmailSend', async () => {
    const { ks, hooks } = plugin();
    ks.refuse('list', 'keystore:failed');
    await hooks.onBeforeEmailSend({ fromEmail: FROM });
  });

  it('skips the unlock prompt only for an OS key', async () => {
    const { api, hooks } = plugin({ features: {}, handlers: { 'ui.prompt': async () => null } });
    await saveImported();
    await api.storage.set('prefs.v1', { defaultSign: true });
    await expect(hooks.onBeforeEmailSend({ fromEmail: FROM })).resolves.toBe(false);
    expect(api.calls('ui.prompt')).toHaveLength(1);
  });

  it('lists again after sign-out', async () => {
    const { ks, hooks } = plugin();
    await hooks.onComposeSend(sendRequest());
    await hooks.onAfterLogout();
    await hooks.onComposeSend(sendRequest());
    expect(ks.calls.list).toHaveLength(2);
  });
});

describe('reading', () => {
  it.each([
    ['RSA v1.5', 'cbc.p7m', 'decrypt', RSA],
    ['OAEP SHA-1', 'oaep-sha1.p7m', 'decrypt', RSA],
    ['AES-GCM with OAEP SHA-256', 'gcm.p7m', 'decrypt', RSA],
    ['ECDH', 'ec-p256.p7m', 'agree', EC],
  ])('opens %s mail with the OS key', async (_, file, method, spec) => {
    const { api, ks, hooks } = plugin({ specs: [spec], handlers: withMail(file) });
    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(result.handledBy).toBe('smime');
    expect(result.text).toContain(PLAINTEXT);
    expect(result.verification).toMatchObject({ isEncrypted: true, decryptionSuccess: true });
    expect(ks.calls[method]).toHaveLength(1);
    expect((await api.storage.get('verify:mail-1')).decryptionSuccess).toBe(true);
  });

  it('does not list for a message that is only signed', async () => {
    const { ks, hooks } = plugin();
    await hooks.onRenderEmailBody(bodyOf(), { id: 'mail-2', contentType: 'text/plain' });
    expect(ks.calls.list).toHaveLength(0);
  });

  it('leaves the OS alone without the flag', async () => {
    const { api, ks, hooks } = plugin({ features: {}, handlers: withMail('cbc.p7m') });
    await saveImported();
    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(ks.calls.list).toHaveLength(0);
    expect(result.verification.decryptionError).toBe('locked');
    expect((await bannerFor(api)).action).toBe('unlock');
  });

  it('shows a No in the banner with a way to try again, and throws nothing', async () => {
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    ks.refuse('decrypt', 'keystore:cancelled');
    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(result).toMatchObject({ handledBy: 'smime', html: '', text: '' });
    expect(result.verification).toMatchObject({ isEncrypted: true, decryptionSuccess: false, decryptionError: 'os-cancelled' });
    const row = await bannerFor(api);
    expect(row).toMatchObject({ action: 'retry', tone: 'warning', text: en['banner.osCancelled'] });

    ks.allow('decrypt');
    const retried = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(retried.text).toContain(PLAINTEXT);
  });

  it('shows a busy store the same way', async () => {
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    ks.refuse('decrypt', 'keystore:locked');
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(await bannerFor(api)).toMatchObject({ action: 'retry', text: en['banner.osBusy'] });
  });

  it('points to the unlock button after a No when an imported key fits', async () => {
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    await saveImported();
    ks.refuse('decrypt', 'keystore:cancelled');
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect((await bannerFor(api)).action).toBe('unlock');
  });

  it('reads as no fitting key after a No to the list', async () => {
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    ks.refuse('list', 'keystore:cancelled');
    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(result.handledBy).toBe('smime');
    expect((await bannerFor(api)).text).toBe(en['banner.undecryptable']);
    expect(ks.calls.decrypt).toHaveLength(0);
  });

  it('answers inside the hook budget while the consent dialog is up, and renders again after', async () => {
    let answer;
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    ks.refuse('list', () => new Promise((resolve) => { answer = resolve; }));
    const started = Date.now();
    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.verification.decryptionError).toBe('os-pending');
    expect((await bannerFor(api)).text).toBe(en['banner.osPending']);
    expect(api.calls('ui.rerenderEmail')).toHaveLength(0);
    expect(ks.calls.decrypt).toHaveLength(0);

    answer();
    await expect.poll(() => api.calls('ui.rerenderEmail').length).toBe(1);
    const again = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(again.text).toContain(PLAINTEXT);
    expect(ks.calls.list).toHaveLength(1);
  }, 15_000);

  it('shortens the wait by what the hook has already used', async () => {
    let answer;
    const { ks, hooks } = plugin({
      handlers: {
        'jmap.fetchBlob': async () => {
          await new Promise((resolve) => setTimeout(resolve, 3400));
          return fixtureBytes('cbc.p7m');
        },
      },
    });
    ks.refuse('list', () => new Promise((resolve) => { answer = resolve; }));
    const started = Date.now();
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(Date.now() - started).toBeLessThan(4000);
    answer();
  }, 15_000);

  it('still names an algorithm it cannot read', async () => {
    const { api, hooks } = plugin({ handlers: withMail('rc2.p7m') });
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect((await bannerFor(api)).text).toContain('RC2-CBC');
  });
});

describe('an imported key that is already unlocked', () => {
  it('opens the mail with no list and no question', async () => {
    const { api, ks, hooks } = plugin({ handlers: { ...withMail('cbc.p7m'), 'ui.prompt': async () => ({ pass: STORAGE_PASS }) } });
    await saveImported();
    // Signing unlocks it, with the flag off so that the OS isn't asked here.
    const first = plugin({ features: {}, handlers: { 'ui.prompt': async () => ({ pass: STORAGE_PASS }) } });
    await first.hooks.onComposeSend(sendRequest());
    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(result.text).toContain(PLAINTEXT);
    expect(ks.calls.list).toHaveLength(0);
    expect(api.calls('ui.prompt')).toHaveLength(0);
  }, 30_000);
});
