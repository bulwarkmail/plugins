// The signature has to be checked against the certificate the verdict is about.
//
// A SignerInfo names its certificate by issuer and serial number. The plugin picks that
// certificate out of the message byte for byte and reads everything from it: who signed,
// whether a trusted issuer vouches for it, whether it is for the From address, and what
// the details show. pkijs picks it again inside SignedData.verify(), by a looser
// comparison (case and spacing of the issuer's name don't count), and takes the first
// match. A message with a second certificate ahead of the signer's, same serial number
// and the issuer's name in another spelling, had its signature checked against that
// certificate's key and its verdict read from the other one.
import { describe, expect, it } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { makeCa, makeLeaf, signedCms } from './helpers/test-certificates.mjs';
import { computeFingerprint } from '../src/certificate-utils.js';
import { smimeVerify, smimeVerifyDetached } from '../src/smime-verify.js';
import { makeTrust } from '../src/trust.js';

const BOB = 'bob@example.org';
const CA_NAME = 'Example Corp Mail CA';
const GENUINE = new TextEncoder().encode('Content-Type: text/plain; charset=utf-8\r\n\r\nThe minutes are attached.\r\n');
const OTHER = new TextEncoder().encode('Content-Type: text/plain; charset=utf-8\r\n\r\nPlease pay the attached invoice today.\r\n');
const EC = { name: 'ECDSA', namedCurve: 'P-256' };
const DAY = 86_400_000;
const NOT_THE_CONTENT = 'Signature does not match the message content';

const text = (bytes) => new TextDecoder().decode(bytes);

/**
 * What someone without Bob's key can make: a certificate of their own with Bob's serial
 * number and `issuerCn` as its issuer, and a SignedData over `content` that names Bob's
 * certificate as the signer's, is signed with their key and carries both certificates.
 */
async function signedByAnotherKey(bob, content, issuerCn, { first = 'theirs', detached = false } = {}) {
  const bobCert = pkijs.Certificate.fromBER(bob.der);
  const keys = await crypto.subtle.generateKey(EC, false, ['sign', 'verify']);
  const made = new pkijs.Certificate();
  made.version = 2;
  made.serialNumber = new asn1js.Integer({ valueHex: bobCert.serialNumber.valueBlock.valueHexView.slice().buffer });
  made.issuer.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: issuerCn }) }));
  made.subject.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'Someone else' }) }));
  made.notBefore.value = new Date(Date.now() - DAY);
  made.notAfter.value = new Date(Date.now() + DAY);
  await made.subjectPublicKeyInfo.importKey(keys.publicKey);
  await made.sign(keys.privateKey, 'SHA-256');
  const theirs = pkijs.Certificate.fromBER(made.toSchema(true).toBER(false));

  const cms = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: '1.2.840.113549.1.7.1',
      ...(detached ? {} : { eContent: new asn1js.OctetString({ valueHex: content }) }),
    }),
    signerInfos: [new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({ issuer: bobCert.issuer, serialNumber: bobCert.serialNumber }),
    })],
    certificates: first === 'theirs' ? [theirs, bobCert] : [bobCert, theirs],
  });
  await cms.sign(keys.privateKey, 0, 'SHA-256', detached ? content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) : undefined);
  return new Uint8Array(new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: cms.toSchema(true) }).toSchema().toBER(false));
}

async function setup() {
  const ca = await makeCa(CA_NAME);
  const bob = await makeLeaf(ca, { cn: 'Bob', emails: [BOB] });
  return { ca, bob, trust: makeTrust({ issuers: [ca.der] }) };
}

