/**
 * ECDH mail: the content key from a KeyAgreeRecipientInfo (RFC 5753), ephemeral-static
 * with the ANSI X9.63 KDF and AES key wrap.
 *
 * Not pkijs' own path, for two reasons. Its ECC-CMS-SharedInfo always carries an
 * entityUInfo, empty without a UKM, so the key it derives doesn't match mail from
 * OpenSSL. And an imported key is non-extractable, which webcrypto-liner refuses.
 */

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { aeskw } from '@noble/ciphers/aes.js';
import { UnsupportedAlgorithmError } from './auth-enveloped.js';

const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';

// dhSinglePass-stdDH and -cofactorDH. The NIST curves have cofactor 1, so they're the same.
const KDF_HASHES = {
  '1.3.133.16.840.63.0.2': 'SHA-1',
  '1.3.132.1.11.1': 'SHA-256',
  '1.3.132.1.11.2': 'SHA-384',
  '1.3.132.1.11.3': 'SHA-512',
  '1.3.133.16.840.63.0.3': 'SHA-1',
  '1.3.132.1.14.1': 'SHA-256',
  '1.3.132.1.14.2': 'SHA-384',
  '1.3.132.1.14.3': 'SHA-512',
};
const WRAP_BITS = {
  '2.16.840.1.101.3.4.1.5': 128,
  '2.16.840.1.101.3.4.1.25': 192,
  '2.16.840.1.101.3.4.1.45': 256,
};
const CURVES = {
  '1.2.840.10045.3.1.7': { name: 'P-256', bits: 256 },
  '1.3.132.0.34': { name: 'P-384', bits: 384 },
  '1.3.132.0.35': { name: 'P-521', bits: 528 }, // 521 bits, in whole bytes
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part), at);
    at += part.byteLength;
  }
  return out;
}

// The sender's one-time key as a SubjectPublicKeyInfo. Senders leave the curve out, as
// RFC 5753 allows: it's the recipient certificate's.
function originatorSpki(kari, curveOid) {
  if (kari.originator.variant !== 3) throw new UnsupportedAlgorithmError('static ECDH');
  const algorithm = new pkijs.AlgorithmIdentifier({
    algorithmId: OID_EC_PUBLIC_KEY,
    algorithmParams: new asn1js.ObjectIdentifier({ value: curveOid }),
  });
  return new asn1js.Sequence({
    value: [algorithm.toSchema(), new asn1js.BitString({ valueHex: kari.originator.value.publicKey.valueBlock.valueHexView })],
  }).toBER(false);
}

async function x963Kdf(hash, secret, sharedInfo, bytes) {
  const blocks = [];
  let have = 0;
  for (let counter = 1; have < bytes; counter++) {
    const block = await crypto.subtle.digest(hash, concat(secret, new Uint8Array([0, 0, 0, counter]), sharedInfo));
    blocks.push(block);
    have += block.byteLength;
  }
  return concat(...blocks).slice(0, bytes);
}

function sharedInfo(wrapOid, wrapBits, ukm, withNullParams) {
  const length = new DataView(new ArrayBuffer(4));
  length.setUint32(0, wrapBits);
  return new pkijs.ECCCMSSharedInfo({
    keyInfo: new pkijs.AlgorithmIdentifier({
      algorithmId: wrapOid,
      ...(withNullParams ? { algorithmParams: new asn1js.Null() } : {}),
    }),
    ...(ukm ? { entityUInfo: ukm } : {}),
    suppPubInfo: new asn1js.OctetString({ valueHex: length.buffer }),
  }).toSchema().toBER(false);
}

/**
 * The content key. `privateKey` is an imported ECDH CryptoKey, or an OS key's handle,
 * which asks api.keystore.agree. `certificate` is the recipient's, parsed.
 */
export async function unwrapKeyAgree(kari, encryptedKey, privateKey, certificate) {
  const { algorithmId, algorithmParams } = kari.keyEncryptionAlgorithm;
  const hash = KDF_HASHES[algorithmId];
  if (!hash) throw new UnsupportedAlgorithmError(`ECDH ${algorithmId}`);
  const wrapOid = new pkijs.AlgorithmIdentifier({ schema: algorithmParams }).algorithmId;
  const wrapBits = WRAP_BITS[wrapOid];
  if (!wrapBits) throw new UnsupportedAlgorithmError(`ECDH with key wrap ${wrapOid}`);
  const curveOid = certificate.subjectPublicKeyInfo.algorithm.algorithmParams?.valueBlock?.toString();
  const curve = CURVES[curveOid];
  if (!curve) throw new UnsupportedAlgorithmError(`ECDH on curve ${curveOid}`);

  const spki = originatorSpki(kari, curveOid);
  const secret = privateKey.keystore
    ? await privateKey.keystore.agree(new Uint8Array(spki))
    : await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await crypto.subtle.importKey('spki', spki, { name: 'ECDH', namedCurve: curve.name }, false, []) },
      privateKey,
      curve.bits,
    );

  const wrapped = new Uint8Array(encryptedKey.encryptedKey.valueBlock.valueHexView);
  // RFC 5753 has no parameters here, and some senders write NULL.
  try {
    return await unwrap(hash, secret, sharedInfo(wrapOid, wrapBits, kari.ukm, false), wrapBits, wrapped);
  } catch {
    return unwrap(hash, secret, sharedInfo(wrapOid, wrapBits, kari.ukm, true), wrapBits, wrapped);
  }
}

async function unwrap(hash, secret, info, wrapBits, wrapped) {
  return aeskw(await x963Kdf(hash, secret, info, wrapBits / 8)).decrypt(wrapped);
}
