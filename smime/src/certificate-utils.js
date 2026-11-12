// X.509 parsing + metadata extraction. Ported from lib/smime/certificate-utils.ts.

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { Convert } from 'pvtsutils';

const OID_EMAIL_PROTECTION = '1.3.6.1.5.5.7.3.4';
const OID_ANY_EXTENDED_KEY_USAGE = '2.5.29.37.0';
const OID_SAN = '2.5.29.17';

// ── PEM/DER conversions ──────────────────────────────────────────────

export function pemToDer(pem) {
  const lines = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s/g, '');
  return Convert.FromBase64(lines);
}

export function derToPem(der, label) {
  const b64 = Convert.ToBase64(der);
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

export function isPem(data) {
  return /-----BEGIN (CERTIFICATE|PKCS12|ENCRYPTED PRIVATE KEY|PRIVATE KEY)-----/.test(data);
}

/**
 * The DER of every CERTIFICATE block in a PEM text, as ArrayBuffers. Line breaks inside a
 * block don't matter, so text pasted into a one-line field still reads.
 */
export function pemCertificates(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]*?)-----END CERTIFICATE-----/g)) {
    const b64 = m[1].replace(/\s/g, '');
    if (b64) out.push(Convert.FromBase64(b64));
  }
  return out;
}

// ── Certificate parsing ──────────────────────────────────────────────

export function parseCertificateDer(der) {
  const asn1 = asn1js.fromBER(der);
  if (asn1.offset === -1) throw new Error('Invalid DER data: ASN.1 parsing failed');
  return new pkijs.Certificate({ schema: asn1.result });
}

export function parseCertificatePemOrDer(data) {
  if (typeof data === 'string') {
    if (isPem(data)) return parseCertificateDer(pemToDer(data));
    throw new Error('String input is not PEM-encoded');
  }
  const header = new Uint8Array(data, 0, Math.min(20, data.byteLength));
  const maybePem = String.fromCharCode(...header);
  if (maybePem.startsWith('-----BEGIN ')) {
    const text = new TextDecoder().decode(data);
    return parseCertificateDer(pemToDer(text));
  }
  return parseCertificateDer(data);
}

// ── Metadata extraction ──────────────────────────────────────────────

/** A name (subject or issuer) as "CN=…, O=…". */
export function rdnToString(rdn) {
  return rdn.typesAndValues
    .map((tv) => `${oidToName(tv.type)}=${tv.value.valueBlock.value}`)
    .join(', ');
}

function oidToName(oid) {
  const map = {
    '2.5.4.3': 'CN',
    '2.5.4.6': 'C',
    '2.5.4.7': 'L',
    '2.5.4.8': 'ST',
    '2.5.4.10': 'O',
    '2.5.4.11': 'OU',
    '1.2.840.113549.1.9.1': 'E',
  };
  return map[oid] ?? oid;
}

export async function computeFingerprint(der) {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(der));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

function extractAlgorithm(cert) {
  const algOid = cert.subjectPublicKeyInfo.algorithm.algorithmId;
  if (algOid === '1.2.840.113549.1.1.1') {
    const pubKey = cert.subjectPublicKeyInfo;
    try {
      const asn1Pub = asn1js.fromBER(pubKey.subjectPublicKey.valueBlock.valueHexView);
      const seq = asn1Pub.result;
      const modulus = seq.valueBlock.value[0];
      const bitLen = (modulus.valueBlock.valueHexView.byteLength - 1) * 8;
      return `RSA-${bitLen}`;
    } catch {
      return 'RSA';
    }
  }
  if (algOid === '1.2.840.10045.2.1') {
    const params = cert.subjectPublicKeyInfo.algorithm.algorithmParams;
    if (params instanceof asn1js.ObjectIdentifier) {
      const curveOid = params.valueBlock.toString();
      const curves = {
        '1.2.840.10045.3.1.7': 'ECDSA-P256',
        '1.3.132.0.34': 'ECDSA-P384',
        '1.3.132.0.35': 'ECDSA-P521',
      };
      return curves[curveOid] ?? 'ECDSA';
    }
    return 'ECDSA';
  }
  return algOid;
}

// In the order of the KeyUsage BIT STRING (RFC 5280 §4.2.1.3). pkijs hands the
// extension over as that BitString, with no flags of its own.
const KEY_USAGE_BITS = [
  'digitalSignature', 'contentCommitment', 'keyEncipherment', 'dataEncipherment', 'keyAgreement',
  'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly',
];

