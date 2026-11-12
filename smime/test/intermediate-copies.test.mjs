// Certificates in a message that share subject, issuer name and key with the real
// intermediate (copies with another serial, signed by some other key) must not cost an
// honest signer the verdict: each one is tried in turn until one is signed by the next
// issuer. One signature check serves the whole group as the issuer of the certificate
// below, and every check still counts against MAX_CHECKS. A path cut at MAX_PATH says a
// bound was reached.
import { describe, expect, it } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { makeCa, makeLeaf, signedCms } from './helpers/test-certificates.mjs';
import { smimeVerify } from '../src/smime-verify.js';
import { makeTrust, MAX_CHECKS, MAX_PATH } from '../src/trust.js';

const MESSAGE = new TextEncoder().encode('Content-Type: text/plain\r\n\r\nThe agenda.\r\n');
const ANN = 'ann@example.org';
const DAY = 86_400_000;
const EC = { name: 'ECDSA', namedCurve: 'P-256' };
let serial = 60_000;

/** The same subject, issuer name, extensions and key as `ca`, another serial, signed by a fresh key. */
async function lookalike(ca) {
  const other = await crypto.subtle.generateKey(EC, false, ['sign', 'verify']);
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: serial++ });
  cert.subject = ca.cert.subject;
  cert.issuer = ca.cert.issuer;
  cert.subjectPublicKeyInfo = ca.cert.subjectPublicKeyInfo;
  cert.extensions = ca.cert.extensions;
  cert.notBefore.value = new Date(Date.now() - DAY);
  cert.notAfter.value = new Date(Date.now() + 30 * DAY);
  await cert.sign(other.privateKey, 'SHA-256');
  return new Uint8Array(cert.toSchema(true).toBER(false));
}

/** The status of verifying `cms` from Ann, and the certificate signature checks it made. */
async function verifyCounting(cms, trust) {
  const original = pkijs.Certificate.prototype.verify;
  let checks = 0;
  pkijs.Certificate.prototype.verify = function (...args) { checks++; return original.apply(this, args); };
  try {
    return { status: (await smimeVerify(cms, ANN, trust)).status, checks };
  } finally {
    pkijs.Certificate.prototype.verify = original;
  }
}

async function chain() {
  const root = await makeCa('Example Root');
  const issuing = await makeCa('Example Issuing CA', { issuer: root });
  const ann = await makeLeaf(issuing, { emails: [ANN] });
  return { root, issuing, ann, trust: makeTrust({ issuers: [root.der] }) };
}

describe('look-alike copies of the intermediate', () => {
  it('one in front of the real intermediate: the signer is still verified', async () => {
    const { issuing, ann, trust } = await chain();
    const alone = await verifyCounting(await signedCms(MESSAGE, ann, [issuing.der]), trust);
    expect(alone.status.signerVerified).toBe(true);
    const copied = await verifyCounting(await signedCms(MESSAGE, ann, [await lookalike(issuing), issuing.der]), trust);
    expect(copied.status.signerVerified).toBe(true);
    expect(copied.checks).toBe(alone.checks + 1);
  });

  it('twenty in front: still verified, one check each, within the bound', async () => {
    const { issuing, ann, trust } = await chain();
    const copies = [];
    for (let i = 0; i < 20; i++) copies.push(await lookalike(issuing));
    const o = await verifyCounting(await signedCms(MESSAGE, ann, [...copies, issuing.der]), trust);
    expect(o.status.signerVerified).toBe(true);
    expect(o.checks).toBeLessThanOrEqual(MAX_CHECKS);
    expect(o.checks).toBe(22);
  });

  it('only copies, no real intermediate: not verified', async () => {
    const { issuing, ann, trust } = await chain();
    const o = await verifyCounting(await signedCms(MESSAGE, ann, [await lookalike(issuing), await lookalike(issuing)]), trust);
    expect(o.status.signerVerified).toBe(false);
    expect(o.status.trustReasons).toEqual(['issuer']);
  });

  it('as many copies as the checks allow, then the real one: not verified, with the bound named', async () => {
    const { issuing, ann, trust } = await chain();
    const copies = [];
    for (let i = 0; i < MAX_CHECKS; i++) copies.push(await lookalike(issuing));
    // More than MAX_POOL certificates: the real one is past the certificates looked at.
    const o = await verifyCounting(await signedCms(MESSAGE, ann, [...copies, issuing.der]), trust);
    expect(o.status.signerVerified).toBe(false);
    expect(o.status.trustReasons).toContain('limit');
    expect(o.checks).toBeLessThanOrEqual(MAX_CHECKS);
  });
});

describe('the path length bound', () => {
  async function chainOf(intermediates) {
    const root = await makeCa('Deep Root');
    const levels = [];
    let issuer = root;
    for (let i = 0; i < intermediates; i++) {
      issuer = await makeCa(`Level ${i + 1}`, { issuer });
      levels.push(issuer);
    }
    const ann = await makeLeaf(issuer, { emails: [ANN] });
    return (await smimeVerify(await signedCms(MESSAGE, ann, levels.map((l) => l.der)), ANN, makeTrust({ issuers: [root.der] }))).status;
  }

  it(`a path of ${MAX_PATH} certificates is verified (control)`, async () => {
    expect((await chainOf(MAX_PATH - 2)).signerVerified).toBe(true);
  });

  it('a longer one is not, and the reasons say a bound was reached', async () => {
    const status = await chainOf(MAX_PATH - 1);
    expect(status.signerVerified).toBe(false);
    expect(status.trustReasons).toEqual(['issuer', 'limit']);
  });
});
