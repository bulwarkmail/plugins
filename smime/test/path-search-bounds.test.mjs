// The path from a signer certificate to a trusted issuer is searched over the certificates
// the message carries and the trusted issuers. A message can carry many CA certificates
// with the same name and the same key (only the serial differs), each of which verifies as
// the issuer of every other one; a search that tries every candidate at every level would
// make about e * n! signature checks for n of them. The search drops certificates with the
// same subject, issuer and key, remembers which ones led nowhere, looks at the first
// MAX_POOL certificates of a message only, and makes at most MAX_CHECKS signature checks.
// Reaching a bound reads "not verified" with the reason, never an error. Signature checks
// are counted here (the same count on every machine), not timed.
import { describe, expect, it } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { makeCa, makeLeaf, signedCms } from './helpers/test-certificates.mjs';
import { smimeVerify } from '../src/smime-verify.js';
import { makeTrust, MAX_CHECKS, MAX_POOL } from '../src/trust.js';

const MESSAGE = new TextEncoder().encode('Content-Type: text/plain\r\n\r\nHello.\r\n');
const DAY = 86_400_000;
const EC = { name: 'ECDSA', namedCurve: 'P-256' };
const BOB = 'bob@example.org';
let serial = 70_000;

const nameOf = (cn) => [new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) })];
const basic = (ca) => new pkijs.Extension({ extnID: '2.5.29.19', critical: true, extnValue: new pkijs.BasicConstraints({ cA: ca }).toSchema().toBER(false) });
const altNames = (emails) => new pkijs.Extension({
  extnID: '2.5.29.17',
  extnValue: new pkijs.GeneralNames({ names: emails.map((value) => new pkijs.GeneralName({ type: 1, value })) }).toSchema().toBER(false),
});

async function certificate({ subject, issuer, publicKey, signingKey, extensions }) {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: serial++ });
  cert.subject.typesAndValues.push(...nameOf(subject));
  cert.issuer.typesAndValues.push(...nameOf(issuer));
  cert.notBefore.value = new Date(Date.now() - DAY);
  cert.notAfter.value = new Date(Date.now() + 30 * DAY);
  cert.extensions = extensions;
  await cert.subjectPublicKeyInfo.importKey(publicKey);
  await cert.sign(signingKey, 'SHA-256');
  return new Uint8Array(cert.toSchema(true).toBER(false));
}

/** Runs `verify` and counts the certificate signature checks it makes. */
async function counted(verify) {
  const original = pkijs.Certificate.prototype.verify;
  let checks = 0;
  pkijs.Certificate.prototype.verify = function (...args) { checks++; return original.apply(this, args); };
  try {
    return { status: (await verify()).status, checks };
  } finally {
    pkijs.Certificate.prototype.verify = original;
  }
}

/** Signature checks made while verifying a mail that carries `n` same-name, same-key CA certificates. */
async function checksFor(n, trust) {
  const loopKey = await crypto.subtle.generateKey(EC, true, ['sign', 'verify']);
  const loop = [];
  for (let i = 0; i < n; i++) {
    loop.push(await certificate({ subject: 'Loop CA', issuer: 'Loop CA', publicKey: loopKey.publicKey, signingKey: loopKey.privateKey, extensions: [basic(true)] }));
  }
  const leafKey = await crypto.subtle.generateKey(EC, true, ['sign', 'verify']);
  const leaf = await certificate({ subject: 'Signer', issuer: 'Loop CA', publicKey: leafKey.publicKey, signingKey: loopKey.privateKey, extensions: [basic(false), altNames([BOB])] });
  const cms = await signedCms(MESSAGE, { key: leafKey, der: leaf }, loop);
  const { status, checks } = await counted(() => smimeVerify(cms, BOB, trust));
  expect(status.signerVerified).not.toBe(true);
  return checks;
}

describe('the path search over the certificates a message carries', () => {
  it('grows with the number of certificates, not with its factorial', { timeout: 120_000 }, async () => {
    const anchor = await makeCa('A trusted CA');
    const trust = makeTrust({ issuers: [anchor.der] });
    const five = await checksFor(5, trust);
    const six = await checksFor(6, trust);
    // A search that remembers which certificates lead nowhere, or caps its work, stays near linear here.
    expect(six / five).toBeLessThan(3);
    expect(six).toBeLessThan(200);
  });

  it('checks each of n same-name, same-key certificates once at most', { timeout: 120_000 }, async () => {
    const trust = makeTrust({ issuers: [(await makeCa('A trusted CA')).der] });
    for (const n of [2, 3, 4, 5, 6]) expect(await checksFor(n, trust), `n = ${n}`).toBeLessThanOrEqual(n + 1);
  });

  // Certificates with the issuer's name but other keys: each costs one check, once.
  async function withDecoys(n) {
    const root = await makeCa('Example Root');
    const issuing = await makeCa('Example Issuing CA', { issuer: root });
    const decoys = [];
    for (let i = 0; i < n; i++) decoys.push((await makeCa('Example Issuing CA')).der);
    const leaf = await makeLeaf(issuing, { emails: [BOB] });
    const cms = await signedCms(MESSAGE, leaf, [...decoys, issuing.der]);
    return counted(() => smimeVerify(cms, BOB, makeTrust({ issuers: [root.der] })));
  }

  it('makes one check per certificate that could be the issuer, and still finds the path', { timeout: 120_000 }, async () => {
    const eight = await withDecoys(8);
    const sixteen = await withDecoys(16);
    expect(eight.status.signerVerified).toBe(true);
    expect(sixteen.status.signerVerified).toBe(true);
    expect(sixteen.checks - eight.checks).toBe(8);
  });

  it('looks at the first certificates of a message only, and says so when the path may lie beyond them', { timeout: 120_000 }, async () => {
    const o = await withDecoys(MAX_POOL + 8);
    expect(o.status.signerVerified).toBe(false);
    expect(o.status.trustReasons).toEqual(['issuer', 'limit']);
    expect(o.checks).toBeLessThanOrEqual(MAX_POOL);
  });

  it('stops after a fixed number of signature checks, with the reason', { timeout: 120_000 }, async () => {
    // Trusted issuers with the signer's issuer name but other keys, the right one last.
    const real = await makeCa('Example Mail CA');
    const others = [];
    for (let i = 0; i < MAX_CHECKS + 6; i++) others.push((await makeCa('Example Mail CA')).der);
    const leaf = await makeLeaf(real, { emails: [BOB] });
    const cms = await signedCms(MESSAGE, leaf);
    const capped = await counted(() => smimeVerify(cms, BOB, makeTrust({ issuers: [...others, real.der] })));
    expect(capped.status.signatureValid).toBe(true);
    expect(capped.status.signerVerified).toBe(false);
    expect(capped.status.trustReasons).toEqual(['issuer', 'limit']);
    expect(capped.checks).toBe(MAX_CHECKS);
    // With fewer of them the path is found.
    const found = await counted(() => smimeVerify(cms, BOB, makeTrust({ issuers: [...others.slice(0, 20), real.der] })));
    expect(found.status.signerVerified).toBe(true);
  });
});
