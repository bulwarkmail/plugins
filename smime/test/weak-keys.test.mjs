// A signer is not verified when a key on the way is too short (RSA under 2048 bits, an
// elliptic curve under 256 bits: the signer's, an intermediate's or the trusted issuer's),
// or when a signature hashes with SHA-1 or MD5, also through RSA-PSS whose hash or mask
// generation parameter names one (and when the parameters are left out, which means SHA-1).
import { beforeAll, describe, expect, it } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { makeCa, makeLeaf, rsaKey, signedCms } from './helpers/test-certificates.mjs';
import { smimeVerify } from '../src/smime-verify.js';
import { makeTrust, weakKey, weakSignatureAlgorithm } from '../src/trust.js';

const MESSAGE = new TextEncoder().encode('Content-Type: text/plain\r\n\r\nThe contract.\r\n');
const BOB = 'bob@example.org';
const RSA_SIGNER = { keyUsage: ['digitalSignature', 'keyEncipherment'] };

let root;
beforeAll(async () => {
  root = await makeCa('Example Root');
}, 60_000);

const verify = async (leaf, chain, issuers) => (await smimeVerify(await signedCms(MESSAGE, leaf, chain), BOB, makeTrust({ issuers }))).status;

describe('a short key', () => {
  it('as the signer\'s: not verified, though the signature matches', { timeout: 60_000 }, async () => {
    const short = await makeLeaf(root, { emails: [BOB], algorithm: rsaKey(1024), ...RSA_SIGNER });
    const status = await verify(short, [], [root.der]);
    expect(status.signatureValid).toBe(true);
    expect(status.signerVerified).toBe(false);
    expect(status.trustReasons).toEqual(['weakKey']);
  });

  it('a 2048-bit RSA signer is verified (control)', { timeout: 60_000 }, async () => {
    const long = await makeLeaf(root, { emails: [BOB], algorithm: rsaKey(2048), ...RSA_SIGNER });
    expect((await verify(long, [], [root.der])).signerVerified).toBe(true);
  });

  it('as an intermediate\'s: not verified', { timeout: 60_000 }, async () => {
    const intermediate = await makeCa('Short Issuing CA', { issuer: root, algorithm: rsaKey(1024) });
    const leaf = await makeLeaf(intermediate, { emails: [BOB] });
    const status = await verify(leaf, [intermediate.der], [root.der]);
    expect(status.signerVerified).toBe(false);
    expect(status.trustReasons).toEqual(['issuer', 'weakKey']);
  });

  it('as the trusted issuer\'s: not verified', { timeout: 60_000 }, async () => {
    const shortRoot = await makeCa('Short Root', { algorithm: rsaKey(1024) });
    const leaf = await makeLeaf(shortRoot, { emails: [BOB] });
    const status = await verify(leaf, [], [shortRoot.der]);
    expect(status.signerVerified).toBe(false);
    expect(status.trustReasons).toEqual(['issuer', 'weakKey']);
  });

  it('on an elliptic curve under 256 bits, or one the plugin doesn\'t know', async () => {
    const leaf = await makeLeaf(root, { emails: [BOB] });
    const onCurve = (oid) => {
      const cert = pkijs.Certificate.fromBER(leaf.der);
      cert.subjectPublicKeyInfo.algorithm.algorithmParams = new asn1js.ObjectIdentifier({ value: oid });
      return cert;
    };
    expect(weakKey(onCurve('1.2.840.10045.3.1.7'))).toBe(false); // P-256
    expect(weakKey(onCurve('1.3.132.0.34'))).toBe(false); // P-384
    expect(weakKey(onCurve('1.3.132.0.33'))).toBe(true); // P-224
    expect(weakKey(onCurve('1.2.840.10045.3.1.1'))).toBe(true); // P-192
    expect(weakKey(onCurve('1.2.3.4'))).toBe(true);
  });
});

describe('RSA-PSS with SHA-1', () => {
  it('in a certificate signature on the way: not verified; with SHA-256 it is (control)', { timeout: 60_000 }, async () => {
    const sha1Root = await makeCa('PSS Root', { algorithm: rsaKey(2048, 'RSA-PSS', 'SHA-1') });
    const weak = await makeLeaf(sha1Root, { emails: [BOB], hash: 'SHA-1' });
    const params = new pkijs.RSASSAPSSParams({ schema: weak.cert.signatureAlgorithm.algorithmParams });
    expect([weak.cert.signatureAlgorithm.algorithmId, params.hashAlgorithm.algorithmId]).toEqual(['1.2.840.113549.1.1.10', '1.3.14.3.2.26']);
    const status = await verify(weak, [], [sha1Root.der]);
    expect(status.signerVerified).toBe(false);
    expect(status.trustReasons).toEqual(['issuer', 'digest']);
    const sha256Root = await makeCa('PSS Root', { algorithm: rsaKey(2048, 'RSA-PSS') });
    const strong = await makeLeaf(sha256Root, { emails: [BOB] });
    expect((await verify(strong, [], [sha256Root.der])).signerVerified).toBe(true);
  });

  it('in the mail signature: not verified, though the digest algorithm says SHA-256', { timeout: 60_000 }, async () => {
    const leaf = await makeLeaf(root, { emails: [BOB], algorithm: rsaKey(2048, 'RSA-PSS', 'SHA-1'), ...RSA_SIGNER });
    const cms = await signedCms(MESSAGE, leaf);
    const signed = new pkijs.SignedData({ schema: pkijs.ContentInfo.fromBER(cms).content });
    const signerInfo = signed.signerInfos[0];
    const params = new pkijs.RSASSAPSSParams({ schema: signerInfo.signatureAlgorithm.algorithmParams });
    expect([signerInfo.digestAlgorithm.algorithmId, params.hashAlgorithm.algorithmId]).toEqual(['2.16.840.1.101.3.4.2.1', '1.3.14.3.2.26']);
    const { status } = await smimeVerify(cms, BOB, makeTrust({ issuers: [root.der] }));
    expect(status.cryptoValid).toBe(true);
    expect(status.signerVerified).toBe(false);
    expect(status.trustReasons).toEqual(['digest']);
  });

  const pss = (hash, mgfHash) => new pkijs.AlgorithmIdentifier({
    algorithmId: '1.2.840.113549.1.1.10',
    algorithmParams: new pkijs.RSASSAPSSParams({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: hash }),
      maskGenAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: '1.2.840.113549.1.1.8',
        algorithmParams: new pkijs.AlgorithmIdentifier({ algorithmId: mgfHash }).toSchema(),
      }),
      saltLength: 32,
    }).toSchema(),
  });
  const SHA1 = '1.3.14.3.2.26';
  const SHA256 = '2.16.840.1.101.3.4.2.1';

  it('counts as weak by its hash or its mask generation hash, and without parameters', () => {
    expect(weakSignatureAlgorithm(pss(SHA256, SHA256))).toBe(false);
    expect(weakSignatureAlgorithm(pss(SHA1, SHA256))).toBe(true);
    expect(weakSignatureAlgorithm(pss(SHA256, SHA1))).toBe(true);
    expect(weakSignatureAlgorithm(new pkijs.AlgorithmIdentifier({ algorithmId: '1.2.840.113549.1.1.10' }))).toBe(true);
    expect(weakSignatureAlgorithm(new pkijs.AlgorithmIdentifier({ algorithmId: '1.2.840.113549.1.1.11' }))).toBe(false);
    expect(weakSignatureAlgorithm(new pkijs.AlgorithmIdentifier({ algorithmId: '1.2.840.113549.1.1.5' }))).toBe(true);
  });
});
