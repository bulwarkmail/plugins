// The sign and decrypt paths with an OS key: the private key stays in a fake
// api.keystore backed by Node crypto, and the plugin's code only ever sees
// signatures and unwrapped keys. Signatures are checked by Node as well as by the
// plugin's verifier, and the mail comes from OpenSSL (fixtures/README.md).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { constants, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { fakeKeystore } from './helpers/fake-keystore.mjs';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { buildAuthEnveloped, flipMacByte, parseCertificatePem } from './helpers/auth-enveloped.mjs';
import { createOsKeys, keystoreCode, osKeyRecord, senderKeys } from '../src/os-keys.js';
import { smimeSign, smimeSignDetached } from '../src/smime-sign.js';
import { smimeVerify, smimeVerifyDetached } from '../src/smime-verify.js';
import { smimeDecrypt, normalizeCmsBytes, SmimeKeyLockedError, UnsupportedAlgorithmError } from '../src/smime-decrypt.js';
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

  it('tries an imported key whatever its stored capabilities say, before a cancelled OS key', () => {
    const flagged = imported({ capabilities: { canSign: false, canEncrypt: false } });
    expect(ids(senderKeys(FROM, [flagged], [os()], (id) => id === 'os:a').signing)).toEqual(['imported', 'os:a']);
    expect(senderKeys(FROM, [flagged], [os({ capabilities: { canSign: true, canEncrypt: false } })]).encrypting.id).toBe('imported');
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

  it('never asks for a SHA-1 signature, which the helper refuses', async () => {
    const { ks } = await signWith([RSA]);
    expect(ks.calls.sign.every((c) => c.scheme.hash !== 'SHA-1')).toBe(true);
    await expect(ks.api.sign(ks.id(), new Uint8Array(20), { scheme: 'rsa-pkcs1', hash: 'SHA-1' })).rejects.toThrow('keystore:unsupported');
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

    it.each(['keystore:unsupported', 'keystore:failed', 'keystore:not-found'])('offers the unlock banner after %s', async (code) => {
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

  it('treats keystore:invalid as a bug, not as a key to fall back from', async () => {
    const { osKeys, records, ks } = await setup([RSA]);
    ks.refuse('decrypt', 'keystore:invalid');
    await expect(decrypt(osKeys, records, bytes('cbc.p7m'))).rejects.toThrow('keystore:invalid');
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
