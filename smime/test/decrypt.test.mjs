// Decrypting real CMS messages the way the plugin does it: import the
// fixture .p12, unlock it, keep the unlocked keys in the session store
// (IndexedDB, here a structured-clone stand-in) and decrypt with what comes
// back out. Fixtures: test/fixtures/README.md.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { importPkcs12, unlockPrivateKey } from '../src/pkcs12.js';
import { saveKeyRecord, saveSessionKeys, deleteSessionKeys } from '../src/key-storage.js';
import { unlockedDecryptMaps } from '../src/session-keys.js';
import { smimeDecrypt, normalizeCmsBytes, SmimeKeyLockedError, UnsupportedAlgorithmError } from '../src/smime-decrypt.js';
import { detectSmime } from '../src/smime-detect.js';
import { bannerRows } from '../src/ui.js';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import {
  buildAuthEnveloped, stalwartMessage, flipMacByte, parseCertificatePem, addSealer, OID_CHACHA20_POLY1305,
} from './helpers/auth-enveloped.mjs';

const fixture = (name) => {
  const buf = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};
const PLAINTEXT = 'Hello from the S/MIME test fixture.';
const MESSAGE = new TextEncoder().encode(`Content-Type: text/plain; charset=utf-8\r\n\r\n${PLAINTEXT}\r\n`);
const cert = parseCertificatePem(readFileSync(fileURLToPath(new URL('./fixtures/cert.pem', import.meta.url)), 'utf8'));
const FAILED = 'Failed to decrypt message with any available key';
const STORAGE_PASS = 'storage passphrase';

let keyRecord;
let idb;

beforeAll(async () => {
  ({ keyRecord } = await importPkcs12(fixture('test.p12'), 'fixture', STORAGE_PASS));
}, 60_000);

beforeEach(async () => {
  idb = fakeIndexedDB();
  globalThis.indexedDB = idb;
  await saveKeyRecord(keyRecord);
});

async function unlock() {
  const unlocked = await unlockPrivateKey(keyRecord, STORAGE_PASS);
  await saveSessionKeys({ id: keyRecord.id, ...unlocked });
}

async function decrypt(cms) {
  const { mimeBytes } = await smimeDecrypt({ cmsBytes: normalizeCmsBytes(cms), ...(await unlockedDecryptMaps()) });
  return new TextDecoder().decode(mimeBytes);
}

describe('decrypting after the session store round trip', () => {
  it('reads AES-256-CBC mail whose key is wrapped with RSA PKCS#1 v1.5', async () => {
    await unlock();
    const text = await decrypt(fixture('cbc.p7m'));
    expect(text).toMatch(/^Content-Type: text\/plain; charset=utf-8\r\n\r\n/);
    expect(text).toContain(PLAINTEXT);
  }, 30_000);

  it('keeps no webcrypto-liner key in the session store', async () => {
    await unlock();
    await decrypt(fixture('cbc.p7m'));
    const stored = idb.rows('smime-plugin-store', 'session-keys').get(keyRecord.id);
    expect(stored).toBeDefined();
    // The liner key is a plain JS object holding the raw RSA key.
    expect(stored).not.toHaveProperty('legacyDecryptionKey');
    expect(stored.sealedPkcs8.key).toBeInstanceOf(CryptoKey);
    expect(stored.sealedPkcs8.key.extractable).toBe(false);
  }, 30_000);

  it('asks to unlock again once the key is locked, although this iframe decrypted with it before', async () => {
    await unlock();
    await decrypt(fixture('cbc.p7m'));
    await deleteSessionKeys(keyRecord.id);
    await expect(decrypt(fixture('cbc.p7m'))).rejects.toBeInstanceOf(SmimeKeyLockedError);
  }, 30_000);

  it('treats a session entry written by an older version as locked', async () => {
    const { signingKey, decryptionKey } = await unlockPrivateKey(keyRecord, STORAGE_PASS);
    idb.rows('smime-plugin-store', 'session-keys').set(keyRecord.id, {
      id: keyRecord.id, signingKey, decryptionKey, legacyDecryptionKey: { algorithm: { name: 'RSAES-PKCS1-v1_5' } },
    });
    await expect(decrypt(fixture('cbc.p7m'))).rejects.toBeInstanceOf(SmimeKeyLockedError);
  }, 30_000);
});

// smime 1.5.0 and earlier sent AES-256-GCM inside EnvelopedData, with the key
// wrapped with RSA-OAEP SHA-256. Other clients can't open that, but Sent
// folders are full of it, so it has to keep opening here.
describe('mail sent by smime 1.5.0 and earlier', () => {
  it('opens with an imported key and counts as integrity protected', async () => {
    await unlock();
    const result = await smimeDecrypt({ cmsBytes: normalizeCmsBytes(fixture('plugin-gcm.p7m')), ...(await unlockedDecryptMaps()) });
    expect(new TextDecoder().decode(result.mimeBytes)).toBe(new TextDecoder().decode(MESSAGE));
    expect(result.integrity).toBe(true);
  }, 30_000);
});

