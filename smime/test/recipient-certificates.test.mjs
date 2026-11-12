// Which certificate an encrypted mail goes to.
//
// - A signer's certificate is stored for the mail's From address only when the signer is
//   verified and the certificate may encrypt.
// - A certificate the user imported comes before one from a signed message, whatever
//   order the store returns them in (the IndexedDB stand-in here returns them in key
//   order, as browsers do).
// - With several candidates, or a certificate from a signed message used for the first
//   time, the user chooses, with issuer, fingerprint, validity and source shown; the
//   answer is kept per address.
// - An expired certificate, one that may not encrypt, or one from a signed message that
//   nobody vouches for (as versions 1.0 to 1.5 stored them) stops the send.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pkijs from 'pkijs';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';
import { fakeKeystore } from './helpers/fake-keystore.mjs';
import { sortedIndexedDB } from './helpers/sorted-indexeddb.mjs';
import { makeCa, makeLeaf, signedCms, opaqueMessage, OPAQUE_SIGNED } from './helpers/test-certificates.mjs';
import { computeFingerprint } from '../src/certificate-utils.js';
import { importPkcs12, unlockPrivateKey } from '../src/pkcs12.js';
import { savePublicCert, listPublicCerts, listKeyRecords, saveTrusted } from '../src/key-storage.js';
import { toHex } from '../src/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const en = manifest.locales.en;
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));

const FROM = 'smime-test@example.com';
const BOB = 'bob@example.org';
const CAROL = 'carol@example.org';
const DAY = 86_400_000;
const ABORT = { abort: true };
const MESSAGE = new TextEncoder().encode('Content-Type: text/plain\r\n\r\nSigned by Bob.\r\n');

let code;
let ca;
let fromMail; // Bob's certificate under a CA the user trusts
let imported; // Bob's certificate the user imported by hand
let other; // another hand-imported certificate for Bob

const serialOf = (made) => toHex(made.cert.serialNumber.valueBlock.valueHexView);
const der = (made) => made.der.buffer.slice(made.der.byteOffset, made.der.byteOffset + made.der.byteLength);

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(here, '../src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    alias: { crypto: path.join(here, '../src/node-crypto-shim.js') },
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  });
  code = out.outputFiles[0].text;
  ca = await makeCa('Example Corp Mail CA');
  fromMail = await makeLeaf(ca, { cn: 'Bob', emails: [BOB] });
  imported = await makeLeaf(null, { cn: 'Bob', emails: [BOB] });
  other = await makeLeaf(null, { cn: 'Bob (laptop)', emails: [BOB] });
}, 120_000);

let idb;
beforeEach(() => {
  idb = sortedIndexedDB();
  globalThis.indexedDB = idb;
});

