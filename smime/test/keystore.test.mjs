// The sign and decrypt paths with an OS key: the private key stays in a fake
// api.keystore backed by Node crypto, and the plugin's code only ever sees
// signatures and unwrapped keys. Signatures are checked by Node as well as by the
// plugin's verifier, and the mail comes from OpenSSL (fixtures/README.md).
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { constants, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { fakeKeystore } from './helpers/fake-keystore.mjs';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { buildAuthEnveloped, flipMacByte, parseCertificatePem } from './helpers/auth-enveloped.mjs';
import { certValidNow, createOsKeys, keystoreCode, osKeyRecord, senderKeys } from '../src/os-keys.js';
import { smimeSign, smimeSignDetached } from '../src/smime-sign.js';
import { smimeVerify, smimeVerifyDetached } from '../src/smime-verify.js';
import { smimeDecrypt, findDecryptionCandidates, normalizeCmsBytes, SmimeKeyLockedError, UnsupportedAlgorithmError } from '../src/smime-decrypt.js';
import { smimeEncrypt } from '../src/smime-encrypt.js';
import { importPkcs12, unlockPrivateKey } from '../src/pkcs12.js';
import { saveKeyRecord, saveSessionKeys } from '../src/key-storage.js';
import { unlockedDecryptMaps } from '../src/session-keys.js';

const path = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const text = (name) => readFileSync(path(name), 'utf8');
const bytes = (name) => {
  const buf = readFileSync(path(name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

const RSA = { certificate: text('cert.pem'), key: text('key.pem') };
const ecFixture = (curve) => ({ certificate: text(`ec-${curve}-cert.pem`), key: text(`ec-${curve}-key.pem`) });
const MESSAGE = new TextEncoder().encode('Content-Type: text/plain; charset=utf-8\r\n\r\nSigned hello.\r\n');
const PLAINTEXT = 'Hello from the S/MIME test fixture.';
const FROM = 'smime-test@example.com';

function envelopeOf(file) {
  const info = new pkijs.ContentInfo({ schema: asn1js.fromBER(normalizeCmsBytes(bytes(file))).result });
  const enveloped = new pkijs.EnvelopedData({ schema: info.content });
  return { info, enveloped, recipient: enveloped.recipientInfos[0].value };
}

async function setup(specs) {
  const ks = fakeKeystore(specs);
  const api = fakeApi({ hostFeatures: { keystore: true }, handlers: ks.handlers });
  const osKeys = createOsKeys(api);
  const { records } = await osKeys.load();
  return { ks, api, osKeys, records };
}

const emptyMaps = () => ({ keyRecords: [], unlockedKeys: new Map(), legacyUnlockedKeys: new Map(), rsaOaepKey: async () => undefined });

async function decrypt(osKeys, records, cms, maps = emptyMaps()) {
  const { mimeBytes, keyRecordId } = await smimeDecrypt({ cmsBytes: normalizeCmsBytes(cms), ...osKeys.addDecryptKeys(maps, records) });
  return { text: new TextDecoder().decode(mimeBytes), keyRecordId };
}

// What was signed, the way a verifier sees it: the signed attributes as a SET OF.
function signedPart(cmsDer) {
  const info = new pkijs.ContentInfo({ schema: asn1js.fromBER(cmsDer).result });
  const signed = new pkijs.SignedData({ schema: info.content });
  const signer = signed.signerInfos[0];
  const attrs = new Uint8Array(signer.signedAttrs.toSchema().toBER(false));
  attrs[0] = 0x31;
  return { signed, signer, attrs, signature: new Uint8Array(signer.signature.valueBlock.valueHexView) };
}

describe('a certificate from the system store as a key record', () => {
  it('has what the UI and the key lookup need, and no key material', async () => {
    const { records, ks } = await setup([RSA]);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      id: `os:${ks.id()}`, source: 'os', osKeyId: ks.id(), email: FROM, emails: [FROM], keyType: 'rsa', algorithm: 'RSA-2048',
      capabilities: { canSign: true, canEncrypt: true },
    });
    expect(record).not.toHaveProperty('encryptedPrivateKey');
    expect(Array.from(new Uint8Array(record.certificate))).toEqual(Array.from(new X509Certificate(RSA.certificate).raw));
  });

  it('calls an EC key without key agreement signing only', async () => {
    const { records } = await setup([{ ...ecFixture('p256'), canAgree: false }]);
    expect(records[0].capabilities).toEqual({ canSign: true, canEncrypt: false });
  });

  it('skips a certificate it cannot read and keeps the others', async () => {
    const [good] = await fakeKeystore([RSA]).api.list();
    const broken = { ...good, id: 'broken', certificate: new Uint8Array([1, 2, 3]) };
    const api = fakeApi({ hostFeatures: { keystore: true }, handlers: { 'keystore.list': async () => [broken, good] } });
    const { records, state } = await createOsKeys(api).load();
    expect(state).toBe('ready');
    expect(records.map((r) => r.email)).toEqual([FROM]);
  });
});

describe('asking for the list', () => {
  it('stays away from the host without the feature flag', async () => {
    for (const hostFeatures of [undefined, {}, { keystore: false }]) {
      const ks = fakeKeystore([RSA]);
      const osKeys = createOsKeys(fakeApi({ hostFeatures, handlers: ks.handlers }));
      expect(osKeys.available()).toBe(false);
      expect(osKeys.unasked()).toBe(false);
      expect(await osKeys.load()).toEqual({ records: [], state: 'off' });
      expect(ks.calls.list).toHaveLength(0);
    }
  });

  it('asks once, including for calls at the same time', async () => {
    const ks = fakeKeystore([RSA]);
    const osKeys = createOsKeys(fakeApi({ hostFeatures: { keystore: true }, handlers: ks.handlers }));
    expect(osKeys.unasked()).toBe(true);
    expect(osKeys.known()).toEqual([]);
    expect(ks.calls.list).toHaveLength(0);
    const [a, b] = await Promise.all([osKeys.load(), osKeys.load()]);
    expect(a.records).toHaveLength(1);
    expect(b.records).toHaveLength(1);
    await osKeys.load();
    expect(ks.calls.list).toHaveLength(1);
    expect(osKeys.known()).toHaveLength(1);
    expect(osKeys.unasked()).toBe(false);
  });

  it.each([
    ['keystore:cancelled', 'denied', 1],
    ['keystore:unsupported', 'unsupported', 1],
    ['keystore:locked', 'busy', 2],
    ['keystore:failed', 'failed', 2],
  ])('after %s reports %s, and asks again only when it may help', async (code, state, asked) => {
    const ks = fakeKeystore([RSA]);
    ks.refuse('list', code);
    const osKeys = createOsKeys(fakeApi({ hostFeatures: { keystore: true }, handlers: ks.handlers }));
    expect(await osKeys.load()).toEqual({ records: [], state });
    await osKeys.load();
    expect(ks.calls.list).toHaveLength(asked);
  });

  it('waits through RPC timeouts while the consent dialog stays up', async () => {
    const ks = fakeKeystore([RSA]);
    let tries = 0;
    ks.refuse('list', () => {
      tries += 1;
      if (tries < 3) throw new Error('API call keystore.list timed out after 30s');
    });
    const osKeys = createOsKeys(fakeApi({ hostFeatures: { keystore: true }, handlers: ks.handlers }));
    const { records, state } = await osKeys.loadPatiently();
    expect(state).toBe('ready');
    expect(records).toHaveLength(1);
    expect(ks.calls.list).toHaveLength(3);
  });

  it('gives up waiting after a bound and says so', async () => {
    const ks = fakeKeystore([RSA]);
    ks.refuse('list', () => { throw new Error('API call keystore.list timed out after 30s'); });
    const osKeys = createOsKeys(fakeApi({ hostFeatures: { keystore: true }, handlers: ks.handlers }));
    expect((await osKeys.loadPatiently()).state).toBe('pending');
    expect(ks.calls.list).toHaveLength(10);
  });

  it('answers within the time given and calls back once the answer comes', async () => {
    const ks = fakeKeystore([RSA]);
    let answer;
    ks.refuse('list', () => new Promise((resolve) => { answer = resolve; }));
    const osKeys = createOsKeys(fakeApi({ hostFeatures: { keystore: true }, handlers: ks.handlers }));
    let late = 0;
    const first = await osKeys.loadWithin(5, () => { late += 1; });
    expect(first).toEqual({ records: [], state: 'pending' });
    // A second message opened meanwhile adds no second callback.
    await osKeys.loadWithin(5, () => { late += 1; });
    expect(late).toBe(0);
    answer();
    await expect.poll(() => late).toBe(1);
    expect(osKeys.known()).toHaveLength(1);
    expect((await osKeys.loadWithin(5, () => { late += 1; })).records).toHaveLength(1);
    expect(ks.calls.list).toHaveLength(1);
    expect(late).toBe(1);
  });

  it('forgets on request and when another frame looked again', async () => {
    const ks = fakeKeystore([RSA]);
    const api = fakeApi({ hostFeatures: { keystore: true }, handlers: ks.handlers });
    const hooksFrame = createOsKeys(api);
    const settingsFrame = createOsKeys(api);
    await hooksFrame.load();
    await settingsFrame.load();
    await settingsFrame.refresh();
    await expect.poll(() => hooksFrame.unasked()).toBe(true);
    await hooksFrame.load();
    expect(ks.calls.list).toHaveLength(4);
    hooksFrame.forget();
    expect(hooksFrame.known()).toEqual([]);
  });

  it('reads the list again when a key has gone from the store', async () => {
    const { osKeys, records, ks } = await setup([RSA]);
    ks.refuse('sign', 'keystore:not-found');
    await expect(smimeSignDetached(MESSAGE, osKeys.signingHandle(records[0]), records[0].certificate)).rejects.toThrow('keystore:not-found');
    expect(osKeys.unasked()).toBe(true);
  });
});

describe('choosing a sender key', () => {
  const imported = (over = {}) => ({ id: 'imported', email: FROM, capabilities: { canSign: true, canEncrypt: true }, ...over });
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const os = (over = {}) => ({ id: 'os:a', source: 'os', email: FROM, emails: [FROM], notAfter: future, capabilities: { canSign: true, canEncrypt: true }, ...over });
  const ids = (list) => list.map((r) => r.id);

  it('prefers the OS key, with the imported one behind it', () => {
    expect(ids(senderKeys(FROM, [imported()], [os()]).signing)).toEqual(['os:a', 'imported']);
  });

  it('keeps the imported key when the OS has none for this address', () => {
    const other = os({ id: 'os:b', email: 'x@example.com', emails: ['x@example.com'] });
    const { signing, encrypting } = senderKeys(FROM, [imported()], [other]);
    expect(ids(signing)).toEqual(['imported']);
    expect(encrypting.id).toBe('imported');
  });

  it('matches any address on an OS certificate, in any case', () => {
    const record = os({ email: 'first@example.com', emails: ['first@example.com', FROM] });
    expect(ids(senderKeys(FROM.toUpperCase(), [], [record]).signing)).toEqual(['os:a']);
  });

  it('puts an expired OS key, or one just cancelled, behind the imported key', () => {
    expect(ids(senderKeys(FROM, [imported()], [os({ notAfter: past })]).signing)).toEqual(['imported', 'os:a']);
    expect(ids(senderKeys(FROM, [imported()], [os()], (id) => id === 'os:a').signing)).toEqual(['imported', 'os:a']);
  });

  it('prefers valid certificates of either kind, and respects notBefore', () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const validImported = imported({ notAfter: future });
    expect(ids(senderKeys(FROM, [validImported], [os({ notBefore: soon })]).signing)).toEqual(['imported', 'os:a']);
    expect(ids(senderKeys(FROM, [imported({ notAfter: past })], [os({ notAfter: past })]).signing)).toEqual(['os:a', 'imported']);
    expect(ids(senderKeys(FROM, [imported({ notAfter: past })], [os({ notAfter: future })]).signing)).toEqual(['os:a', 'imported']);
    const two = [os({ id: 'os:old', notAfter: past }), os({ id: 'os:new' })];
    expect(ids(senderKeys(FROM, [], two).signing)).toEqual(['os:new', 'os:old']);
  });

  it('takes the own copy from a valid certificate that can open it', () => {
    const old = os({ id: 'os:old', notAfter: past });
    const current = os({ id: 'os:new' });
    expect(senderKeys(FROM, [], [old, current]).encrypting.id).toBe('os:new');
    expect(senderKeys(FROM, [imported({ notAfter: future })], [old]).encrypting.id).toBe('imported');
    expect(senderKeys(FROM, [], [old]).encrypting.id).toBe('os:old');
  });

  it('says when nothing for this address can open the own copy', () => {
    const signOnly = os({ capabilities: { canSign: true, canEncrypt: false } });
    expect(senderKeys(FROM, [], [signOnly]).ownCopyReadable).toBe(false);
    expect(senderKeys(FROM, [], [os()]).ownCopyReadable).toBe(true);
    expect(senderKeys(FROM, [imported({ notAfter: past })], [signOnly]).ownCopyReadable).toBe(true);
  });

  it('tries an imported key that says it cannot sign last of all', () => {
    const flagged = imported({ capabilities: { canSign: false, canEncrypt: false } });
    expect(ids(senderKeys(FROM, [flagged], [os()], (id) => id === 'os:a').signing)).toEqual(['os:a', 'imported']);
  });

  it('names what may not be used today', () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    expect(certValidNow({ notBefore: past, notAfter: future })).toBe(true);
    expect(certValidNow({ notBefore: past, notAfter: past })).toBe(false);
    expect(certValidNow({ notBefore: soon, notAfter: future })).toBe(false);
  });

  it('does not sign with an OS key that can only decrypt, but uses it for the own copy', () => {
    const { signing, encrypting } = senderKeys(FROM, [], [os({ capabilities: { canSign: false, canEncrypt: true } })]);
    expect(signing).toEqual([]);
    expect(encrypting.id).toBe('os:a');
  });

  it('takes the own copy from the certificate that can open it, as with a card with two keys', () => {
    const signOnly = os({ id: 'os:sign', capabilities: { canSign: true, canEncrypt: false } });
    const encryptOnly = os({ id: 'os:enc', capabilities: { canSign: false, canEncrypt: true } });
    const { signing, encrypting } = senderKeys(FROM, [], [signOnly, encryptOnly]);
    expect(ids(signing)).toEqual(['os:sign']);
    expect(encrypting.id).toBe('os:enc');
  });

  it('still finds a key for the own copy when none claims it can decrypt', () => {
    const signOnly = os({ capabilities: { canSign: true, canEncrypt: false } });
    expect(senderKeys(FROM, [], [signOnly]).encrypting.id).toBe('os:a');
  });
});

