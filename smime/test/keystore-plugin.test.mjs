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
    // The DER of the signed attributes, as a SET, and no digest.
    expect(ks.calls.sign[0].signedAttributes[0]).toBe(0x31);
    expect(ks.calls.sign[0].signedAttributes.length).toBeGreaterThan(64);
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
    // Stored for the address the certificate names: a certificate counts only for its own addresses.
    const recipient = new X509Certificate(fixture('ec-p384-cert.pem')).raw;
    await savePublicCert({ id: 'c', email: 'smime-ec@example.com', certificate: recipient.buffer.slice(recipient.byteOffset, recipient.byteOffset + recipient.byteLength) });
    await expect(hooks.onComposeSend(sendRequest({ encrypt: true, fromEmail: from, to: ['smime-ec@example.com'] }))).resolves.toBe(false);
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

  it.each(['keystore:unsupported', 'keystore:failed', 'keystore:not-found', 'keystore:locked'])('falls back to the imported key on %s', async (refusal) => {
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

  it('says the store was refused after a No to the list, not that the address has no key', async () => {
    const { ks, api, hooks } = plugin();
    ks.refuse('list', 'keystore:cancelled');
    await expect(hooks.onComposeSend(sendRequest())).resolves.toEqual(ABORT);
    expect(toasts(api, 'error')).toEqual([en['send.osDenied'].replace('{email}', FROM)]);
  });

  it('says there is no key when the store simply has none', async () => {
    const { api, hooks } = plugin({ specs: [EC] });
    await expect(hooks.onComposeSend(sendRequest())).resolves.toEqual(ABORT);
    expect(toasts(api, 'error')).toEqual([api.i18n.t('send.noKey', { email: FROM })]);
  });

  it('a Deny on a send says the next send asks, and one on a message that it holds for that message', () => {
    expect(en['send.osCancelled']).not.toMatch(/restart/i);
    expect(en['send.osCancelled']).toMatch(/send it again/i);
    expect(en['banner.osCancelled']).toMatch(/this message/i);
    expect(en['send.osBusy']).toMatch(/card is missing or locked/);
    expect(en['banner.osBusy']).toMatch(/card is missing or locked/);
  });

  it('warns about an expired signing certificate, and still sends', async () => {
    const expired = { certificate: fixture('expired-cert.pem').toString(), key: fixture('expired-key.pem').toString() };
    const { api, sent, hooks } = plugin({ specs: [expired] });
    await expect(hooks.onComposeSend(sendRequest({ fromEmail: 'smime-expired@example.com' }))).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    expect(toasts(api, 'warning')).toEqual([en['send.signingCertInvalid']]);
  });

  it('does not warn about a valid signing certificate', async () => {
    const { api, hooks } = plugin();
    await hooks.onComposeSend(sendRequest());
    expect(toasts(api, 'warning')).toEqual([]);
    expect(toasts(api, 'info')).toEqual([]);
  });

  it('warns when the own copy will be unreadable', async () => {
    const { api, sent, hooks } = plugin({ specs: [{ ...EC, canAgree: false }] });
    const recipient = new X509Certificate(fixture('cert.pem')).raw;
    await savePublicCert({ id: 'c', email: 'smime-test@example.com', certificate: recipient.buffer.slice(recipient.byteOffset, recipient.byteOffset + recipient.byteLength) });
    await expect(hooks.onComposeSend(sendRequest({ encrypt: true, fromEmail: 'smime-ec@example.com', to: ['smime-test@example.com'] }))).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    expect(toasts(api, 'warning')).toEqual([en['send.ownCopyUnreadable']]);
  });

  it('says so when a retry signed with the imported key after a No', async () => {
    const { ks, api, hooks } = plugin({ handlers: { 'ui.prompt': async () => ({ pass: STORAGE_PASS }) } });
    await saveImported();
    ks.refuse('sign', 'keystore:cancelled');
    await hooks.onComposeSend(sendRequest());
    expect(toasts(api, 'info')).toEqual([]);
    await hooks.onComposeSend(sendRequest());
    expect(toasts(api, 'info')).toEqual([en['send.usedImportedKey']]);
  }, 30_000);

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
    await api.storage.set('fresh:mail-1', true);
    const retried = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(retried.text).toContain(PLAINTEXT);
  });

  describe('opening a message asks nobody', () => {
    const everyCall = (ks) => [...ks.calls.list.map(([o]) => o), ...ks.calls.decrypt.map((c) => c.options), ...ks.calls.agree.map((c) => c.options)];

    it('with nothing allowed yet, it offers a button and leaves it at that', async () => {
      const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
      ks.nothingAllowed();
      const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
      expect(result).toMatchObject({ handledBy: 'smime', html: '', text: '' });
      expect(result.verification.decryptionError).toBe('os-ask');
      expect(everyCall(ks).every((options) => options?.quiet === true), 'nothing that could open a dialog').toBe(true);
      expect(ks.calls.decrypt).toHaveLength(0);
      expect(await bannerFor(api)).toMatchObject({ action: 'retry', actionLabel: 'banner.openWithSystem', tone: 'info', text: en['banner.osAsk'] });
    });

    it('a list that is allowed still does not unwrap without a word from the user', async () => {
      const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
      ks.onlyListAllowed();
      await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
      expect(ks.calls.decrypt).toHaveLength(1);
      expect(ks.calls.decrypt[0].options).toEqual({ quiet: true });
      expect((await bannerFor(api)).actionLabel).toBe('banner.openWithSystem');
    });

    it('the click may ask, and the message opens', async () => {
      const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
      ks.nothingAllowed();
      await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
      await api.storage.set('fresh:mail-1', true);
      const opened = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
      expect(opened.text).toContain(PLAINTEXT);
      expect(ks.calls.list.at(-1)[0], 'not quiet').toBeUndefined();
      expect(ks.calls.decrypt.at(-1).options).toBeUndefined();
    });

    it('once allowed, the next message opens by itself, still without a call that can ask', async () => {
      const { ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
      const opened = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
      expect(opened.text).toContain(PLAINTEXT);
      expect(ks.calls.decrypt[0].options).toEqual({ quiet: true });
    });

    it('an imported key that needs unlocking keeps its banner while nobody has allowed the list', async () => {
      const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
      await saveImported();
      ks.nothingAllowed();
      const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
      expect(result.verification.decryptionError).toBe('locked');
      expect((await bannerFor(api)).action).toBe('unlock');
    });

    it('with both, the OS key that fits comes first, and a No still ends at the unlock banner', async () => {
      const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
      await saveImported();
      ks.onlyListAllowed();
      const quiet = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
      expect(quiet.verification.decryptionError).toBe('os-ask');
      ks.refuse('decrypt', 'keystore:cancelled');
      await api.storage.set('fresh:mail-1', true);
      const refused = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
      expect(refused.verification.decryptionError).toBe('locked');
    });
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

  it('says the store was refused after a No to the list, with no button that cannot help', async () => {
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    ks.refuse('list', 'keystore:cancelled');
    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(result.handledBy).toBe('smime');
    const row = await bannerFor(api);
    expect(row.text).toBe(en['banner.osListDenied']);
    expect(row.action).toBeUndefined();
    expect(ks.calls.decrypt).toHaveLength(0);
  });

  it.each(['keystore:locked', 'keystore:failed'])('offers a retry after %s on the list, and it works', async (refusal) => {
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    ks.refuse('list', refusal);
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(await bannerFor(api)).toMatchObject({ action: 'retry', text: en['banner.osBusy'] });

    ks.allow('list');
    await api.storage.set('fresh:mail-1', true);
    const again = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(again.text).toContain(PLAINTEXT);
  });

  it('keeps the unlock button when a busy list meets a locked imported key', async () => {
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    await saveImported();
    ks.refuse('list', 'keystore:locked');
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect((await bannerFor(api)).action).toBe('unlock');
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

describe('rendering one message again', () => {
  it('shares a decrypt that is running', async () => {
    const { ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    const [first, second] = await Promise.all([
      hooks.onRenderEmailBody(bodyOf(), encryptedMail()),
      hooks.onRenderEmailBody(bodyOf(), encryptedMail()),
    ]);
    expect(first.text).toContain(PLAINTEXT);
    expect(second.text).toContain(PLAINTEXT);
    expect(ks.calls.decrypt).toHaveLength(1);
  });

  it('shares one that just finished', async () => {
    const { ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    const again = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(again.text).toContain(PLAINTEXT);
    expect(ks.calls.decrypt).toHaveLength(1);
  });

  it('shares a No, so mark-read does not ask for the PIN a second time', async () => {
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    ks.refuse('decrypt', 'keystore:cancelled');
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    const again = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(ks.calls.decrypt).toHaveLength(1);
    expect(again.verification.decryptionError).toBe('os-cancelled');
    expect((await api.storage.get('verify:mail-1')).decryptionError).toBe('os-cancelled');
  });

  it('runs again on a retry', async () => {
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    ks.refuse('decrypt', 'keystore:cancelled');
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    ks.allow('decrypt');
    await api.storage.set('fresh:mail-1', true);
    const again = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(again.text).toContain(PLAINTEXT);
    expect(ks.calls.decrypt).toHaveLength(2);
    expect(await api.storage.get('fresh:mail-1')).toBeFalsy();
  });

  it('keeps other messages apart', async () => {
    const { ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail({ id: 'mail-2', blobId: 'blob-2' }));
    expect(ks.calls.decrypt).toHaveLength(2);
  });

  it('forgets on sign-out', async () => {
    const { ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    await hooks.onAfterLogout();
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(ks.calls.decrypt).toHaveLength(2);
  });

  it('does not hold on to a locked verdict from an imported key', async () => {
    const { api, hooks } = plugin({ features: {}, handlers: { ...withMail('cbc.p7m'), 'ui.prompt': async () => ({ pass: STORAGE_PASS }) } });
    await saveImported();
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect((await bannerFor(api)).action).toBe('unlock');
    await hooks.onComposeSend(sendRequest());
    const again = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(again.text).toContain(PLAINTEXT);
  }, 30_000);
});

describe('the stored status', () => {
  it('says in progress, with a time, before anything is asked of the OS', async () => {
    let during;
    const { api, ks, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    await api.storage.set('verify:mail-1', { isEncrypted: true, decryptionSuccess: true, at: 1 });
    ks.refuse('decrypt', async () => { during = await api.storage.get('verify:mail-1'); });
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(during).toMatchObject({ isEncrypted: true, inProgress: true });
    expect(during.at).toBeGreaterThan(1);
    expect(await api.storage.get('verify:mail-1')).not.toHaveProperty('inProgress');
  });

  it('does not stay in progress when something goes wrong', async () => {
    const { api, hooks } = plugin({ handlers: { 'jmap.fetchBlob': async () => { throw new Error('offline'); } } });
    await expect(hooks.onRenderEmailBody(bodyOf(), encryptedMail())).resolves.toBeUndefined();
    const status = await api.storage.get('verify:mail-1');
    expect(status.inProgress).toBeUndefined();
    expect(status.decryptionSuccess).toBe(false);
  });

  it('carries a time on every verdict', async () => {
    const { api, hooks } = plugin({ handlers: withMail('cbc.p7m') });
    const before = Date.now();
    await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect((await api.storage.get('verify:mail-1')).at).toBeGreaterThanOrEqual(before);
  });
});

describe('decrypted mail without integrity protection', () => {
  const features = { keystore: true, blockExternalContent: true };

  it.each([
    ['AES-CBC with no signature', 'cbc.p7m', true],
    ['AES-CBC with a broken signature', 'cbc-badsig.p7m', true],
    ['AES-CBC with a verified signature', 'cbc-signed.p7m', false],
    ['AES-GCM', 'gcm.p7m', false],
  ])('%s', async (_, file, blocked) => {
    const { api, hooks } = plugin({ features, handlers: withMail(file) });
    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(result.text).toContain('ello from the S/MIME test fixture.'); // the broken one differs in its first letter
    expect(result.blockExternalContent === true).toBe(blocked);
    const status = await api.storage.get('verify:mail-1');
    expect(status.noIntegrity === true).toBe(blocked);
    const notes = bannerRows(status, { t: (key, vars) => api.i18n.t(key, vars) }).filter((row) => row.text === en['banner.noIntegrity']);
    expect(notes).toHaveLength(blocked ? 1 : 0);
  });

  it('asks an older host too, but promises nothing there', async () => {
    const { api, hooks } = plugin({ features: { keystore: true }, handlers: withMail('cbc.p7m') });
    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(result.blockExternalContent).toBe(true);
    expect((await api.storage.get('verify:mail-1')).noIntegrity).toBeUndefined();
  });

  it('applies to an imported key the same way', async () => {
    const { api, hooks } = plugin({ features: { blockExternalContent: true }, handlers: { ...withMail('cbc.p7m'), 'ui.prompt': async () => ({ pass: STORAGE_PASS }) } });
    await saveImported();
    await hooks.onComposeSend(sendRequest());
    const result = await hooks.onRenderEmailBody(bodyOf(), encryptedMail());
    expect(result.text).toContain(PLAINTEXT);
    expect(result.blockExternalContent).toBe(true);
    expect((await api.storage.get('verify:mail-1')).noIntegrity).toBe(true);
  }, 30_000);
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