function extractKeyUsage(cert) {
  const ext = cert.extensions?.find((e) => e.extnID === '2.5.29.15');
  if (!ext?.parsedValue) return undefined;
  const bytes = new Uint8Array(ext.parsedValue.valueBlock.valueHexView);
  return KEY_USAGE_BITS.filter((_, bit) => (bytes[bit >> 3] ?? 0) & (0x80 >> (bit & 7)));
}

function extractExtendedKeyUsage(cert) {
  const ext = cert.extensions?.find((e) => e.extnID === '2.5.29.37');
  if (!ext?.parsedValue) return undefined;
  return ext.parsedValue.keyPurposes;
}

function extractEmailAddresses(cert) {
  const emails = [];

  for (const tv of cert.subject.typesAndValues) {
    if (tv.type === '1.2.840.113549.1.9.1') {
      emails.push(tv.value.valueBlock.value);
    }
  }

  const sanExt = cert.extensions?.find((e) => e.extnID === OID_SAN);
  if (sanExt) {
    let names;
    const pv = sanExt.parsedValue;
    if (pv?.names) {
      names = pv.names;
    } else if (sanExt.extnValue) {
      try {
        const sanAsn1 = asn1js.fromBER(sanExt.extnValue.valueBlock.valueHexView);
        if (sanAsn1.offset !== -1) {
          names = new pkijs.GeneralNames({ schema: sanAsn1.result }).names;
        }
      } catch { /* malformed SAN — skip */ }
    }
    if (names) {
      for (const name of names) {
        if (name.type === 1 && typeof name.value === 'string' && !emails.includes(name.value)) {
          emails.push(name.value);
        }
      }
    }
  }

  return emails;
}

/**
 * Whether the certificate may issue certificates: basicConstraints with cA, keyCertSign
 * when a keyUsage extension is there, and no name constraints extension, critical or
 * not (`constrained`): the plugin doesn't check name constraints, so it relies on no CA
 * that carries them. `isCa` is the first two alone. `pathLength` is the
 * pathLenConstraint, undefined without one.
 */
export function issuerCapabilities(cert) {
  const bc = cert.extensions?.find((e) => e.extnID === '2.5.29.19')?.parsedValue;
  const ku = extractKeyUsage(cert);
  const constrained = !!cert.extensions?.some((e) => e.extnID === '2.5.29.30');
  const isCa = bc?.cA === true && (!ku || ku.includes('keyCertSign'));
  // pkijs keeps a number too large to read as an Integer object: no limit worth counting.
  const pathLength = typeof bc?.pathLenConstraint === 'number' ? bc.pathLenConstraint : undefined;
  return { canIssue: isCa && !constrained, isCa, pathLength, constrained };
}

/** Determine signing/encryption capabilities from KU / EKU. Tolerant of absent extensions. */
export function classifyCapabilities(cert) {
  const ku = extractKeyUsage(cert);
  const eku = extractExtendedKeyUsage(cert);

  let canSign = true;
  let canEncrypt = true;

  if (ku) {
    canSign = ku.includes('digitalSignature') || ku.includes('contentCommitment');
    canEncrypt = ku.includes('keyEncipherment') || ku.includes('dataEncipherment') || ku.includes('keyAgreement');
  }

  if (eku && eku.length > 0) {
    if (!eku.includes(OID_EMAIL_PROTECTION) && !eku.includes(OID_ANY_EXTENDED_KEY_USAGE)) {
      canSign = false;
      canEncrypt = false;
    }
  }

  return { canSign, canEncrypt };
}

/** Extract full metadata from a parsed certificate. */
export async function extractCertificateInfo(cert, der) {
  const fingerprint = await computeFingerprint(der);
  const ku = extractKeyUsage(cert);
  const eku = extractExtendedKeyUsage(cert);
  const capabilities = classifyCapabilities(cert);

  return {
    subject: rdnToString(cert.subject),
    issuer: rdnToString(cert.issuer),
    serialNumber: cert.serialNumber.valueBlock.valueHexView
      ? Array.from(new Uint8Array(cert.serialNumber.valueBlock.valueHexView))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(':')
      : cert.serialNumber.valueBlock.toString(),
    notBefore: cert.notBefore.value.toISOString(),
    notAfter: cert.notAfter.value.toISOString(),
    fingerprint,
    algorithm: extractAlgorithm(cert),
    keyUsage: ku,
    extendedKeyUsage: eku,
    emailAddresses: extractEmailAddresses(cert),
    capabilities,
  };
}
