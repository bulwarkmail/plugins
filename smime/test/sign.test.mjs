// Signing with a throwaway self-signed certificate and reading the CMS back:
// the signed attributes Outlook needs, their DER order (verifiers that
// re-encode them, like OpenSSL, hash the sorted form), the RSA signature
// algorithm with NULL parameters, and the plugin's own verifier.
import { beforeAll, describe, expect, it } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { smimeSign, smimeSignDetached } from '../src/smime-sign.js';
import { smimeVerify, smimeVerifyDetached } from '../src/smime-verify.js';

const MESSAGE = new TextEncoder().encode('Content-Type: text/plain; charset=utf-8\r\n\r\nSigned hello.\r\n');
const FROM = 'signer@example.com';

async function selfSigned(algorithm, signAlg) {
  const keys = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: 1 });
  const name = [new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'Signer' }) })];
  cert.issuer.typesAndValues.push(...name);
  cert.subject.typesAndValues.push(...name);
  cert.notBefore.value = new Date(Date.now() - 86_400_000);
  cert.notAfter.value = new Date(Date.now() + 86_400_000);
  cert.extensions = [
    new pkijs.Extension({
      extnID: '2.5.29.17', // subjectAltName
      extnValue: new pkijs.GeneralNames({
        names: [new pkijs.GeneralName({ type: 1, value: FROM })],
      }).toSchema().toBER(false),
    }),
  ];
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, signAlg);
  return { privateKey: keys.privateKey, der: new Uint8Array(cert.toSchema(true).toBER(false)) };
}

// smimeSign returns a Blob, smimeSignDetached the bytes.
const opaque = async (...args) => new Uint8Array(await (await smimeSign(...args)).arrayBuffer());

function signerInfoOf(cmsDer) {
  const info = new pkijs.ContentInfo({ schema: asn1js.fromBER(cmsDer).result });
  const signed = new pkijs.SignedData({ schema: info.content });
  return { signed, signer: signed.signerInfos[0] };
}

const der = (attr) => new Uint8Array(attr.toSchema().toBER(false));
function compareBytes(x, y) {
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

let rsa;
let ec;

beforeAll(async () => {
  rsa = await selfSigned(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    'SHA-256',
  );
  ec = await selfSigned({ name: 'ECDSA', namedCurve: 'P-256' }, 'SHA-256');
}, 60_000);

describe('smimeSign', () => {
  it('adds contentType, messageDigest, signingTime and smimeCapabilities as signed attributes', async () => {
    const { signer } = signerInfoOf(await opaque(MESSAGE, rsa.privateKey, rsa.der));
    const attrs = signer.signedAttrs.attributes;
    expect(attrs.map((a) => a.type).sort()).toEqual([
      '1.2.840.113549.1.9.15', '1.2.840.113549.1.9.3', '1.2.840.113549.1.9.4', '1.2.840.113549.1.9.5',
    ]);
    const digest = attrs.find((a) => a.type === '1.2.840.113549.1.9.4').values[0].valueBlock.valueHexView;
    expect(Array.from(digest)).toEqual(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', MESSAGE))));
    const signingTime = attrs.find((a) => a.type === '1.2.840.113549.1.9.5').values[0].toDate();
    expect(Math.abs(signingTime.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('encodes the signed attributes in DER SET OF order', async () => {
    const { signer } = signerInfoOf(await opaque(MESSAGE, rsa.privateKey, rsa.der));
    const encoded = signer.signedAttrs.attributes.map(der);
    expect(encoded).toEqual([...encoded].sort(compareBytes));
  });

  it('names rsaEncryption with NULL parameters as the signature algorithm for RSA keys', async () => {
    const { signer } = signerInfoOf(await opaque(MESSAGE, rsa.privateKey, rsa.der));
    expect(signer.signatureAlgorithm.algorithmId).toBe('1.2.840.113549.1.1.1');
    expect(signer.signatureAlgorithm.algorithmParams).toBeInstanceOf(asn1js.Null);
  });

  it('leaves the signature algorithm of ECDSA keys alone', async () => {
    const { signer } = signerInfoOf(await opaque(MESSAGE, ec.privateKey, ec.der));
    expect(signer.signatureAlgorithm.algorithmId).toBe('1.2.840.10045.4.3.2'); // ecdsa-with-SHA256
  });

  it('carries the content as one primitive OCTET STRING', async () => {
    const { signed } = signerInfoOf(await opaque(MESSAGE, rsa.privateKey, rsa.der));
    const content = signed.encapContentInfo.eContent;
    expect(content.idBlock.isConstructed).toBe(false);
    expect(Array.from(content.valueBlock.valueHexView)).toEqual(Array.from(MESSAGE));
  });

  it('produces signatures its own verifier accepts', async () => {
    for (const key of [rsa, ec]) {
      const { mimeBytes, status } = await smimeVerify(await opaque(MESSAGE, key.privateKey, key.der), FROM);
      expect(status.cryptoValid).toBe(true);
      expect(Array.from(mimeBytes)).toEqual(Array.from(MESSAGE));
    }
  });
});

describe('smimeSignDetached', () => {
  it('produces signatures its own verifier accepts, with the same signed attributes', async () => {
    const sig = await smimeSignDetached(MESSAGE, rsa.privateKey, rsa.der);
    const { signer } = signerInfoOf(sig);
    expect(signer.signedAttrs.attributes).toHaveLength(4);
    const { status } = await smimeVerifyDetached(sig, MESSAGE, FROM);
    expect(status.cryptoValid).toBe(true);
  });
});
