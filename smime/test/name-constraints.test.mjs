// Name constraints are not processed, so a CA that carries them vouches for nobody,
// whether the extension is marked critical or not (RFC 5280 wants it critical, but CAs
// exist that mark it non-critical), as a trusted issuer and as an intermediate under a
// trusted root. The details say why, and the import under Trusted issuers refuses such a
// certificate.
import { describe, expect, it } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { makeCa, makeLeaf, signedCms } from './helpers/test-certificates.mjs';
import { smimeVerify } from '../src/smime-verify.js';
import { makeTrust } from '../src/trust.js';
import { issuerCapabilities } from '../src/certificate-utils.js';

const MESSAGE = new TextEncoder().encode('Content-Type: text/plain\r\n\r\nPay the invoice.\r\n');
const DAY = 86_400_000;
const EC = { name: 'ECDSA', namedCurve: 'P-256' };
let serial = 80_000;

const nameOf = (cn) => [new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) })];
const basic = () => new pkijs.Extension({ extnID: '2.5.29.19', critical: true, extnValue: new pkijs.BasicConstraints({ cA: true }).toSchema().toBER(false) });
// Permits only addresses under corp.example.
const onlyCorp = (critical = false) => new pkijs.Extension({
  extnID: '2.5.29.30',
  critical,
  extnValue: new pkijs.NameConstraints({
    permittedSubtrees: [new pkijs.GeneralSubtree({ base: new pkijs.GeneralName({ type: 1, value: 'corp.example' }) })],
  }).toSchema().toBER(false),
});

/** A CA certificate with name constraints (non-critical unless asked), self-signed or signed by `parent`. */
async function constrainedCa(cn, parent, { critical = false } = {}) {
  const key = await crypto.subtle.generateKey(EC, true, ['sign', 'verify']);
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: serial++ });
  cert.subject.typesAndValues.push(...nameOf(cn));
  if (parent) cert.issuer.typesAndValues.push(...parent.cert.subject.typesAndValues);
  else cert.issuer.typesAndValues.push(...nameOf(cn));
  cert.notBefore.value = new Date(Date.now() - DAY);
  cert.notAfter.value = new Date(Date.now() + 30 * DAY);
  cert.extensions = [basic(), onlyCorp(critical)];
  await cert.subjectPublicKeyInfo.importKey(key.publicKey);
  await cert.sign(parent ? parent.key.privateKey : key.privateKey, 'SHA-256');
  const der = new Uint8Array(cert.toSchema(true).toBER(false));
  return { key, cert: pkijs.Certificate.fromBER(der), der };
}

describe('a CA with name constraints', () => {
  it('as a trusted issuer, does not vouch for an address outside its constraints', async () => {
    const ca = await constrainedCa('Corp Constrained CA');
    const leaf = await makeLeaf(ca, { emails: ['ceo@victim.example'] });
    const { status } = await smimeVerify(await signedCms(MESSAGE, leaf), 'ceo@victim.example', makeTrust({ issuers: [ca.der] }));
    expect(status.signerVerified).not.toBe(true);
  });

  it('as an intermediate under a trusted root, does not vouch for an address outside its constraints', async () => {
    const root = await makeCa('Public Mail Root');
    const sub = await constrainedCa('Corp Sub-CA', root);
    const leaf = await makeLeaf(sub, { emails: ['ceo@victim.example'] });
    const { status } = await smimeVerify(await signedCms(MESSAGE, leaf, [sub.der]), 'ceo@victim.example', makeTrust({ issuers: [root.der] }));
    expect(status.signerVerified).not.toBe(true);
  });

  it('does not vouch inside its constraints either, critical or not, and the details say why', async () => {
    for (const critical of [false, true]) {
      const root = await makeCa('Public Mail Root');
      const sub = await constrainedCa('Corp Sub-CA', root, { critical });
      const leaf = await makeLeaf(sub, { emails: ['ann@corp.example'] });
      const { status } = await smimeVerify(await signedCms(MESSAGE, leaf, [sub.der]), 'ann@corp.example', makeTrust({ issuers: [root.der] }));
      expect(status.signerVerified, `critical ${critical}`).toBe(false);
      expect(status.trustReasons, `critical ${critical}`).toEqual(['issuer', 'constraints']);
    }
  });

  it('counts as unable to issue, so the settings refuse it as a trusted issuer', async () => {
    const ca = await constrainedCa('Corp Constrained CA');
    expect(issuerCapabilities(ca.cert)).toMatchObject({ canIssue: false, isCa: true, constrained: true });
    expect(issuerCapabilities((await makeCa('Plain CA')).cert)).toMatchObject({ canIssue: true, constrained: false });
  });
});
