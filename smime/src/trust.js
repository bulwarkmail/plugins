// Whose signature counts as verified.
//
// A browser gives a page no access to the system's trusted roots, so the plugin has its
// own list: trusted issuers (certificates the user imports in the settings, and the PEM
// text an admin puts into the plugin's `trustedIssuers` setting) and trusted signer
// certificates (single certificates kept by fingerprint: ones the user trusted from a
// signed mail, and recipient certificates the user imported by hand).
//
// A signer is verified when the signature is intact and the certificate in its dates
// (smime-verify.js checks both), and all of this holds:
//  - a path leads from the signer certificate to a trusted issuer, each link with a
//    valid signature, in its dates, a CA flag and certificate signing allowed, and no
//    name constraints (they are not checked here, so a CA that carries them can't
//    vouch), or the certificate itself is a trusted signer certificate;
//  - key usage allows signing and extended key usage allows mail, where present;
//  - the mail signature is not made with SHA-1 or MD5 (nor is any certificate below the
//    trusted issuer);
//  - the mail's From address is one of the addresses the certificate names;
//  - no key on the path (the signer's included) is shorter than RSA 2048 bits or an
//    elliptic curve of 256 bits.
// Revocation is not checked: nothing here goes to the network.

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { classifyCapabilities, issuerCapabilities, parseCertificateDer } from './certificate-utils.js';
import { nativeEngine } from './crypto-engine.js';

// Digest algorithms: MD2, MD4, MD5, SHA-1.
const WEAK_DIGESTS = new Set(['1.2.840.113549.2.2', '1.2.840.113549.2.4', '1.2.840.113549.2.5', '1.3.14.3.2.26']);
// Signature algorithms with one of those built in: md2/md4/md5/sha1WithRSAEncryption,
// ecdsa-with-SHA1, dsa-with-sha1.
const WEAK_SIGNATURES = new Set([
  '1.2.840.113549.1.1.2', '1.2.840.113549.1.1.3', '1.2.840.113549.1.1.4', '1.2.840.113549.1.1.5',
  '1.2.840.10045.4.1', '1.2.840.10040.4.3', '1.3.14.3.2.29',
]);
const RSA_PSS = '1.2.840.113549.1.1.10';

/**
 * Whether a signature algorithm hashes with SHA-1 or MD5: one of the fixed ones, or RSA-PSS
 * whose hash or mask generation hash is (RFC 4055 makes both SHA-1 when left out).
 */
export function weakSignatureAlgorithm(algorithm) {
  if (!algorithm) return false;
  if (WEAK_SIGNATURES.has(algorithm.algorithmId)) return true;
  if (algorithm.algorithmId !== RSA_PSS) return false;
  try {
    const params = algorithm.algorithmParams instanceof asn1js.Sequence
      ? new pkijs.RSASSAPSSParams({ schema: algorithm.algorithmParams })
      : new pkijs.RSASSAPSSParams();
    const mgfHash = new pkijs.AlgorithmIdentifier({ schema: params.maskGenAlgorithm.algorithmParams });
    return WEAK_DIGESTS.has(params.hashAlgorithm.algorithmId) || WEAK_DIGESTS.has(mgfHash.algorithmId);
  } catch {
    return true;
  }
}

// Elliptic curves by their size in bits: NIST P-192, P-224, P-256, P-384, P-521, secp256k1,
// brainpoolP160r1 to P512r1.
const CURVE_BITS = {
  '1.2.840.10045.3.1.1': 192, '1.3.132.0.33': 224, '1.2.840.10045.3.1.7': 256, '1.3.132.0.34': 384, '1.3.132.0.35': 521,
  '1.3.132.0.10': 256, '1.3.36.3.3.2.8.1.1.1': 160, '1.3.36.3.3.2.8.1.1.3': 192, '1.3.36.3.3.2.8.1.1.5': 224,
  '1.3.36.3.3.2.8.1.1.7': 256, '1.3.36.3.3.2.8.1.1.9': 320, '1.3.36.3.3.2.8.1.1.11': 384, '1.3.36.3.3.2.8.1.1.13': 512,
};
const MIN_RSA_BITS = 2048;
const MIN_CURVE_BITS = 256;

/**
 * Whether the certificate's key is too short: RSA under 2048 bits, an elliptic curve under
 * 256 bits, or a curve or algorithm the plugin doesn't know (Ed25519 and Ed448 are fine).
 */