describe('the certificate the signature is checked against', () => {
  it('verifies a message Bob signed, as before', async () => {
    const { bob, trust } = await setup();
    const { status, mimeBytes } = await smimeVerify(await signedCms(GENUINE, bob), BOB, trust);
    expect(status.signatureValid).toBe(true);
    expect(status.signerVerified).toBe(true);
    expect(status.signerCert.email).toBe(BOB);
    expect(text(mimeBytes)).toContain('The minutes are attached.');
  });

  // The spellings pkijs takes for the same issuer name and a byte comparison doesn't.
  it.each([
    ['in lower case', 'example corp mail ca'],
    ['in upper case', 'EXAMPLE CORP MAIL CA'],
    ['with more spaces', 'Example  Corp   Mail CA'],
    ['with spaces around it', ' Example Corp Mail CA '],
  ])('does not take a signature by another key for Bob\'s: issuer %s', async (_label, issuerCn) => {
    const { bob, trust } = await setup();
    const { status } = await smimeVerify(await signedByAnotherKey(bob, OTHER, issuerCn), BOB, trust);
    expect(status.cryptoValid).toBe(false);
    expect(status.signatureValid).toBe(false);
    expect(status.signatureError).toBe(NOT_THE_CONTENT);
    expect(status.signerVerified).toBe(false);
  });

  it('does not take it for Bob\'s when Bob\'s certificate is the one the user trusts', async () => {
    const { bob } = await setup();
    const trust = makeTrust({ pinned: [await computeFingerprint(bob.der)] });
    const { status } = await smimeVerify(await signedByAnotherKey(bob, OTHER, 'example corp mail ca'), BOB, trust);
    expect(status.signatureValid).toBe(false);
    expect(status.signerVerified).toBe(false);
  });

  it('does not take it for Bob\'s in a detached signature', async () => {
    const { bob, trust } = await setup();
    const signature = await signedByAnotherKey(bob, OTHER, 'example corp mail ca', { detached: true });
    const { status } = await smimeVerifyDetached(signature, OTHER, BOB, trust);
    expect(status.signatureValid).toBe(false);
    expect(status.signatureError).toBe(NOT_THE_CONTENT);
    expect(status.signerVerified).toBe(false);
  });

  it('reads the same either way round: Bob\'s certificate first', async () => {
    const { bob, trust } = await setup();
    const { status } = await smimeVerify(await signedByAnotherKey(bob, OTHER, 'example corp mail ca', { first: 'bob' }), BOB, trust);
    expect(status.signatureValid).toBe(false);
    expect(status.signerVerified).toBe(false);
  });

  it('checks a certificate with the very same issuer name and serial against itself, and nobody vouches for it', async () => {
    const { bob, trust } = await setup();
    const { status } = await smimeVerify(await signedByAnotherKey(bob, OTHER, CA_NAME), BOB, trust);
    // That certificate is the one the SignerInfo names, byte for byte: its signature holds,
    // and it is not Bob's, not issued by the trusted CA and not for the From address.
    expect(status.cryptoValid).toBe(true);
    expect(status.signerVerified).toBe(false);
    expect(status.signerCert.email).toBe('');
    expect(status.trustReasons).toEqual(expect.arrayContaining(['issuer', 'from']));
  });

  it('still hands the message\'s other certificates on for the path', async () => {
    const { bob, trust } = await setup();
    const { chain } = await smimeVerify(await signedByAnotherKey(bob, OTHER, 'example corp mail ca'), BOB, trust);
    expect(chain).toHaveLength(1);
    // A real message with its intermediate still verifies through it.
    const root = await makeCa('Example Corp Root');
    const intermediate = await makeCa(CA_NAME, { issuer: root });
    const ann = await makeLeaf(intermediate, { cn: 'Ann', emails: ['ann@example.org'] });
    const viaIntermediate = await smimeVerify(await signedCms(GENUINE, ann, [intermediate.der]), 'ann@example.org', makeTrust({ issuers: [root.der] }));
    expect(viaIntermediate.status.signatureValid).toBe(true);
    expect(viaIntermediate.status.signerVerified).toBe(true);
    expect(viaIntermediate.chain).toHaveLength(1);
  });
});
