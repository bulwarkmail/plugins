// Throwaway certificates for tests, made with pkijs: certificate authorities,
// intermediates and mail certificates with the extensions a test asks for. Keys are
// ECDSA P-256 and exist only in memory. Every name is fake (example.org, .example).
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { smimeSign } from '../../src/smime-sign.js';

const EC = { name: 'ECDSA', namedCurve: 'P-256' };
const DAY = 86_400_000;
const EMAIL_PROTECTION = '1.3.6.1.5.5.7.3.4';
const KEY_USAGE = ['digitalSignature', 'contentCommitment', 'keyEncipherment', 'dataEncipherment', 'keyAgreement',
  'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];

let serial = 1000;

function name(cn, email) {
  const rdn = [new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) })];
  if (email) rdn.push(new pkijs.AttributeTypeAndValue({ type: '1.2.840.113549.1.9.1', value: new asn1js.IA5String({ value: email }) }));
  return rdn;
}

function keyUsage(bits) {
  let value = 0;
  let last = 0;
  for (const bit of bits) {
    const i = KEY_USAGE.indexOf(bit);
    value |= 1 << (15 - i);
    last = Math.max(last, i);
  }
  const bytes = last >= 8 ? [value >> 8, value & 0xff] : [value >> 8];
  const bitString = new asn1js.BitString({ valueHex: new Uint8Array(bytes).buffer, unusedBits: bytes.length * 8 - (last + 1) });
  return new pkijs.Extension({ extnID: '2.5.29.15', critical: true, extnValue: bitString.toBER(false) });
}

function basicConstraints(ca, pathLen) {
  const bc = new pkijs.BasicConstraints(pathLen === undefined ? { cA: ca } : { cA: ca, pathLenConstraint: pathLen });
  return new pkijs.Extension({ extnID: '2.5.29.19', critical: true, extnValue: bc.toSchema().toBER(false) });
}

async function make({ cn, email, issuer, publicKey, signingKey, extensions, notBefore, notAfter, hash = 'SHA-256' }) {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: serial++ });
  cert.subject.typesAndValues.push(...name(cn, email));
  if (issuer) cert.issuer.typesAndValues.push(...issuer.cert.subject.typesAndValues);
  else cert.issuer.typesAndValues.push(...name(cn, email));
  cert.notBefore.value = notBefore ?? new Date(Date.now() - DAY);
  cert.notAfter.value = notAfter ?? new Date(Date.now() + 30 * DAY);
  cert.extensions = extensions;
  await cert.subjectPublicKeyInfo.importKey(publicKey);
  await cert.sign(signingKey, hash);
  const der = new Uint8Array(cert.toSchema(true).toBER(false));
  return { cert: pkijs.Certificate.fromBER(der), der };
}

/**
 * A certificate authority, self-signed unless `issuer` (another makeCa result) signs it.
 * `ca: false` leaves the CA flag out; `keyUsage` replaces keyCertSign + cRLSign.
 */
export async function makeCa(cn, { issuer, ca = true, pathLen, keyUsage: bits = ['keyCertSign', 'cRLSign'], notBefore, notAfter } = {}) {
  const key = await crypto.subtle.generateKey(EC, false, ['sign', 'verify']);
  const extensions = [basicConstraints(ca, pathLen), ...(bits ? [keyUsage(bits)] : [])];
  const made = await make({
    cn, issuer, publicKey: key.publicKey, signingKey: issuer ? issuer.key.privateKey : key.privateKey, extensions, notBefore, notAfter,
  });
  return { key, ...made };
}

/**
 * A mail certificate issued by `issuer` (or self-signed without one), for `emails` in its
 * alternative names and `subjectEmail` in its subject. `eku` null leaves extended key
 * usage out, `keyUsage` null leaves key usage out. `hash` is the issuer's signature hash.
 */
export async function makeLeaf(issuer, {
  cn = 'Mail user', emails = [], subjectEmail, keyUsage: bits = ['digitalSignature', 'keyAgreement'], eku = [EMAIL_PROTECTION],
  notBefore, notAfter, hash,
} = {}) {
  const key = await crypto.subtle.generateKey(EC, true, ['sign', 'verify']);
  const extensions = [basicConstraints(false)];
  if (bits) extensions.push(keyUsage(bits));
  if (eku) extensions.push(new pkijs.Extension({ extnID: '2.5.29.37', extnValue: new pkijs.ExtKeyUsage({ keyPurposes: eku }).toSchema().toBER(false) }));
  if (emails.length) {
    extensions.push(new pkijs.Extension({
      extnID: '2.5.29.17',
      extnValue: new pkijs.GeneralNames({ names: emails.map((value) => new pkijs.GeneralName({ type: 1, value })) }).toSchema().toBER(false),
    }));
  }
  const made = await make({
    cn, email: subjectEmail, issuer, publicKey: key.publicKey, signingKey: issuer ? issuer.key.privateKey : key.privateKey,
    extensions, notBefore, notAfter, hash,
  });
  return { key, ...made };
}

/** Opaque CMS SignedData over `content`, signed by `leaf`, carrying `chain` (DERs) as well. */
export async function signedCms(content, leaf, chain = []) {
  return new Uint8Array(await (await smimeSign(content, leaf.key.privateKey, leaf.der, chain)).arrayBuffer());
}

/** The same, with SHA-1 as the digest (what old clients wrote). */
export async function signedCmsSha1(content, leaf) {
  const cert = pkijs.Certificate.fromBER(leaf.der);
  const cms = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.7.1', eContent: new asn1js.OctetString({ valueHex: content }) }),
    signerInfos: [new pkijs.SignerInfo({ version: 1, sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }) })],
    certificates: [cert],
  });
  await cms.sign(leaf.key.privateKey, 0, 'SHA-1');
  return new Uint8Array(new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: cms.toSchema(true) }).toSchema().toBER(false));
}

/** A certificate as PEM text. */
export function pem(der) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** A whole message as a mail server stores it: one application/pkcs7-mime part around the CMS. */
export const OPAQUE_SIGNED = 'application/pkcs7-mime; smime-type=signed-data; name=smime.p7m';
export function opaqueMessage(cms, from) {
  const b64 = Buffer.from(cms).toString('base64').match(/.{1,76}/g).join('\r\n');
  return new TextEncoder().encode(`From: <${from}>\r\nMIME-Version: 1.0\r\nContent-Type: ${OPAQUE_SIGNED}\r\n`
    + `Content-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`);
}