describe('signing with an OS key', () => {
  const publicKey = () => new X509Certificate(RSA.certificate).publicKey;

  async function signWith(specs, signer = smimeSignDetached) {
    const context = await setup(specs);
    const [record] = context.records;
    const handle = context.osKeys.signingHandle(record);
    const result = await signer(MESSAGE, handle, record.certificate, record.certificateChain);
    const der = result instanceof Blob ? new Uint8Array(await result.arrayBuffer()) : result;
    return { ...context, der, record };
  }

  it('asks for the SHA-256 of the DER signed attributes, tagged as a SET OF', async () => {
    const { ks, der } = await signWith([RSA]);
    expect(ks.calls.sign).toHaveLength(1);
    const { id, digest, scheme } = ks.calls.sign[0];
    expect(id).toBe(ks.id());
    expect(scheme).toEqual({ scheme: 'rsa-pkcs1', hash: 'SHA-256' });
    const { attrs } = signedPart(der);
    expect(attrs[0]).toBe(0x31);
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(Array.from(digest)).toEqual(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', attrs))));
  });

  it('writes an RSA PKCS#1 v1.5 signature that Node and the plugin accept', async () => {
    const { der } = await signWith([RSA]);
    const { attrs, signature, signer } = signedPart(der);
    expect(signer.signatureAlgorithm.algorithmId).toBe('1.2.840.113549.1.1.1');
    expect(signer.signatureAlgorithm.algorithmParams).toBeInstanceOf(asn1js.Null);
    expect(verify('sha256', attrs, publicKey(), signature)).toBe(true);
    const { status } = await smimeVerifyDetached(der, MESSAGE, FROM);
    expect(status.cryptoValid).toBe(true);
    expect(status.signerCert.email).toBe(FROM);
  });

  it('does the same for an opaque signature', async () => {
    const { der } = await signWith([RSA], smimeSign);
    const { attrs, signature } = signedPart(der);
    expect(verify('sha256', attrs, publicKey(), signature)).toBe(true);
    const { status, mimeBytes } = await smimeVerify(der, FROM);
    expect(status.cryptoValid).toBe(true);
    expect(Array.from(mimeBytes)).toEqual(Array.from(MESSAGE));
  });

  it('signs with PSS only when the key has nothing else', async () => {
    const { ks, der } = await signWith([{ ...RSA, signSchemes: ['rsa-pss'] }]);
    expect(ks.calls.sign[0].scheme).toEqual({ scheme: 'rsa-pss', hash: 'SHA-256' });
    const { attrs, signature, signer } = signedPart(der);
    expect(signer.signatureAlgorithm.algorithmId).toBe('1.2.840.113549.1.1.10');
    const key = { key: publicKey(), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
    expect(verify('sha256', attrs, key, signature)).toBe(true);
    expect((await smimeVerifyDetached(der, MESSAGE, FROM)).status.cryptoValid).toBe(true);
  });

  it.each(['p256', 'p384', 'p521'])('keeps the ECDSA signature as the OS gives it, on %s', async (curve) => {
    const spec = ecFixture(curve);
    const { der, ks } = await signWith([spec]);
    expect(ks.calls.sign[0].scheme).toEqual({ scheme: 'ecdsa', hash: 'SHA-256' });
    const { attrs, signature, signer } = signedPart(der);
    expect(signer.signatureAlgorithm.algorithmId).toBe('1.2.840.10045.4.3.2');
    // One DER SEQUENCE: converted twice it would no longer be one.
    expect(signature[0]).toBe(0x30);
    expect(verify('sha256', attrs, new X509Certificate(spec.certificate).publicKey, signature)).toBe(true);
    expect((await smimeVerifyDetached(der, MESSAGE, 'smime-ec@example.com')).status.cryptoValid).toBe(true);
  });

  it('embeds the chain the OS reports', async () => {
    const intermediate = new X509Certificate(ecFixture('p256').certificate).raw;
    const { der } = await signWith([{ ...RSA, chain: [intermediate] }]);
    const { signed } = signedPart(der);
    expect(signed.certificates).toHaveLength(2);
    const embedded = new Uint8Array(signed.certificates[1].toSchema(true).toBER(false));
    expect(Array.from(embedded)).toEqual(Array.from(intermediate));
  });

  it.each([
    ['RSA', RSA],
    ['PSS', { ...RSA, signSchemes: ['rsa-pss'] }],
    ['ECDSA', ecFixture('p521')],
  ])('asks for SHA-256 and a 32-byte digest with %s, never for SHA-1', async (_, spec) => {
    const { ks } = await signWith([spec]);
    expect(ks.calls.sign.map((c) => [c.scheme.hash, c.digest.length])).toEqual([['SHA-256', 32]]);
  });

  it('passes the code on, and remembers a cancel for the next choice', async () => {
    const { osKeys, records, ks } = await setup([RSA]);
    const [record] = records;
    ks.refuse('sign', 'keystore:cancelled');
    const err = await smimeSignDetached(MESSAGE, osKeys.signingHandle(record), record.certificate).catch((e) => e);
    expect(keystoreCode(err)).toBe('cancelled');
    expect(osKeys.signCancelled(record.id)).toBe(true);
  });
});

describe('decrypting with an OS key', () => {
  it.each([
    ['EnvelopedData with RSA PKCS#1 v1.5', 'cbc.p7m', { scheme: 'rsa-pkcs1' }],
    ['EnvelopedData with OAEP SHA-1', 'oaep-sha1.p7m', { scheme: 'rsa-oaep', hash: 'SHA-1' }],
    ['AuthEnvelopedData with OAEP SHA-256', 'gcm.p7m', { scheme: 'rsa-oaep', hash: 'SHA-256' }],
  ])('reads %s, taking the scheme from the message', async (_, file, scheme) => {
    const { osKeys, records, ks } = await setup([RSA]);
    const { text: mime, keyRecordId } = await decrypt(osKeys, records, bytes(file));
    expect(mime).toContain(PLAINTEXT);
    expect(keyRecordId).toBe(records[0].id);
    expect(ks.calls.decrypt).toHaveLength(1);
    expect(ks.calls.decrypt[0].scheme).toEqual(scheme);
    expect(ks.calls.decrypt[0].data).toBeInstanceOf(Uint8Array);
  });

  it('checks the AuthEnvelopedData mac on what the OS unwrapped', async () => {
    const { osKeys, records } = await setup([RSA]);
    const der = normalizeCmsBytes(bytes('gcm.p7m'));
    await expect(decrypt(osKeys, records, flipMacByte(der))).rejects.toThrow('Failed to decrypt message with any available key');
  });

  it('passes an OAEP label on', async () => {
    const { osKeys, records, ks } = await setup([RSA]);
    const cert = parseCertificatePem(RSA.certificate);
    const label = new Uint8Array([9, 8, 7]);
    const der = await buildAuthEnveloped(cert, { plaintext: new TextEncoder().encode(PLAINTEXT), oaepLabel: label });
    const { text: mime } = await decrypt(osKeys, records, der);
    expect(mime).toContain(PLAINTEXT);
    expect(Array.from(ks.calls.decrypt[0].scheme.label)).toEqual(Array.from(label));
  });

  it('asks once per key, however many recipient entries name it', async () => {
    const { osKeys, records, ks } = await setup([RSA]);
    ks.refuse('decrypt', 'keystore:failed');
    const der = normalizeCmsBytes(bytes('cbc.p7m'));
    const info = new pkijs.ContentInfo({ schema: asn1js.fromBER(der).result });
    const enveloped = new pkijs.EnvelopedData({ schema: info.content });
    const entry = enveloped.recipientInfos[0];
    enveloped.recipientInfos.push(entry, entry, entry);
    const padded = new pkijs.ContentInfo({ contentType: info.contentType, content: enveloped.toSchema() }).toSchema().toBER(false);
    await expect(decrypt(osKeys, records, padded)).rejects.toThrow('Failed to decrypt');
    expect(ks.calls.decrypt).toHaveLength(1);
  });

  describe('falling back', () => {
    let imported;
    let idb;

    beforeAll(async () => {
      ({ keyRecord: imported } = await importPkcs12(bytes('test.p12'), 'fixture', 'storage'));
    }, 60_000);

    beforeEach(async () => {
      idb = fakeIndexedDB();
      globalThis.indexedDB = idb;
      await saveKeyRecord(imported);
    });

    const unlock = async () => saveSessionKeys({ id: imported.id, ...(await unlockPrivateKey(imported, 'storage')) });

    it('uses an unlocked imported key without asking the OS', async () => {
      await unlock();
      const { osKeys, records, ks } = await setup([RSA]);
      const { keyRecordId } = await decrypt(osKeys, records, bytes('cbc.p7m'), await unlockedDecryptMaps());
      expect(keyRecordId).toBe(imported.id);
      expect(ks.calls.decrypt).toHaveLength(0);
    }, 30_000);

    it('uses the OS key when the imported one is locked', async () => {
      const { osKeys, records, ks } = await setup([RSA]);
      const { keyRecordId } = await decrypt(osKeys, records, bytes('cbc.p7m'), await unlockedDecryptMaps());
      expect(keyRecordId).toBe(records[0].id);
      expect(ks.calls.decrypt).toHaveLength(1);
    }, 30_000);

    it.each(['keystore:unsupported', 'keystore:failed', 'keystore:not-found', 'keystore:invalid', 'keystore:locked'])('offers the unlock banner after %s', async (code) => {
      const { osKeys, records, ks } = await setup([RSA]);
      ks.refuse('decrypt', code);
      await expect(decrypt(osKeys, records, bytes('cbc.p7m'), await unlockedDecryptMaps())).rejects.toBeInstanceOf(SmimeKeyLockedError);
    }, 30_000);

    it('offers the unlock banner over a No from the user, when there is a key to unlock', async () => {
      const { osKeys, records, ks } = await setup([RSA]);
      ks.refuse('decrypt', 'keystore:cancelled');
      await expect(decrypt(osKeys, records, bytes('cbc.p7m'), await unlockedDecryptMaps())).rejects.toBeInstanceOf(SmimeKeyLockedError);
    }, 30_000);
  });

  it.each(['keystore:cancelled', 'keystore:locked'])('hands %s to the caller when there is nothing else', async (code) => {
    for (const file of ['cbc.p7m', 'gcm.p7m']) {
      const { osKeys, records, ks } = await setup([RSA]);
      ks.refuse('decrypt', code);
      await expect(decrypt(osKeys, records, bytes(file))).rejects.toThrow(code);
      expect(ks.calls.decrypt).toHaveLength(1);
    }
  });

  it('treats keystore:invalid on an unwrap as a failure, like a mangled message', async () => {
    const { osKeys, records, ks } = await setup([RSA]);
    ks.refuse('decrypt', 'keystore:invalid');
    await expect(decrypt(osKeys, records, bytes('cbc.p7m'))).rejects.toThrow('Failed to decrypt message with any available key');
    expect(ks.calls.decrypt).toHaveLength(1);
  });

  it('names what the plugin cannot read, before bothering the OS', async () => {
    const { osKeys, records, ks } = await setup([RSA]);
    const err = await decrypt(osKeys, records, bytes('rc2.p7m')).catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedAlgorithmError);
    expect(ks.calls.decrypt).toHaveLength(0);
  });
});

describe('ECDH mail', () => {
  it.each(['p256', 'p384', 'p521'])('opens with an OS key on %s, through agree', async (curve) => {
    const { osKeys, records, ks } = await setup([ecFixture(curve)]);
    const { text: mime } = await decrypt(osKeys, records, bytes(`ec-${curve}.p7m`));
    expect(mime).toContain(PLAINTEXT);
    expect(ks.calls.agree).toHaveLength(1);
    // The message's ephemeral key as an SPKI, ready for the helper's curve check.
    const peer = createPublicKey({ key: Buffer.from(ks.calls.agree[0].peerSpki), format: 'der', type: 'spki' });
    expect(peer.asymmetricKeyType).toBe('ec');
  });

  it('opens with an imported .p12 too, which it never could', async () => {
    globalThis.indexedDB = fakeIndexedDB();
    const { keyRecord } = await importPkcs12(bytes('ec-p256.p12'), 'fixture', 'storage');
    await saveKeyRecord(keyRecord);
    await saveSessionKeys({ id: keyRecord.id, ...(await unlockPrivateKey(keyRecord, 'storage')) });
    const { mimeBytes } = await smimeDecrypt({ cmsBytes: normalizeCmsBytes(bytes('ec-p256.p7m')), ...(await unlockedDecryptMaps()) });
    expect(new TextDecoder().decode(mimeBytes)).toContain(PLAINTEXT);
  }, 30_000);

  it('finds its key when another recipient comes first in the same entry', async () => {
    const { osKeys, records } = await setup([ecFixture('p256')]);
    const der = normalizeCmsBytes(bytes('ec-p256.p7m'));
    const info = new pkijs.ContentInfo({ schema: asn1js.fromBER(der).result });
    const enveloped = new pkijs.EnvelopedData({ schema: info.content });
    const { encryptedKeys } = enveloped.recipientInfos[0].value.recipientEncryptedKeys;
    const other = new pkijs.RecipientEncryptedKey({ schema: asn1js.fromBER(encryptedKeys[0].toSchema().toBER(false)).result });
    other.rid.value.serialNumber = new asn1js.Integer({ value: 12345 });
    other.encryptedKey = new asn1js.OctetString({ valueHex: new Uint8Array(40).buffer });
    encryptedKeys.unshift(other);
    const twoKeys = new pkijs.ContentInfo({ contentType: info.contentType, content: enveloped.toSchema() }).toSchema().toBER(false);
    const { text: mime } = await decrypt(osKeys, records, twoKeys);
    expect(mime).toContain(PLAINTEXT);
  });

  it.each([
    ['SHA-1 KDF', 'ec-p256-kdf-sha1.p7m', '1.3.133.16.840.63.0.2'],
    ['SHA-384 KDF', 'ec-p256-kdf-sha384.p7m', '1.3.132.1.11.2'],
    ['SHA-512 KDF', 'ec-p256-kdf-sha512.p7m', '1.3.132.1.11.3'],
    ['AES-128 key wrap', 'ec-p256-wrap128.p7m', '1.3.132.1.11.1'],
    ['AES-192 key wrap', 'ec-p256-wrap192.p7m', '1.3.132.1.11.1'],
    ['a subject key id for the recipient', 'ec-p256-keyid.p7m', '1.3.132.1.11.1'],
  ])('opens OpenSSL mail with %s', async (_, file, schemeOid) => {
    const { osKeys, records } = await setup([ecFixture('p256')]);
    const { recipient } = envelopeOf(file);
    expect(recipient.keyEncryptionAlgorithm.algorithmId).toBe(schemeOid);
    const { text: mime } = await decrypt(osKeys, records, bytes(file));
    expect(mime).toContain(PLAINTEXT);
  });

  it('opens mail with a UKM, which goes into the derived key', async () => {
    const { osKeys, records, ks } = await setup([ecFixture('p256')]);
    const blob = await smimeEncrypt(new TextEncoder().encode(PLAINTEXT), [], records[0].certificate);
    const der = await blob.arrayBuffer();
    const recipient = new pkijs.EnvelopedData({ schema: new pkijs.ContentInfo({ schema: asn1js.fromBER(der).result }).content }).recipientInfos[0].value;
    expect(recipient.ukm).toBeDefined();
    expect((await decrypt(osKeys, records, der)).text).toBe(PLAINTEXT);
    expect(ks.calls.agree).toHaveLength(1);
  });

  it('fails on a wrapped key with a flipped byte, as AES key wrap has a check value', async () => {
    const { osKeys, records, ks } = await setup([ecFixture('p256')]);
    const { info, enveloped, recipient } = envelopeOf('ec-p256.p7m');
    const encrypted = recipient.recipientEncryptedKeys.encryptedKeys[0];
    const wrapped = new Uint8Array(encrypted.encryptedKey.valueBlock.valueHexView);
    wrapped[3] ^= 0x01;
    encrypted.encryptedKey = new asn1js.OctetString({ valueHex: wrapped.buffer });
    const cms = new pkijs.ContentInfo({ contentType: info.contentType, content: enveloped.toSchema() }).toSchema().toBER(false);
    await expect(decrypt(osKeys, records, cms)).rejects.toThrow('Failed to decrypt message with any available key');
    expect(ks.calls.agree).toHaveLength(1);
  });

  describe('a point the OS should never see', () => {
    function withPoint(point, params) {
      const { info, enveloped, recipient } = envelopeOf('ec-p256.p7m');
      recipient.originator.value.publicKey = new asn1js.BitString({ valueHex: point.buffer.slice(point.byteOffset, point.byteOffset + point.byteLength) });
      if (params) recipient.originator.value.algorithm.algorithmParams = new asn1js.ObjectIdentifier({ value: params });
      return new pkijs.ContentInfo({ contentType: info.contentType, content: enveloped.toSchema() }).toSchema().toBER(false);
    }
    const realPoint = (file) => new Uint8Array(envelopeOf(file).recipient.originator.value.publicKey.valueBlock.valueHexView);

    it('leaves an off-curve point out', async () => {
      const { osKeys, records, ks } = await setup([ecFixture('p256')]);
      const point = realPoint('ec-p256.p7m');
      point[point.length - 1] ^= 0x01;
      await expect(decrypt(osKeys, records, withPoint(point))).rejects.toThrow('Failed to decrypt');
      expect(ks.calls.agree).toHaveLength(0);
    });

    it('leaves a point from another curve out', async () => {
      const { osKeys, records, ks } = await setup([ecFixture('p256')]);
      await expect(decrypt(osKeys, records, withPoint(realPoint('ec-p384.p7m')))).rejects.toThrow('Failed to decrypt');
      expect(ks.calls.agree).toHaveLength(0);
    });

    it('leaves a key that names another curve than the certificate out', async () => {
      const { osKeys, records, ks } = await setup([ecFixture('p256')]);
      await expect(decrypt(osKeys, records, withPoint(realPoint('ec-p256.p7m'), '1.3.132.0.34'))).rejects.toThrow('Failed to decrypt');
      expect(ks.calls.agree).toHaveLength(0);
    });

    it('applies to imported keys too', async () => {
      globalThis.indexedDB = fakeIndexedDB();
      const { keyRecord } = await importPkcs12(bytes('ec-p256.p12'), 'fixture', 'storage');
      await saveKeyRecord(keyRecord);
      await saveSessionKeys({ id: keyRecord.id, ...(await unlockPrivateKey(keyRecord, 'storage')) });
      const point = realPoint('ec-p256.p7m');
      point[point.length - 1] ^= 0x01;
      await expect(smimeDecrypt({ cmsBytes: withPoint(point), ...(await unlockedDecryptMaps()) })).rejects.toThrow('Failed to decrypt');
    }, 30_000);
  });

  it('leaves an EC key without key agreement out, and says no key fits', async () => {
    const { osKeys, records, ks } = await setup([{ ...ecFixture('p256'), canAgree: false }]);
    await expect(decrypt(osKeys, records, bytes('ec-p256.p7m'))).rejects.toThrow('No imported S/MIME key matches');
    expect(ks.calls.agree).toHaveLength(0);
  });

  it('opens AuthEnvelopedData too', async () => {
    const { osKeys, records, ks } = await setup([ecFixture('p256')]);
    const { text: mime } = await decrypt(osKeys, records, bytes('ec-p256-gcm.p7m'));
    expect(mime).toContain(PLAINTEXT);
    expect(ks.calls.agree).toHaveLength(1);
  });

  it('asks once, and hands a No to the caller', async () => {
    const { osKeys, records, ks } = await setup([ecFixture('p256')]);
    ks.refuse('agree', 'keystore:cancelled');
    await expect(decrypt(osKeys, records, bytes('ec-p256.p7m'))).rejects.toThrow('keystore:cancelled');
    expect(ks.calls.agree).toHaveLength(1);
  });

  it('reads as a failure when the OS fails', async () => {
    const { osKeys, records, ks } = await setup([ecFixture('p256')]);
    ks.refuse('agree', () => { throw new Error('keystore:failed'); });
    await expect(decrypt(osKeys, records, bytes('ec-p256.p7m'))).rejects.toThrow('Failed to decrypt');
  });
});

describe('a hostile recipient list', () => {
  const COPIES = 300;

  function padded(file) {
    const { info, enveloped } = envelopeOf(file);
    const entry = enveloped.recipientInfos[0];
    for (let i = 0; i < COPIES; i++) enveloped.recipientInfos.push(entry);
    return new pkijs.ContentInfo({ contentType: info.contentType, content: enveloped.toSchema() }).toSchema().toBER(false);
  }

  class CountingMap extends Map {
    gets = 0;
    get(key) { this.gets += 1; return super.get(key); }
  }

  it('parses each certificate once, and matches each key once', () => {
    let reads = 0;
    const der = new X509Certificate(RSA.certificate).raw;
    const certificate = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength);
    const record = { id: 'k', get certificate() { reads += 1; return certificate; } };
    const other = { id: 'other', get certificate() { reads += 1; return new X509Certificate(ecFixture('p256').certificate).raw; } };
    expect(findDecryptionCandidates(padded('cbc.p7m'), [record, other])).toEqual(['k']);
    expect(reads).toBeLessThanOrEqual(2);
  }, 60_000);

  it('tries an imported key once', async () => {
    const unlockedKeys = new CountingMap();
    const legacyUnlockedKeys = new CountingMap();
    const der = new X509Certificate(RSA.certificate).raw;
    const record = { id: 'k', certificate: der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) };
    const notAKey = { algorithm: { name: 'RSA-OAEP', hash: { name: 'SHA-256' } } };
    unlockedKeys.set('k', notAKey);
    await expect(smimeDecrypt({ cmsBytes: padded('cbc.p7m'), keyRecords: [record], unlockedKeys, legacyUnlockedKeys })).rejects.toThrow('Failed to decrypt');
    expect(unlockedKeys.gets).toBeLessThanOrEqual(4);
  }, 60_000);

  it('tries each key once in a message with integrity too', async () => {
    const rsaOaepKey = vi.fn(async () => undefined);
    const der = new X509Certificate(RSA.certificate).raw;
    const record = { id: 'k', certificate: der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) };
    const info = new pkijs.ContentInfo({ schema: asn1js.fromBER(normalizeCmsBytes(bytes('gcm.p7m'))).result });
    const items = info.content.valueBlock.value;
    const set = items.find((el) => el instanceof asn1js.Set);
    const first = set.valueBlock.value[0];
    for (let i = 0; i < COPIES; i++) set.valueBlock.value.push(first);
    const cms = info.toSchema().toBER(false);
    await expect(smimeDecrypt({ cmsBytes: cms, keyRecords: [record], unlockedKeys: new Map(), legacyUnlockedKeys: new Map(), rsaOaepKey })).rejects.toThrow();
    expect(rsaOaepKey).toHaveBeenCalledTimes(1);
  }, 60_000);
});

