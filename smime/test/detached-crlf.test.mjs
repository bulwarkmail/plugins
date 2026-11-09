// Offline interoperability regression: synthetic messages and an ephemeral key.
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { buildMimeEntity, wrapDetachedSignedMessage } from '../src/mime-builder.js';
import { extractDetachedSigned } from '../src/mime-parse.js';
import { smimeSignDetached } from '../src/smime-sign.js';
import { smimeVerifyDetached } from '../src/smime-verify.js';

const FROM = 'signer@example.invalid';
const base = {
  from: { email: FROM },
  to: [{ email: 'recipient@example.invalid' }],
  subject: 'Synthetic CRLF regression',
  textBody: 'Synthetic text.',
};
const helper = fileURLToPath(new URL('./helpers/detached-openssl.py', import.meta.url));
let signer;

function runs(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
// `python3` on Windows is the Store stub, which only exits with an error.
const python = ['python3', 'python'].find((command) => runs(command, ['-c', 'import email']));
const oracle = Boolean(python) && runs('openssl', ['version']);

beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, false, ['sign', 'verify']);
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: 1 });
  const name = new pkijs.AttributeTypeAndValue({
    type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'Synthetic test signer' }),
  });
  cert.issuer.typesAndValues.push(name);
  cert.subject.typesAndValues.push(name);
  cert.notBefore.value = new Date(Date.now() - 86_400_000);
  cert.notAfter.value = new Date(Date.now() + 86_400_000);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, 'SHA-256');
  signer = { key: keys.privateKey, cert: new Uint8Array(cert.toSchema(true).toBER(false)) };
});

describe('detached signed-entity CRLF', () => {
  it.each([
    ['plain text', {}],
    ['plain text already terminated', { textBody: 'Synthetic text.\r\n' }],
    ['multipart alternative', { htmlBody: '<p>Synthetic text.</p>' }],
    ['multipart mixed', {
      htmlBody: '<p>Synthetic text.</p>',
      attachments: [{
        filename: 'synthetic.txt', contentType: 'text/plain',
        content: new TextEncoder().encode('Synthetic attachment.').buffer,
      }],
    }],
  ])('survives offline MIME serialization: %s', async (_label, extra) => {
    const input = { ...base, ...extra };
    const entity = buildMimeEntity(input);
    const text = new TextDecoder().decode(entity);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.endsWith('\r\n\r\n')).toBe(false);

    const signature = await smimeSignDetached(entity, signer.key, signer.cert);
    const raw = new Uint8Array(await wrapDetachedSignedMessage(entity, signature, input).arrayBuffer());
    const extracted = extractDetachedSigned(raw);
    expect(Array.from(extracted.entityBytes)).toEqual(Array.from(entity));
    expect((await smimeVerifyDetached(signature, entity, FROM)).status.cryptoValid).toBe(true);

    // Python is an independent parser/serializer; its CMS check uses raw spans.
    // A machine without Python or OpenSSL stops here; CI has both and must.
    if (!oracle) {
      expect(process.env.CI, 'this check needs Python and OpenSSL in CI').toBeFalsy();
      return;
    }
    const result = JSON.parse(execFileSync(python, [helper], {
      input: JSON.stringify({ message: Buffer.from(raw).toString('base64') }),
      encoding: 'utf8', timeout: 15_000,
    }));
    expect(result).toEqual({
      smime: true, cms: true, parsedWithoutDefects: true, framing: true,
      entityRoundTrip: true, signatureRoundTrip: true, roundTripSmime: true,
      roundTripCms: true, rejectMissingSignedCrlf: true, rejectExtraSignedCrlf: true,
    });
  });
});
