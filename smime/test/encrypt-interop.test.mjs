// What smimeEncrypt puts on the wire has to be what a receiving client can
// open. RSAES-OAEP + AES-GCM inside EnvelopedData cannot be: RFC 5083/5084
// carry an AEAD cipher in AuthEnvelopedData, so a GCM parameter block in
// EnvelopedData's encryptedContentInfo stops the reader at the cipher, before
// any key is tried. OpenSSL calls that "cipher parameter initialisation
// error"; a .NET client reports it as a missing recipient. These tests pin the
// baseline of RFC 8551 s2.3 and s2.7 instead.
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as asn1js from 'asn1js';
import { smimeEncrypt } from '../src/smime-encrypt.js';

const OID_ENVELOPED_DATA = '1.2.840.113549.1.7.3';
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_RSAES_OAEP = '1.2.840.113549.1.1.7';
const OID_AES_128_CBC = '2.16.840.1.101.3.4.1.2';
const OID_AES_256_CBC = '2.16.840.1.101.3.4.1.42';
const MESSAGE = 'Content-Type: text/plain; charset=utf-8\r\n\r\nInteroperability probe.\r\n';

let dir;
let recipientDer;
let senderDer;

const der = (file) => execFileSync('openssl', ['x509', '-in', file, '-outform', 'DER'], { maxBuffer: 1 << 20 });

function makeKeypair(name) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.cer`),
    '-days', '1', '-nodes', '-subj', `/CN=${name}/emailAddress=${name}@example.invalid`,
    '-addext', 'keyUsage=digitalSignature,keyEncipherment'], { stdio: 'ignore' });
  return new Uint8Array(der(join(dir, `${name}.cer`)));
}

/** Every OID in the DER, so the structure can be asserted without a CMS parser. */
function oids(bytes) {
  const found = [];
  const walk = (node) => {
    if (node instanceof asn1js.ObjectIdentifier) found.push(node.valueBlock.toString());
    for (const child of node.valueBlock?.value ?? []) walk(child);
  };
  walk(asn1js.fromBER(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).result);
  return found;
}

async function encrypted({ aes128 = false } = {}) {
  const blob = await smimeEncrypt(new TextEncoder().encode(MESSAGE), [recipientDer], senderDer, aes128);
  return new Uint8Array(await blob.arrayBuffer());
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'smime-interop-'));
  recipientDer = makeKeypair('recipient');
  senderDer = makeKeypair('sender');
});

describe('smimeEncrypt interoperability', () => {
  it('wraps the content key with RSAES-PKCS1-v1_5, not OAEP', async () => {
    const present = oids(await encrypted());
    expect(present).toContain(OID_RSA_ENCRYPTION);
    expect(present).not.toContain(OID_RSAES_OAEP);
  });

  it('encrypts the content with AES-CBC in EnvelopedData', async () => {
    const present = oids(await encrypted());
    expect(present[0]).toBe(OID_ENVELOPED_DATA);
    expect(present).toContain(OID_AES_256_CBC);
    expect(oids(await encrypted({ aes128: true }))).toContain(OID_AES_128_CBC);
  });

  it('is decrypted by an independent implementation, for recipient and sender alike', async () => {
    const file = join(dir, 'message.der');
    writeFileSync(file, await encrypted());
    for (const who of ['recipient', 'sender']) {
      const out = execFileSync('openssl', ['cms', '-decrypt', '-inform', 'DER', '-in', file,
        '-recip', join(dir, `${who}.cer`), '-inkey', join(dir, `${who}.key`)], { encoding: 'utf8' });
      expect(out).toBe(MESSAGE);
    }
  });
});
