/**
 * CMS AuthEnvelopedData (RFC 5083): what Stalwart writes when it encrypts
 * mail at rest with AES-256-GCM or ChaCha20-Poly1305 (RFC 8103; not in
 * WebCrypto, so @noble/ciphers). pkijs has no class for it, so this parses
 * the structure itself and reuses pkijs only for the parts it shares with
 * EnvelopedData (RecipientInfo, EncryptedContentInfo).
 *
 *   AuthEnvelopedData ::= SEQUENCE {
 *     version CMSVersion,
 *     originatorInfo [0] IMPLICIT OriginatorInfo OPTIONAL,
 *     recipientInfos RecipientInfos,
 *     authEncryptedContentInfo EncryptedContentInfo,
 *     authAttrs [1] IMPLICIT AuthAttributes OPTIONAL,
 *     mac MessageAuthenticationCode,
 *     unauthAttrs [2] IMPLICIT UnauthAttributes OPTIONAL }
 */

import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { getLinerCrypto } from './crypto-engine.js';

export const OID_AUTH_ENVELOPED_DATA = '1.2.840.113549.1.9.16.1.23';

const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_RSAES_OAEP = '1.2.840.113549.1.1.7';
const OID_MGF1 = '1.2.840.113549.1.1.8';
const OID_P_SPECIFIED = '1.2.840.113549.1.1.9';

const HASHES = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

// Names for the error message when a message uses something we can't read.
const ALGORITHM_NAMES = {
  '2.16.840.1.101.3.4.1.26': 'AES-192-GCM', // no AES-192 in Chrome's WebCrypto
  '2.16.840.1.101.3.4.1.7': 'AES-128-CCM',
  '2.16.840.1.101.3.4.1.27': 'AES-192-CCM',
  '2.16.840.1.101.3.4.1.47': 'AES-256-CCM',
  '1.2.840.113549.3.2': 'RC2-CBC', // not in webcrypto-liner
  '1.2.392.200011.61.1.1.1.2': 'Camellia-128-CBC',
  '1.2.392.200011.61.1.1.1.3': 'Camellia-192-CBC',
  '1.2.392.200011.61.1.1.1.4': 'Camellia-256-CBC',
};

/** The banner shows `algorithm` (a name, or the OID when we have none). */
export class UnsupportedAlgorithmError extends Error {
  constructor(oidOrName) {
    const algorithm = ALGORITHM_NAMES[oidOrName] || oidOrName;
    super(`Unsupported encryption algorithm ${algorithm}`);
    this.name = 'UnsupportedAlgorithmError';
    this.algorithm = algorithm;
  }
}

const isContext = (el, n) => el && el.idBlock.tagClass === 3 && el.idBlock.tagNumber === n;

/** Parse AuthEnvelopedData from the asn1js value of a ContentInfo. */
export function parseAuthEnvelopedData(schema) {
  const items = schema instanceof asn1js.Sequence ? schema.valueBlock.value : [];
  let i = 0;
  if (!(items[i++] instanceof asn1js.Integer)) throw new Error('Invalid AuthEnvelopedData: no version');
  if (isContext(items[i], 0)) i++; // originatorInfo: certificates we don't need
  const recipientSet = items[i++];
  if (!(recipientSet instanceof asn1js.Set)) throw new Error('Invalid AuthEnvelopedData: no recipientInfos');
  const recipientInfos = recipientSet.valueBlock.value.map((el) => new pkijs.RecipientInfo({ schema: el }));
  const encryptedContentInfo = new pkijs.EncryptedContentInfo({ schema: items[i++] });

  // The MAC covers the authenticated attributes as DER with the SET OF tag,
  // not the [1] they are sent with (RFC 5083 §2.2).
  let aad;
  if (isContext(items[i], 1)) {
    aad = new Uint8Array(items[i++].valueBeforeDecodeView);
    aad[0] = 0x31;
  }

  const mac = items[i++];
  if (!(mac instanceof asn1js.OctetString)) throw new Error('Invalid AuthEnvelopedData: no mac');
  return { recipientInfos, encryptedContentInfo, mac: new Uint8Array(mac.getValue()), aad };
}

// ── Content encryption ───────────────────────────────────────────────

function concat(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out;
}

// GCMParameters ::= SEQUENCE { aes-nonce OCTET STRING, aes-ICVlen INTEGER DEFAULT 12 }
async function aesGcmDecrypt(cek, params, ciphertext, mac, aad) {
  const fields = params instanceof asn1js.Sequence ? params.valueBlock.value : [];
  if (!(fields[0] instanceof asn1js.OctetString)) throw new Error('Invalid AES-GCM parameters');
  const nonce = fields[0].getValue();
  const icvLen = fields[1] instanceof asn1js.Integer ? fields[1].valueBlock.valueDec : 12;
  if (mac.byteLength !== icvLen) throw new Error('AES-GCM tag length does not match its parameters');
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: icvLen * 8, ...(aad ? { additionalData: aad } : {}) },
    key,
    concat(ciphertext, mac),
  );
}