export function weakKey(cert) {
  const spki = cert.subjectPublicKeyInfo;
  const algorithm = spki.algorithm.algorithmId;
  if (algorithm === '1.2.840.113549.1.1.1' || algorithm === RSA_PSS) {
    try {
      const rsa = asn1js.fromBER(spki.subjectPublicKey.valueBlock.valueHexView).result;
      let modulus = new Uint8Array(rsa.valueBlock.value[0].valueBlock.valueHexView);
      let start = 0;
      while (start < modulus.length - 1 && modulus[start] === 0) start++;
      modulus = modulus.subarray(start);
      const bits = (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0]));
      return bits < MIN_RSA_BITS;
    } catch {
      return true;
    }
  }
  if (algorithm === '1.2.840.10045.2.1') {
    const curve = spki.algorithm.algorithmParams instanceof asn1js.ObjectIdentifier
      ? spki.algorithm.algorithmParams.valueBlock.toString() : '';
    return !(CURVE_BITS[curve] >= MIN_CURVE_BITS);
  }
  return !(algorithm === '1.3.101.112' || algorithm === '1.3.101.113');
}
// Extensions a path may mark critical: the ones read here, the policy ones (no policy is
// required, so they restrict nothing), and name constraints (a CA that carries them, critical
// or not, can't issue: issuerCapabilities).
const KNOWN_CRITICAL = new Set([
  '2.5.29.14', '2.5.29.15', '2.5.29.17', '2.5.29.18', '2.5.29.19', '2.5.29.30', '2.5.29.32', '2.5.29.35',
  '2.5.29.36', '2.5.29.37', '2.5.29.54',
]);
// Bounds on the path search. A message can carry many certificates, made so that each
// verifies as the issuer of the others; the search drops duplicates, remembers which
// certificates led nowhere, and stops at these. Reaching one reads "not verified".
export const MAX_PATH = 8; // certificates in a path, the signer's and the trusted issuer's included
export const MAX_CHECKS = 64; // signature checks for one certificate's path
export const MAX_POOL = 32; // certificates of a message the search looks at (the first ones)

/** Why a signer is not verified, as the details panel words it. */
export const REASONS = ['issuer', 'self', 'constraints', 'limit', 'usage', 'digest', 'weakKey', 'from'];

/**
 * The trust a verification works with. `issuers` are certificate DERs, `pinned` are
 * SHA-256 fingerprints as computeFingerprint writes them.
 */
export function makeTrust({ issuers = [], pinned = [] } = {}) {
  const anchors = [];
  for (const der of issuers) {
    try { anchors.push(parseCertificateDer(der)); } catch { /* not a certificate: skipped */ }
  }
  return { anchors, pinned: new Set(pinned.map((fp) => String(fp).toLowerCase())) };
}