describe('AES-256-GCM AuthEnvelopedData', () => {
  beforeEach(unlock);

  it('reads the OpenSSL fixture', async () => {
    const text = await decrypt(fixture('gcm.p7m'));
    expect(text).toMatch(/^Content-Type: text\/plain; charset=utf-8\r\n\r\n/);
    expect(text).toContain(PLAINTEXT);
  }, 30_000);

  it('reads it as Stalwart stores it', async () => {
    const der = await buildAuthEnveloped(cert, { plaintext: MESSAGE });
    expect(await decrypt(stalwartMessage(der))).toContain(PLAINTEXT);
  }, 30_000);

  it('refuses the message once a mac byte is changed', async () => {
    const der = normalizeCmsBytes(fixture('gcm.p7m'));
    expect(await decrypt(der)).toContain(PLAINTEXT);
    await expect(decrypt(flipMacByte(der))).rejects.toThrow(FAILED);
  }, 30_000);

  it('authenticates the authAttrs along with the content', async () => {
    expect(await decrypt(await buildAuthEnveloped(cert, { plaintext: MESSAGE, authAttrs: 'match' }))).toContain(PLAINTEXT);
    await expect(decrypt(await buildAuthEnveloped(cert, { plaintext: MESSAGE, authAttrs: 'altered' }))).rejects.toThrow(FAILED);
  }, 30_000);
});

// Sealed with Node's ChaCha20-Poly1305, not the @noble/ciphers the plugin uses.
addSealer(OID_CHACHA20_POLY1305, (key, nonce, plaintext, aad) => {
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  if (aad) cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
  const ciphertext = new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final()]));
  return { ciphertext, mac: new Uint8Array(cipher.getAuthTag()) };
});

describe('ChaCha20-Poly1305 AuthEnvelopedData', () => {
  beforeEach(unlock);

  it('reads it as Stalwart stores it', async () => {
    const der = await buildAuthEnveloped(cert, { contentOid: OID_CHACHA20_POLY1305, plaintext: MESSAGE });
    const text = await decrypt(stalwartMessage(der));
    expect(text).toMatch(/^Content-Type: text\/plain; charset=utf-8\r\n\r\n/);
    expect(text).toContain(PLAINTEXT);
  }, 30_000);

  it('refuses the message once a mac byte is changed', async () => {
    const der = await buildAuthEnveloped(cert, { contentOid: OID_CHACHA20_POLY1305, plaintext: MESSAGE });
    expect(await decrypt(der)).toContain(PLAINTEXT);
    await expect(decrypt(flipMacByte(der))).rejects.toThrow(FAILED);
  }, 30_000);

  it('authenticates the authAttrs along with the content', async () => {
    const build = (authAttrs) => buildAuthEnveloped(cert, { contentOid: OID_CHACHA20_POLY1305, plaintext: MESSAGE, authAttrs });
    expect(await decrypt(await build('match'))).toContain(PLAINTEXT);
    await expect(decrypt(await build('altered'))).rejects.toThrow(FAILED);
  }, 30_000);
});

describe('a message the plugin can’t decrypt', () => {
  beforeEach(unlock);

  const { locales } = JSON.parse(readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8'));
  const t = (key, vars) => fakeApi({ translations: locales }).i18n.t(key, vars);
  // As the render hook stores a failure.
  const banner = (err) => bannerRows({ isEncrypted: true, decryptionSuccess: false, decryptionError: err.message }, { t })[0].text;

  it('names the algorithm instead of blaming the keys', async () => {
    const err = await decrypt(fixture('rc2.p7m')).catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedAlgorithmError);
    expect(banner(err)).toBe('Encrypted — unsupported encryption algorithm RC2-CBC');
    // No matching key, or one that doesn't fit, still reads as before.
    expect(banner(new Error('No imported S/MIME key matches any recipient in this encrypted message')))
      .toBe('Encrypted — couldn’t be decrypted with your keys');
    expect(banner(await decrypt(flipMacByte(normalizeCmsBytes(fixture('gcm.p7m')))).catch((e) => e)))
      .toBe('Encrypted — couldn’t be decrypted with your keys');
  }, 30_000);
});

describe('detecting AuthEnvelopedData', () => {
  it.each([
    ['Stalwart', 'application/pkcs7-mime;\r\n\tname="smime.p7m";\r\n\tsmime-type=authenticated-enveloped-data'],
    ['RFC 8551 / OpenSSL', 'application/pkcs7-mime; smime-type=authEnveloped-data; name="smime.p7m"'],
  ])('counts the %s smime-type as encrypted', (_, contentType) => {
    expect(detectSmime(contentType, null, null)).toMatchObject({ type: 'enveloped-data', supported: true });
  });
});
