// What a key can do, read from its certificate's extensions. Certificates come from
// OpenSSL: fixtures/README.md.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyCapabilities, extractCertificateInfo, parseCertificatePemOrDer } from '../src/certificate-utils.js';
import { getKeyRecord, listKeyRecords, saveKeyRecord } from '../src/key-storage.js';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const pem = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const parsed = (name) => parseCertificatePemOrDer(pem(name));
const der = (name) => parsed(name).toSchema(true).toBER(false);

describe('classifyCapabilities', () => {
  it('reads the key usage bits', () => {
    expect(classifyCapabilities(parsed('cert.pem'))).toEqual({ canSign: true, canEncrypt: true });
    expect(classifyCapabilities(parsed('ec-p256-cert.pem'))).toEqual({ canSign: true, canEncrypt: true });
  });

  it('tells signing from encryption', () => {
    expect(classifyCapabilities(parsed('sign-only-cert.pem'))).toEqual({ canSign: true, canEncrypt: false });
    expect(classifyCapabilities(parsed('encrypt-only-cert.pem'))).toEqual({ canSign: false, canEncrypt: true });
  });

  it('turns both off for a certificate not meant for mail, and leaves them on for any use', () => {
    expect(classifyCapabilities(parsed('server-auth-cert.pem'))).toEqual({ canSign: false, canEncrypt: false });
    expect(classifyCapabilities(parsed('any-eku-cert.pem'))).toEqual({ canSign: true, canEncrypt: true });
  });

  it('names the usages in the certificate info', async () => {
    const info = await extractCertificateInfo(parsed('cert.pem'), der('cert.pem'));
    expect(info.keyUsage).toEqual(['digitalSignature', 'keyEncipherment']);
  });
});

describe('a stored key record', () => {
  beforeEach(() => { globalThis.indexedDB = fakeIndexedDB(); });

  const stored = (name) => ({ id: 'k', email: 'a@example.com', certificate: der(name), capabilities: { canSign: false, canEncrypt: false } });

  it('gets its capabilities from the certificate, not from what was saved', async () => {
    await saveKeyRecord(stored('cert.pem'));
    expect((await listKeyRecords())[0].capabilities).toEqual({ canSign: true, canEncrypt: true });
    expect((await getKeyRecord('k')).capabilities).toEqual({ canSign: true, canEncrypt: true });
  });

  it('keeps what was saved if the certificate cannot be read', async () => {
    await saveKeyRecord({ ...stored('cert.pem'), certificate: new Uint8Array([1, 2, 3]).buffer });
    expect((await listKeyRecords())[0].capabilities).toEqual({ canSign: false, canEncrypt: false });
  });
});