/** The plugin with an OS key for FROM; `answers` are what the user says to each confirm, in turn. */
function plugin({ answers = [], raw } = {}) {
  const ks = fakeKeystore([{ certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() }]);
  const sent = [];
  const confirms = [];
  const api = fakeApi({
    id: 'smime',
    translations: manifest.locales,
    hostFeatures: { keystore: true },
    handlers: {
      ...ks.handlers,
      'jmap.sendRaw': async (bytes) => { sent.push(new Uint8Array(bytes)); },
      'jmap.fetchBlob': async () => raw,
      'ui.confirm': async (opts) => { confirms.push(opts); return answers.length ? answers.shift() : false; },
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
  return { api, sent, confirms, ...mod.exports };
}

const encryptTo = (hooks, to) => hooks.onComposeSend({
  identityId: 'identity', fromEmail: FROM, to: [to], subject: 'Figures', textBody: 'The figures.', sign: false, encrypt: true,
});

/** The serial numbers of the certificates a sent message was encrypted to (the sender's own excluded). */
function recipientsOf(bytes) {
  const text = new TextDecoder().decode(bytes);
  const body = text.slice(text.indexOf('\r\n\r\n') + 4).replace(/\s/g, '');
  const info = pkijs.ContentInfo.fromBER(Buffer.from(body, 'base64'));
  const env = new pkijs.EnvelopedData({ schema: info.content });
  const own = toHex(pkijs.Certificate.fromBER(new Uint8Array(Buffer.from(fixture('cert.pem').toString().replace(/-----[^-]+-----|\s/g, ''), 'base64'))).serialNumber.valueBlock.valueHexView);
  const serials = [];
  for (const ri of env.recipientInfos) {
    const v = ri.value;
    if (v.rid?.serialNumber) serials.push(toHex(v.rid.serialNumber.valueBlock.valueHexView));
    for (const k of v.recipientEncryptedKeys?.encryptedKeys ?? []) serials.push(toHex(k.rid.value.serialNumber.valueBlock.valueHexView));
  }
  return serials.filter((s) => s !== own);
}

const store = async (made, email, source, extra = {}) => savePublicCert({
  id: extra.id ?? crypto.randomUUID(), email, certificate: der(made), source, fingerprint: await computeFingerprint(made.der), notAfter: made.cert.notAfter.value.toISOString(), ...extra,
});
const trustCa = async () => saveTrusted({ id: 'ca', kind: 'issuer', certificate: der(ca), fingerprint: await computeFingerprint(ca.der) });

describe('a certificate the user imported', () => {
  it('is used, not one from a signed message, whatever order the store returns them in (20 runs)', async () => {
    for (let run = 0; run < 20; run++) {
      globalThis.indexedDB = sortedIndexedDB();
      await trustCa();
      const pair = [() => store(imported, BOB, 'manual'), () => store(fromMail, BOB, 'signed-email')];
      if (run % 2) pair.reverse();
      for (const save of pair) await save();
      const { hooks, sent, confirms } = plugin();
      await expect(encryptTo(hooks, BOB)).resolves.toBe(false);
      expect(recipientsOf(sent[0]), `run ${run}`).toEqual([serialOf(imported)]);
      expect(confirms).toEqual([]);
    }
  }, 120_000);

  it('makes the user choose when there are two, shows what tells them apart, and keeps the answer', async () => {
    await store(imported, BOB, 'manual');
    await store(other, BOB, 'manual');
    const first = plugin({ answers: [false, true] });
    await expect(encryptTo(first.hooks, BOB)).resolves.toBe(false);
    expect(first.confirms).toHaveLength(2);
    expect(first.confirms[0]).toMatchObject({ title: `Certificate for ${BOB}`, confirmLabel: 'Use this certificate', cancelLabel: 'Show the next one' });
    expect(first.confirms[0].message).toContain(`${BOB} has more than one certificate. Encrypt to this one? (1 of 2)`);
    for (const c of first.confirms) expect(c.message).toMatch(/Issuer: CN=Bob.* · SHA-256: [0-9a-f:]{95} · valid until .* · imported/);
    // The one offered second was chosen.
    const chosen = first.confirms[1].message.includes(await computeFingerprint(imported.der)) ? imported : other;
    expect(recipientsOf(first.sent[0])).toEqual([serialOf(chosen)]);

    const again = plugin();
    await expect(encryptTo(again.hooks, BOB)).resolves.toBe(false);
    expect(again.confirms).toEqual([]);
    expect(recipientsOf(again.sent[0])).toEqual([serialOf(chosen)]);

    // Another candidate appears: the user is asked again.
    const third = await makeLeaf(null, { cn: 'Bob (phone)', emails: [BOB] });
    await store(third, BOB, 'manual');
    const later = plugin({ answers: [true] });
    await expect(encryptTo(later.hooks, BOB)).resolves.toBe(false);
    expect(later.confirms.length).toBeGreaterThan(0);
  });

  it('sends nothing when the user takes none of them', async () => {
    await store(imported, BOB, 'manual');
    await store(other, BOB, 'manual');
    const { hooks, sent, api } = plugin({ answers: [false, false] });
    await expect(encryptTo(hooks, BOB)).resolves.toEqual(ABORT);
    expect(sent).toHaveLength(0);
    expect(api.calls('toast.error').at(-1).args[0]).toBe(`Not sent: no certificate chosen for ${BOB}. Your draft is still open.`);
  });
});

describe('a certificate from a signed message', () => {
  const openSigned = async (signed, from) => {
    const p = plugin({ raw: opaqueMessage(signed, from) });
    await p.hooks.onRenderEmailBody({ html: '', text: '' }, { id: 'mail-1', contentType: OPAQUE_SIGNED, blobId: 'raw', from: [{ email: from }] });
    return p;
  };

  it('is stored for a verified signer, with the chain, and shown to the user before its first use', async () => {
    await trustCa();
    const intermediate = await makeCa('Example Corp Issuing CA', { issuer: ca });
    const deep = await makeLeaf(intermediate, { cn: 'Bob', emails: [BOB] });
    await openSigned(await signedCms(MESSAGE, deep, [intermediate.der]), BOB);
    const kept = (await listPublicCerts()).filter((c) => c.email === BOB);
    expect(kept).toEqual([expect.objectContaining({ source: 'signed-email', fingerprint: await computeFingerprint(deep.der) })]);
    expect(kept[0].chain).toHaveLength(1);

    const first = plugin({ answers: [true] });
    await expect(encryptTo(first.hooks, BOB)).resolves.toBe(false);
    expect(first.confirms).toHaveLength(1);
    expect(first.confirms[0].message).toContain(`This certificate for ${BOB} came from a signed message. Encrypt to it?`);
    expect(first.confirms[0].message).toContain(await computeFingerprint(deep.der));
    expect(first.confirms[0].message).toContain('Issuer: CN=Example Corp Issuing CA');
    expect(first.confirms[0].message).toContain('from a signed message');
    expect(recipientsOf(first.sent[0])).toEqual([serialOf(deep)]);

    const again = plugin();
    await expect(encryptTo(again.hooks, BOB)).resolves.toBe(false);
    expect(again.confirms).toEqual([]);
  });

  it('is not used when the user says no to its first use', async () => {
    await trustCa();
    await openSigned(await signedCms(MESSAGE, fromMail), BOB);
    const { hooks, sent } = plugin({ answers: [false] });
    await expect(encryptTo(hooks, BOB)).resolves.toEqual(ABORT);
    expect(sent).toHaveLength(0);
  });

  it('is not stored when the certificate may not encrypt', async () => {
    await trustCa();
    const signOnly = await makeLeaf(ca, { emails: [BOB], keyUsage: ['digitalSignature'] });
    const p = await openSigned(await signedCms(MESSAGE, signOnly), BOB);
    expect((await p.api.storage.get('verify:mail-1')).signerVerified).toBe(true);
    expect(await listPublicCerts()).toEqual([]);
  });

  it('is not stored for another address than the From address', async () => {
    await trustCa();
    const two = await makeLeaf(ca, { emails: [BOB, CAROL] });
    await openSigned(await signedCms(MESSAGE, two), CAROL);
    expect((await listPublicCerts()).map((c) => c.email)).toEqual([CAROL]);
  });

  it('stops counting once the user removes the issuer that vouched for it', async () => {
    await trustCa();
    await openSigned(await signedCms(MESSAGE, fromMail), BOB);
    const { deleteTrusted } = await import('../src/key-storage.js');
    await deleteTrusted('ca');
    const { hooks, sent, api } = plugin({ answers: [true] });
    await expect(encryptTo(hooks, BOB)).resolves.toEqual(ABORT);
    expect(sent).toHaveLength(0);
    expect(api.calls('toast.error').at(-1).args[0]).toContain(BOB);
  });
});

describe('a certificate that may not be used', () => {
  it('stops the send when it has expired, and names the recipient', async () => {
    const expired = await makeLeaf(null, { emails: [BOB], notBefore: new Date(Date.now() - 60 * DAY), notAfter: new Date(Date.now() - DAY) });
    await store(expired, BOB, 'manual');
    const { hooks, sent, api } = plugin();
    await expect(encryptTo(hooks, BOB)).resolves.toEqual(ABORT);
    expect(sent).toHaveLength(0);
    expect(api.calls('toast.error').at(-1).args[0]).toBe(en['send.noUsableCertificate'].replace('{emails}', BOB));
  });

  it('stops the send when it may not encrypt', async () => {
    const signOnly = await makeLeaf(null, { emails: [BOB], keyUsage: ['digitalSignature'] });
    await store(signOnly, BOB, 'manual');
    const { hooks, sent } = plugin();
    await expect(encryptTo(hooks, BOB)).resolves.toEqual(ABORT);
    expect(sent).toHaveLength(0);
  });

  it('is skipped when a usable one is there too', async () => {
    const expired = await makeLeaf(null, { emails: [BOB], notBefore: new Date(Date.now() - 60 * DAY), notAfter: new Date(Date.now() - DAY) });
    await store(expired, BOB, 'manual');
    await store(imported, BOB, 'manual');
    const { hooks, sent, confirms } = plugin();
    await expect(encryptTo(hooks, BOB)).resolves.toBe(false);
    expect(confirms).toEqual([]);
    expect(recipientsOf(sent[0])).toEqual([serialOf(imported)]);
  });
});

describe('what versions 1.0 to 1.5 stored', () => {
  // As 1.5.0 wrote them: no account, no chain; a key record from a PKCS#12 import.
  async function oldStore() {
    const p12 = Uint8Array.from(fixture('test.p12'));
    const { keyRecord } = await importPkcs12(p12.buffer.slice(p12.byteOffset, p12.byteOffset + p12.byteLength), 'fixture', 'storage passphrase');
    idb.put('smime-plugin-store', 'key-records', 'id', keyRecord);
    const carol = await makeLeaf(null, { emails: [CAROL] });
    const unchecked = await makeLeaf(null, { cn: 'Not Bob', emails: [BOB] });
    for (const [made, email, source] of [[carol, CAROL, 'manual'], [unchecked, BOB, 'signed-email']]) {
      idb.put('smime-plugin-store', 'public-certs', 'id', {
        id: crypto.randomUUID(), email, certificate: der(made), issuer: 'CN=x', subject: 'CN=x',
        notBefore: made.cert.notBefore.value.toISOString(), notAfter: made.cert.notAfter.value.toISOString(), fingerprint: await computeFingerprint(made.der), source,
      });
    }
    idb.put('smime-plugin-store', 'session-keys', 'id', { id: 'none' });
    return { keyRecord, carol, unchecked };
  }

  it('opens: the key is still there and unlocks, the imported certificate is used, the unchecked one is not', async () => {
    const { keyRecord, carol } = await oldStore();
    const before = idb.rows('smime-plugin-store', 'key-records');

    const { hooks, sent, api, activate } = plugin();
    await activate(api);
    const [listed] = await listKeyRecords();
    expect(listed.id).toBe(keyRecord.id);
    await expect(unlockPrivateKey(listed, 'storage passphrase')).resolves.toMatchObject({ signingKey: expect.anything() });

    await expect(encryptTo(hooks, CAROL)).resolves.toBe(false);
    expect(recipientsOf(sent[0])).toEqual([serialOf(carol)]);
    await expect(encryptTo(hooks, BOB)).resolves.toEqual(ABORT);
    expect(sent).toHaveLength(1);

    // The private key was not rewritten.
    expect(idb.rows('smime-plugin-store', 'key-records')).toEqual(before);
    // Both certificates are kept.
    expect((await listPublicCerts()).map((c) => c.email).sort()).toEqual([BOB, CAROL]);
  });

  it('uses an unchecked certificate once a trusted issuer vouches for it, after the user saw it', async () => {
    await trustCa();
    idb.put('smime-plugin-store', 'public-certs', 'id', {
      id: 'old', email: BOB, certificate: der(fromMail), fingerprint: await computeFingerprint(fromMail.der), source: 'signed-email',
    });
    const { hooks, sent, confirms } = plugin({ answers: [true] });
    await expect(encryptTo(hooks, BOB)).resolves.toBe(false);
    expect(confirms).toHaveLength(1);
    expect(recipientsOf(sent[0])).toEqual([serialOf(fromMail)]);
  });
});

describe('encrypting to oneself', () => {
  it('needs no stored certificate: the own copy is encrypted to the sender', async () => {
    const { hooks, sent } = plugin();
    await expect(encryptTo(hooks, FROM)).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    expect(recipientsOf(sent[0])).toEqual([]);
  });
});

describe('a stored certificate that does not name the recipient', () => {
  // Stored for Bob, but it names Carol only (as a shared store an older version left may hold one).
  let carols;
  beforeAll(async () => { carols = await makeLeaf(null, { cn: 'Carol', emails: [CAROL] }); });

  it('imported by hand: the user is asked once, with the addresses it names, and the answer is kept', async () => {
    await store(carols, BOB, 'manual');
    const first = plugin({ answers: [true] });
    await expect(encryptTo(first.hooks, BOB)).resolves.toBe(false);
    expect(first.confirms).toHaveLength(1);
    expect(first.confirms[0].message).toContain(`This certificate was imported for ${BOB}, but it names other addresses: ${CAROL}.`);
    expect(first.confirms[0].message).toContain(await computeFingerprint(carols.der));
    expect(recipientsOf(first.sent[0])).toEqual([serialOf(carols)]);

    const again = plugin();
    await expect(encryptTo(again.hooks, BOB)).resolves.toBe(false);
    expect(again.confirms).toEqual([]);
  });

  it('imported by hand and refused: nothing is sent, now or later, and nobody asks again', async () => {
    await store(carols, BOB, 'manual');
    const first = plugin({ answers: [false] });
    await expect(encryptTo(first.hooks, BOB)).resolves.toEqual(ABORT);
    expect(first.sent).toHaveLength(0);
    expect(first.api.calls('toast.error').at(-1).args[0]).toBe(en['send.noUsableCertificate'].replace('{emails}', BOB));
    const again = plugin({ answers: [true] });
    await expect(encryptTo(again.hooks, BOB)).resolves.toEqual(ABORT);
    expect(again.confirms).toEqual([]);
  });

  it('imported by hand and refused: a certificate that names the recipient is still used', async () => {
    await store(carols, BOB, 'manual');
    await store(imported, BOB, 'manual');
    const { hooks, sent, confirms } = plugin({ answers: [false, true] });
    await expect(encryptTo(hooks, BOB)).resolves.toBe(false);
    expect(confirms[0].message).toContain('names other addresses');
    expect(recipientsOf(sent[0])).toEqual([serialOf(imported)]);
  });

  it('asks again for another address', async () => {
    await store(carols, BOB, 'manual');
    await store(carols, 'dan@example.org', 'manual');
    const p = plugin({ answers: [true, true] });
    await expect(encryptTo(p.hooks, BOB)).resolves.toBe(false);
    await expect(encryptTo(p.hooks, 'dan@example.org')).resolves.toBe(false);
    expect(p.confirms).toHaveLength(2);
  });

  it('from a signed message: never used, and nobody is asked', async () => {
    await trustCa();
    const carolUnderCa = await makeLeaf(ca, { cn: 'Carol', emails: [CAROL] });
    await store(carolUnderCa, BOB, 'signed-email');
    const { hooks, sent, confirms } = plugin({ answers: [true] });
    await expect(encryptTo(hooks, BOB)).resolves.toEqual(ABORT);
    expect(sent).toHaveLength(0);
    expect(confirms).toEqual([]);
  });

  it('names the recipient among several addresses: used without a question (control)', async () => {
    const both = await makeLeaf(null, { cn: 'Bob', emails: [CAROL, BOB] });
    await store(both, BOB, 'manual');
    const { hooks, sent, confirms } = plugin();
    await expect(encryptTo(hooks, BOB)).resolves.toBe(false);
    expect(confirms).toEqual([]);
    expect(recipientsOf(sent[0])).toEqual([serialOf(both)]);
  });
});
