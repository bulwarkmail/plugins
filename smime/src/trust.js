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
//    valid signature, in its dates, a CA flag and certificate signing allowed, or the
//    certificate itself is a trusted signer certificate;
//  - key usage allows signing and extended key usage allows mail, where present;
//  - the mail signature is not made with SHA-1 or MD5 (nor is any certificate below the
//    trusted issuer);
//  - the mail's From address is one of the addresses the certificate names.
// Revocation is not checked: nothing here goes to the network.

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
// Extensions a path may mark critical: the ones read here, and the policy ones (no policy
// is required, so they restrict nothing).
const KNOWN_CRITICAL = new Set([
  '2.5.29.14', '2.5.29.15', '2.5.29.17', '2.5.29.18', '2.5.29.19', '2.5.29.32', '2.5.29.35',
  '2.5.29.36', '2.5.29.37', '2.5.29.54',
]);
// Intermediate certificates between a signer and a trusted issuer.
const MAX_INTERMEDIATES = 6;

/** Why a signer is not verified, as the details panel words it. */
export const REASONS = ['issuer', 'self', 'usage', 'digest', 'from'];

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

/**
 * The trusted issuer a path from `cert` ends at, or null. `pool` holds the other
 * certificates of the message. `below` counts the certificates under `cert` that use up
 * a pathLenConstraint (not self-issued ones, RFC 5280 6.1.4).
 */
async function pathToAnchor(cert, pool, anchors, now, seen, below, problems) {
  if (seen.length > MAX_INTERMEDIATES) return null;
  const candidates = [...anchors.map((c) => [c, true]), ...pool.map((c) => [c, false])];
  for (const [issuer, isAnchor] of candidates) {
    if (sameCert(issuer, cert) || seen.some((s) => sameCert(s, issuer))) continue;
    if (!cert.issuer.isEqual(issuer.subject)) continue;
    const { canIssue, pathLength } = issuerCapabilities(issuer);
    if (!canIssue || !withinDates(issuer, now) || unknownCritical(issuer)) continue;
    if (pathLength !== undefined && below > pathLength) continue;
    let signed = false;
    try { signed = await cert.verify(issuer, nativeEngine()); } catch { signed = false; }
    if (!signed) continue;
    if (WEAK_SIGNATURES.has(cert.signatureAlgorithm.algorithmId)) {
      problems.add('digest');
      continue;
    }
    if (isAnchor) return issuer;
    const next = below + (selfIssued(issuer) ? 0 : 1);
    const found = await pathToAnchor(issuer, pool, anchors, now, [...seen, issuer], next, problems);
    if (found) return found;
  }
  return null;
}

/**
 * Who vouches for `cert`: { via: 'signer' } when its fingerprint is a trusted signer
 * certificate, { via: 'issuer', anchor } when a path from it leads to a trusted issuer
 * (`pool`: other certificates that may be intermediates), else { reasons } with 'self'
 * or 'issuer' (and 'digest' when a link was signed with SHA-1 or MD5).
 */
export async function vouchedFor(cert, { fingerprint, pool = [], trust, now = new Date() }) {
  if (trust && trust.pinned.has(String(fingerprint).toLowerCase())) return { via: 'signer', reasons: [] };
  const problems = new Set();
  const others = pool.filter((c) => c && c.tbsView && !sameCert(c, cert));
  const anchor = trust && trust.anchors.length && !unknownCritical(cert)
    ? await pathToAnchor(cert, others, trust.anchors, now, [], 0, problems)
    : null;
  if (anchor) return { via: 'issuer', anchor, reasons: [] };
  return { reasons: [selfIssued(cert) ? 'self' : 'issuer', ...problems] };
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

  const signerInfo = signedData.signerInfos?.[0];
  if (WEAK_DIGESTS.has(signerInfo?.digestAlgorithm?.algorithmId)
    || WEAK_SIGNATURES.has(signerInfo?.signatureAlgorithm?.algorithmId)) reasons.add('digest');

  const from = String(fromEmail || '').toLowerCase();
  if (!from || !addresses.includes(from)) reasons.add('from');

  return {
    verified: !!via && reasons.size === 0,
    via,
    anchor,
    reasons: REASONS.filter((r) => reasons.has(r)),
  };
}