const sameCert = (a, b) => {
  const x = new Uint8Array(a.tbsView);
  const y = new Uint8Array(b.tbsView);
  if (x.length !== y.length || x.length === 0) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

const withinDates = (cert, now) => !(cert.notBefore.value > now) && !(cert.notAfter.value < now);

const unknownCritical = (cert) => (cert.extensions || []).some((e) => e.critical && !KNOWN_CRITICAL.has(e.extnID));

const selfIssued = (cert) => cert.subject.isEqual(cert.issuer);

const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

// Certificates with the same subject, issuer and key are interchangeable as links.
const linkKey = (cert) => [
  hex(cert.subject.toSchema().toBER(false)),
  hex(cert.issuer.toSchema().toBER(false)),
  hex(cert.subjectPublicKeyInfo.toSchema().toBER(false)),
].join('|');

// One certificate per subject, issuer and key, the first one in its dates where there is one.
function distinct(certs, now) {
  const kept = new Map();
  for (const cert of certs) {
    const key = linkKey(cert);
    const earlier = kept.get(key);
    if (!earlier || (!withinDates(earlier, now) && withinDates(cert, now))) kept.set(key, cert);
  }
  return [...kept.values()];
}

/**
 * The trusted issuer a path from `cert` ends at, or null. `path` is the path so far, from
 * the signer to `cert`. `below` counts the certificates under `cert` that use up a
 * pathLenConstraint (not self-issued ones, RFC 5280 6.1.4). `search` holds the anchors,
 * the message's certificates, the signature checks made, the certificates that led
 * nowhere (with the smallest `below` they were tried at) and the problems seen.
 */
async function pathToAnchor(cert, path, below, search) {
  if (path.length >= MAX_PATH) return null;
  const candidates = [...search.anchors.map((c) => [c, true]), ...search.pool.map((c) => [c, false])];
  for (const [issuer, isAnchor] of candidates) {
    if (path.some((p) => sameCert(p, issuer))) continue;
    if (!cert.issuer.isEqual(issuer.subject)) continue;
    const next = below + (selfIssued(issuer) ? 0 : 1);
    const key = linkKey(issuer);
    if (!isAnchor && search.deadEnds.has(key) && search.deadEnds.get(key) <= next) continue;
    // A CA with name constraints is checked like the others, so the details can say it was
    // the one in the way, and then not used.
    const { isCa, pathLength, constrained } = issuerCapabilities(issuer);
    if (!isCa || !withinDates(issuer, search.now) || unknownCritical(issuer)) continue;
    if (pathLength !== undefined && below > pathLength) continue;
    if (search.checks >= MAX_CHECKS) {
      search.problems.add('limit');
      return null;
    }
    search.checks++;
    let signed = false;
    try { signed = await cert.verify(issuer, nativeEngine()); } catch { signed = false; }
    if (!signed) continue;
    if (constrained) {
      search.problems.add('constraints');
      continue;
    }
    if (weakSignatureAlgorithm(cert.signatureAlgorithm)) {
      search.problems.add('digest');
      continue;
    }
    if (weakKey(issuer)) {
      search.problems.add('weakKey');
      continue;
    }
    if (isAnchor) return issuer;
    const found = await pathToAnchor(issuer, [...path, issuer], next, search);
    if (found) return found;
    if (search.problems.has('limit')) return null;
    search.deadEnds.set(key, Math.min(search.deadEnds.get(key) ?? Infinity, next));
  }
  return null;
}

/**
 * Who vouches for `cert`: { via: 'signer' } when its fingerprint is a trusted signer
 * certificate, { via: 'issuer', anchor } when a path from it leads to a trusted issuer
 * (`pool`: other certificates that may be intermediates), else { reasons } with 'self'
 * or 'issuer', and 'constraints' when a CA on the way carries name constraints, 'limit'
 * when the search stopped at one of its bounds, 'digest' when a link was signed with
 * SHA-1 or MD5, 'weakKey' when an issuer's key is too short. Of `pool` only the first
 * MAX_POOL distinct certificates are used.
 */
export async function vouchedFor(cert, { fingerprint, pool = [], trust, now = new Date() }) {
  if (trust && trust.pinned.has(String(fingerprint).toLowerCase())) return { via: 'signer', reasons: [] };
  const others = distinct(pool.filter((c) => c && c.tbsView && !sameCert(c, cert)), now);
  const search = {
    anchors: distinct(trust ? trust.anchors : [], now),
    pool: others.slice(0, MAX_POOL),
    now,
    checks: 0,
    deadEnds: new Map(),
    problems: new Set(),
  };
  const anchor = search.anchors.length && !unknownCritical(cert) ? await pathToAnchor(cert, [cert], 0, search) : null;
  if (anchor) return { via: 'issuer', anchor, reasons: [] };
  if (others.length > MAX_POOL) search.problems.add('limit');
  return { reasons: [selfIssued(cert) ? 'self' : 'issuer', ...search.problems] };
}

/**
 * Whether the signer of `signedData` (signer 0, whose certificate is `signerCert`) is
 * verified. `fingerprint` is the signer certificate's, `addresses` all addresses it
 * names (lower case). Returns { verified, via: 'issuer' | 'signer' | undefined, anchor
 * (the trusted issuer's certificate, for the details), reasons }.
 */
export async function evaluateSigner({ signedData, signerCert, fingerprint, addresses, fromEmail, trust, now = new Date() }) {
  const vouched = await vouchedFor(signerCert, { fingerprint, pool: signedData.certificates || [], trust, now });
  const reasons = new Set(vouched.reasons);
  const { via, anchor } = vouched;

  if (!classifyCapabilities(signerCert).canSign) reasons.add('usage');
  if (weakKey(signerCert)) reasons.add('weakKey');

  const signerInfo = signedData.signerInfos?.[0];
  if (WEAK_DIGESTS.has(signerInfo?.digestAlgorithm?.algorithmId)
    || weakSignatureAlgorithm(signerInfo?.signatureAlgorithm)) reasons.add('digest');

  const from = String(fromEmail || '').toLowerCase();
  if (!from || !addresses.includes(from)) reasons.add('from');

  return {
    verified: !!via && reasons.size === 0,
    via,
    anchor,
    reasons: REASONS.filter((r) => reasons.has(r)),
  };
}
