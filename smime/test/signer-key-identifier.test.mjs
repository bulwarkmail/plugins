// A SignerInfo may name its signer by subject key identifier instead of issuer and
// serial number (RFC 5652 §5.3; `openssl cms -sign -keyid`). With the
// issuer's certificate in the message too, the signer's still has to be found.
import { describe, expect, it } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { makeCa, makeLeaf } from './helpers/test-certificates.mjs';
import { smimeVerify } from '../src/smime-verify.js';
import { makeTrust } from '../src/trust.js';

const BOB = 'bob@example.org';
const MESSAGE = new TextEncoder().encode('Content-Type: text/plain; charset=utf-8\r\n\r\nThe minutes are attached.\r\n');

// pkijs matches a key identifier against the SHA-1 of the certificate's public key. The
// identifier is the [0] alternative of SignerIdentifier, which pkijs writes as handed over.
async function signedByKeyId(content, leaf, others = [], named = leaf) {
  const cert = pkijs.Certificate.fromBER(leaf.der);
  const keyId = await crypto.subtle.digest('SHA-1', pkijs.Certificate.fromBER(named.der).subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView);
  const cms = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.7.1', eContent: new asn1js.OctetString({ valueHex: content }) }),
    signerInfos: [new pkijs.SignerInfo({ version: 3, sid: new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: keyId }) })],
    certificates: [...others.map((der) => pkijs.Certificate.fromBER(der)), cert],
  });
  await cms.sign(leaf.key.privateKey, 0, 'SHA-256');
  return new Uint8Array(new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: cms.toSchema(true) }).toSchema().toBER(false));
}

describe('a signer named by subject key identifier', () => {
  it('verifies when the message carries only the signer certificate', async () => {
    const leaf = await makeLeaf(await makeCa('Key id CA'), { emails: [BOB] });
    const { status } = await smimeVerify(await signedByKeyId(MESSAGE, leaf), BOB, makeTrust({ issuers: [], pinned: [] }));
    expect(status.signatureError).toBeUndefined();
    expect(status.cryptoValid).toBe(true);
  });

  it('verifies when the message carries the issuer certificate too', async () => {
    const ca = await makeCa('Key id CA');
    const leaf = await makeLeaf(ca, { emails: [BOB] });
    const { status } = await smimeVerify(await signedByKeyId(MESSAGE, leaf, [ca.der]), BOB, makeTrust({ issuers: [], pinned: [] }));
    expect(status.signatureError).toBeUndefined();
    expect(status.cryptoValid).toBe(true);
    expect(status.signerCert.emails).toEqual([BOB]);
  });

  it('is verified through a trusted issuer like any other signer', async () => {
    const ca = await makeCa('Key id CA');
    const leaf = await makeLeaf(ca, { emails: [BOB] });
    const { status } = await smimeVerify(await signedByKeyId(MESSAGE, leaf, [ca.der]), BOB, makeTrust({ issuers: [ca.der], pinned: [] }));
    expect(status.signerVerified).toBe(true);
  });

  it('takes the certificate the identifier names, not the first in the message', async () => {
    const ca = await makeCa('Key id CA');
    const other = await makeLeaf(ca, { emails: ['mallory@example.org'] });
    const leaf = await makeLeaf(ca, { emails: [BOB] });
    const { status } = await smimeVerify(await signedByKeyId(MESSAGE, leaf, [other.der, ca.der]), BOB, makeTrust({ issuers: [], pinned: [] }));
    expect(status.cryptoValid).toBe(true);
    expect(status.signerCert.emails).toEqual([BOB]);
  });

  it('finds no signer when the identifier names a key no certificate in the message has', async () => {
    const ca = await makeCa('Key id CA');
    const leaf = await makeLeaf(ca, { emails: [BOB] });
    const stranger = await makeLeaf(ca, { emails: ['stranger@example.org'] });
    const { status } = await smimeVerify(await signedByKeyId(MESSAGE, leaf, [ca.der], stranger), BOB, makeTrust({ issuers: [], pinned: [] }));
    expect(status.signatureValid).toBe(false);
    expect(status.signatureError).toBe('Signer certificate not found in CMS structure');
  });
});