// AEAD_CHACHA20_POLY1305 parameters: the 12-byte nonce as an OCTET STRING.
async function chacha20Poly1305Decrypt(cek, params, ciphertext, mac, aad) {
  if (!(params instanceof asn1js.OctetString)) throw new Error('Invalid ChaCha20-Poly1305 parameters');
  const nonce = new Uint8Array(params.getValue());
  if (nonce.byteLength !== 12) throw new Error('ChaCha20-Poly1305 nonce must be 12 bytes');
  if (mac.byteLength !== 16) throw new Error('ChaCha20-Poly1305 tag must be 16 bytes');
  return chacha20poly1305(new Uint8Array(cek), nonce, aad).decrypt(concat(ciphertext, mac));
}

const CIPHERS = {
  '2.16.840.1.101.3.4.1.6': { keyLength: 16, decrypt: aesGcmDecrypt },
  '2.16.840.1.101.3.4.1.46': { keyLength: 32, decrypt: aesGcmDecrypt },
  '1.2.840.113549.1.9.16.3.18': { keyLength: 32, decrypt: chacha20Poly1305Decrypt },
};

/** The content cipher of a message, or UnsupportedAlgorithmError. */
export function authCipher(encryptedContentInfo) {
  const { algorithmId, algorithmParams } = encryptedContentInfo.contentEncryptionAlgorithm;
  const cipher = CIPHERS[algorithmId];
  if (!cipher) throw new UnsupportedAlgorithmError(algorithmId);
  return {
    decrypt(cek, envelope) {
      if (cek.byteLength !== cipher.keyLength) throw new Error('Content key has the wrong length');
      const ciphertext = encryptedContentInfo.getEncryptedContent();
      return cipher.decrypt(cek, algorithmParams, ciphertext, envelope.mac, envelope.aad);
    },
  };
}

// ── Key transport ────────────────────────────────────────────────────

// RSAES-OAEP-params (RFC 4055): [0] hash, [1] MGF, [2] label source; all
// default to SHA-1 / MGF1-SHA-1 / empty label.
function oaepParams(params) {
  let hash = 'SHA-1';
  let mgfHash = 'SHA-1';
  let label;
  const fields = params instanceof asn1js.Sequence ? params.valueBlock.value : [];
  for (const field of fields) {
    const alg = new pkijs.AlgorithmIdentifier({ schema: field.valueBlock.value[0] });
    if (isContext(field, 0)) {
      hash = HASHES[alg.algorithmId];
      if (!hash) throw new UnsupportedAlgorithmError(`RSA-OAEP with hash ${alg.algorithmId}`);
    } else if (isContext(field, 1)) {
      if (alg.algorithmId !== OID_MGF1) throw new UnsupportedAlgorithmError(`RSA-OAEP with mask ${alg.algorithmId}`);
      const mgfAlg = new pkijs.AlgorithmIdentifier({ schema: alg.algorithmParams });
      mgfHash = HASHES[mgfAlg.algorithmId];
    } else if (isContext(field, 2)) {
      if (alg.algorithmId !== OID_P_SPECIFIED) throw new UnsupportedAlgorithmError(`RSA-OAEP with label ${alg.algorithmId}`);
      const value = alg.algorithmParams instanceof asn1js.OctetString ? alg.algorithmParams.getValue() : new ArrayBuffer(0);
      if (value.byteLength > 0) label = value;
    }
  }
  // WebCrypto uses one hash for both.
  if (mgfHash !== hash) throw new UnsupportedAlgorithmError(`RSA-OAEP with ${hash} and MGF1-${mgfHash || 'unknown'}`);
  return { hash, label };
}

/** What api.keystore.decrypt needs to know, as the message says it. */
export function keyTransScheme(ktri) {
  const { algorithmId, algorithmParams } = ktri.keyEncryptionAlgorithm;
  if (algorithmId === OID_RSA_ENCRYPTION) return { scheme: 'rsa-pkcs1' };
  if (algorithmId !== OID_RSAES_OAEP) throw new UnsupportedAlgorithmError(algorithmId);
  const { hash, label } = oaepParams(algorithmParams);
  return { scheme: 'rsa-oaep', hash, ...(label ? { label: new Uint8Array(label) } : {}) };
}

/**
 * The content key from a KeyTransRecipientInfo, or undefined when the key it
 * needs isn't unlocked. keys: { rsaOaepKey(id, hash), legacyUnlockedKeys, keystoreKeys }.
 */
export async function unwrapContentKey(ktri, keyRecordId, keys) {
  const { algorithmId, algorithmParams } = ktri.keyEncryptionAlgorithm;
  const encryptedKey = ktri.encryptedKey.valueBlock.valueHexView;
  const osKey = keys.keystoreKeys?.get(keyRecordId);
  if (osKey) return osKey.keystore.decrypt(new Uint8Array(encryptedKey), keyTransScheme(ktri));
  if (algorithmId === OID_RSAES_OAEP) {
    const { hash, label } = oaepParams(algorithmParams);
    const key = await keys.rsaOaepKey?.(keyRecordId, hash);
    if (!key) return undefined;
    return crypto.subtle.decrypt({ name: 'RSA-OAEP', ...(label ? { label } : {}) }, key, encryptedKey);
  }
  if (algorithmId === OID_RSA_ENCRYPTION) {
    const key = keys.legacyUnlockedKeys?.get(keyRecordId);
    if (!key) return undefined;
    return getLinerCrypto().subtle.decrypt({ name: 'RSAES-PKCS1-v1_5' }, key, encryptedKey);
  }
  throw new UnsupportedAlgorithmError(algorithmId);
}