describe('integrity of what was decrypted', () => {
  it.each([
    ['AES-CBC EnvelopedData', 'cbc.p7m', false],
    ['AES-GCM AuthEnvelopedData', 'gcm.p7m', true],
  ])('%s', async (_, file, integrity) => {
    const { osKeys, records } = await setup([RSA]);
    const { mimeBytes } = await smimeDecrypt({ cmsBytes: normalizeCmsBytes(bytes(file)), ...osKeys.addDecryptKeys(emptyMaps(), records) });
    expect(mimeBytes.length).toBeGreaterThan(0);
    const result = await smimeDecrypt({ cmsBytes: normalizeCmsBytes(bytes(file)), ...osKeys.addDecryptKeys(emptyMaps(), records) });
    expect(result.integrity).toBe(integrity);
  });

  it('counts AES-GCM in EnvelopedData, as this plugin sends it', async () => {
    const { osKeys, records } = await setup([RSA]);
    const blob = await smimeEncrypt(new TextEncoder().encode(PLAINTEXT), [], records[0].certificate);
    const result = await smimeDecrypt({ cmsBytes: await blob.arrayBuffer(), ...osKeys.addDecryptKeys(emptyMaps(), records) });
    expect(result.integrity).toBe(true);
  });
});

describe('osKeyRecord', () => {
  it('copies the certificate out of whatever view the bridge hands over', async () => {
    const raw = new X509Certificate(RSA.certificate).raw;
    const padded = new Uint8Array(raw.length + 8);
    padded.set(raw, 4);
    const view = padded.subarray(4, 4 + raw.length);
    const record = await osKeyRecord({ id: 'x', certificate: view, chain: [], keyType: 'rsa', signSchemes: ['rsa-pkcs1'] });
    expect(record.certificate.byteLength).toBe(raw.length);
    expect(record.email).toBe(FROM);
    expect(record.capabilities).toEqual({ canSign: true, canEncrypt: false });
  });
});
