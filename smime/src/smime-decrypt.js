/**
 * Decrypt CMS EnvelopedData or AuthEnvelopedData to recover the inner MIME
 * content. Supports issuerAndSerialNumber and subjectKeyIdentifier recipient
 * IDs. Ported from lib/smime/smime-decrypt.ts (Buffer → toHex).
 */

import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { getLinerCryptoEngine, withLinerEngine } from './crypto-engine.js';
import { arraysEqual, toHex } from './util.js';
import {
  OID_AUTH_ENVELOPED_DATA, UnsupportedAlgorithmError, parseAuthEnvelopedData, authCipher, keyTransScheme, unwrapContentKey,
} from './auth-enveloped.js';
import { unwrapKeyAgree } from './key-agree.js';
import { keystoreCode } from './os-keys.js';

export { UnsupportedAlgorithmError };

const OID_ENVELOPED_DATA = '1.2.840.113549.1.7.3';
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';

// Content ciphers pkijs + webcrypto-liner decrypt in EnvelopedData. Anything
// else fails in there with an error that reads like a wrong key.
const ENVELOPED_CIPHERS = new Set([
  '2.16.840.1.101.3.4.1.2', '2.16.840.1.101.3.4.1.22', '2.16.840.1.101.3.4.1.42', // AES-CBC
  '2.16.840.1.101.3.4.1.6', '2.16.840.1.101.3.4.1.26', '2.16.840.1.101.3.4.1.46', // AES-GCM, as this plugin sends it
  '1.2.840.113549.3.7', '1.3.14.3.2.7', // DES-EDE3-CBC, DES-CBC
]);

const AUTHENTICATED_CIPHERS = new Set([
  '2.16.840.1.101.3.4.1.6', '2.16.840.1.101.3.4.1.26', '2.16.840.1.101.3.4.1.46',
]);

export class SmimeNoKeyError extends Error {
  constructor() {
    super('No imported S/MIME key matches any recipient in this encrypted message');
    this.name = 'SmimeNoKeyError';
  }
}

export class SmimeKeyLockedError extends Error {
  constructor(message, keyRecordId) {
    super(message);
    this.name = 'SmimeKeyLockedError';
    this.keyRecordId = keyRecordId;
  }
}

/**
 * Attempt to decrypt CMS EnvelopedData or AuthEnvelopedData.
 * @param input { cmsBytes, keyRecords, unlockedKeys: Map, legacyUnlockedKeys?: Map,
 *                rsaOaepKey?: (keyRecordId, hash) => Promise<CryptoKey|undefined>,
 *                keystoreKeys?: Map }
 *              (the keys as session-keys.js unlockedDecryptMaps returns them, and
 *              os-keys.js addDecryptKeys adds)
 * @returns { mimeBytes: Uint8Array, keyRecordId: string, integrity: boolean }. integrity
 *          is false for a content cipher without authentication, CBC, whose plaintext
 *          an attacker can reshape without knowing the key (EFAIL).
 * @throws SmimeNoKeyError when no key fits a recipient, and an api.keystore error (see
 *         os-keys.js) when the user said no or the store is busy, and no imported key is
 *         left that the user could unlock instead
 */
export async function smimeDecrypt(input) {
  const { cmsBytes, keyRecords, unlockedKeys, legacyUnlockedKeys } = input;

  const contentInfo = parseContentInfo(cmsBytes);
  const envelopedData = extractEnvelopedData(contentInfo);

  const matchedRecords = inTryOrder(findMatchingKeyRecords(envelopedData, keyRecords), input);
  if (matchedRecords.length === 0) throw new SmimeNoKeyError();

  if (envelopedData.mac) return decryptAuthEnveloped(envelopedData, matchedRecords, input);

  const contentOid = envelopedData.encryptedContentInfo.contentEncryptionAlgorithm.algorithmId;
  if (!ENVELOPED_CIPHERS.has(contentOid)) throw new UnsupportedAlgorithmError(contentOid);

  const integrity = AUTHENTICATED_CIPHERS.has(contentOid);
  const os = osAttempts();
  for (const match of matchedRecords) {
    const { keyRecord } = match;
    const osKey = input.keystoreKeys?.get(keyRecord.id);
    if (osKey) {
      if (!os.mayTry()) continue;
      try {
        const decrypted = await decryptWithKey(envelopedData, match, osKey, keyRecord);
        return { mimeBytes: new Uint8Array(decrypted), keyRecordId: keyRecord.id, integrity };
      } catch (err) {
        os.failed(err);
        continue;
      }
    }

    const privateKey = unlockedKeys.get(keyRecord.id);
    if (!privateKey) {
      const legacyKey = legacyUnlockedKeys?.get(keyRecord.id);
      if (legacyKey) {
        try {
          const decrypted = await decryptWithKey(envelopedData, match, legacyKey, keyRecord);
          return { mimeBytes: new Uint8Array(decrypted), keyRecordId: keyRecord.id, integrity };
        } catch {
          continue;
        }
      }
      continue;
    }

    try {
      const decrypted = await decryptWithKey(envelopedData, match, privateKey, keyRecord);
      return { mimeBytes: new Uint8Array(decrypted), keyRecordId: keyRecord.id, integrity };
    } catch {
      const legacyKey = legacyUnlockedKeys?.get(keyRecord.id);
      if (legacyKey) {
        try {
          const decrypted = await decryptWithKey(envelopedData, match, legacyKey, keyRecord);
          return { mimeBytes: new Uint8Array(decrypted), keyRecordId: keyRecord.id, integrity };
        } catch {
          /* try next record */
        }
      }
      continue;
    }
  }

  throwLockedOrFailed(matchedRecords, input, os.stopped());
}

async function decryptAuthEnveloped(envelope, matchedRecords, input) {
  const cipher = authCipher(envelope.encryptedContentInfo);
  const os = osAttempts();
  for (const { keyRecord, recipientIndex, encryptedKey } of matchedRecords) {
    const isOs = input.keystoreKeys?.has(keyRecord.id);
    if (isOs && !os.mayTry()) continue;
    try {
      const recipient = envelope.recipientInfos[recipientIndex].value;
      const cek = encryptedKey
        ? await agreedContentKey(recipient, encryptedKey, keyRecord, input)
        : await unwrapContentKey(recipient, keyRecord.id, input);
      if (!cek) continue; // locked
      const decrypted = await cipher.decrypt(cek, envelope);
      return { mimeBytes: new Uint8Array(decrypted), keyRecordId: keyRecord.id, integrity: true };
    } catch (err) {
      if (err instanceof UnsupportedAlgorithmError) throw err;
      if (isOs) os.failed(err);
      /* wrong key or a broken message: try the next record */
    }
  }
  throwLockedOrFailed(matchedRecords, input, os.stopped());
}

/**
 * An unlocked imported key needs no question, so it goes first. An OS key next,
 * which may ask. A locked imported key last: that ends in the unlock banner.
 */
function inTryOrder(matches, { unlockedKeys, legacyUnlockedKeys, keystoreKeys }) {
  const rank = ({ keyRecord: { id } }) => {
    if (unlockedKeys.has(id) || legacyUnlockedKeys?.has(id)) return 0;
    return keystoreKeys?.has(id) ? 1 : 2;
  };
  return matches.map((m, i) => [m, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([m]) => m);
}

/**
 * Once the user has said no, no further OS key gets asked about. Every other failure
 * moves on to the next key, an imported one if there is one. That goes for
 * keystore:invalid too: here the bytes come from the message, so that's a mangled
 * message and not our bug. A busy store is remembered, to say so if nothing works.
 */
function osAttempts() {
  let refused = null;
  let askFirst = null;
  let busy = null;
  return {
    mayTry: () => !refused,
    failed(err) {
      if (err instanceof UnsupportedAlgorithmError) throw err;
      const code = keystoreCode(err);
      if (code === 'cancelled') refused = err;
      if (code === 'ask-first') askFirst = err;
      if (code === 'locked') busy = err;
    },
    stopped: () => refused ?? askFirst ?? busy,
  };
}

function throwLockedOrFailed(matchedRecords, { unlockedKeys, legacyUnlockedKeys, keystoreKeys }, osError) {
  // An OS key fits and only needs the user's word. If they say no, a locked key still gets its turn.
  if (keystoreCode(osError) === 'ask-first') throw osError;
  const isUnlocked = (id) => unlockedKeys.has(id) || (legacyUnlockedKeys?.has(id) ?? false) || (keystoreKeys?.has(id) ?? false);
  const hasLockedMatch = matchedRecords.some((m) => !isUnlocked(m.keyRecord.id));
  if (hasLockedMatch) {
    const lockedRecord = matchedRecords.find((m) => !isUnlocked(m.keyRecord.id));
    throw new SmimeKeyLockedError(
      'S/MIME key is locked. Unlock it to decrypt this message.',
      lockedRecord.keyRecord.id,
    );
  }

  if (osError) throw osError;
  throw new Error('Failed to decrypt message with any available key');
}

/** Key record IDs that could potentially decrypt a message (to prompt unlock). */
export function findDecryptionCandidates(cmsBytes, keyRecords) {
  try {
    const contentInfo = parseContentInfo(cmsBytes);
    const envelopedData = extractEnvelopedData(contentInfo);
    return findMatchingKeyRecords(envelopedData, keyRecords).map((m) => m.keyRecord.id);
  } catch {
    return [];
  }
}

/**
 * Normalize raw blob bytes into DER-encoded CMS data.
 * JMAP may return raw DER, base64 DER, a full MIME part, or PEM.
 */
export function normalizeCmsBytes(raw) {
  if (raw.byteLength === 0) return raw;

  const bytes = new Uint8Array(raw);
  if (bytes[0] === 0x30) return raw; // already DER

  let text = new TextDecoder().decode(raw);

  const looksMostlyText = (() => {
    const sample = text.slice(0, Math.min(text.length, 2048));
    if (sample.length === 0) return false;
    let printable = 0;
    for (let i = 0; i < sample.length; i++) {
      const code = sample.charCodeAt(i);
      if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0x7e)) printable++;
    }
    return printable / sample.length > 0.85;
  })();

  const headerEndMatch = text.match(/\r?\n\r?\n/);
  const hasMimeHeaderHints = /content-type:|content-transfer-encoding:|mime-version:/i.test(
    text.slice(0, Math.min(text.length, 8192)),
  );
  if (looksMostlyText && headerEndMatch && headerEndMatch.index !== undefined && hasMimeHeaderHints) {
    text = text.substring(headerEndMatch.index + headerEndMatch[0].length);
  }

  text = text
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, '')
    .replace(/-----END [A-Z0-9 ]+-----/g, '')
    .replace(/\s/g, '');

  if (text.length === 0) return raw;

  try {
    const binary = atob(text);
    const decoded = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
    if (decoded.length > 0 && decoded[0] === 0x30) return decoded.buffer;
  } catch { /* not DER, continue */ }

  if (looksMostlyText) {
    const originalText = new TextDecoder().decode(raw);
    const sectionRegex = /content-transfer-encoding:\s*base64[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--[^\r\n]+|$)/ig;
    const sectionBlocks = [];
    let sectionMatch;
    while ((sectionMatch = sectionRegex.exec(originalText)) !== null) sectionBlocks.push(sectionMatch[1]);

    for (const block of sectionBlocks) {
      const cleaned = block.replace(/\s/g, '');
      if (cleaned.length < 8 || !/^[A-Za-z0-9+/=]+$/.test(cleaned)) continue;
      try {
        const binary = atob(cleaned);
        const decoded = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
        if (decoded.length > 0 && decoded[0] === 0x30) return decoded.buffer;
      } catch { /* next section */ }
    }

    const base64Blocks = originalText.match(/[A-Za-z0-9+/=\r\n]{128,}/g) || [];
    const cleaned = base64Blocks
      .map((block) => block.replace(/\s/g, ''))
      .filter((block) => block.length >= 128 && /^[A-Za-z0-9+/=]+$/.test(block));
    cleaned.sort((a, b) => b.length - a.length);

    for (const block of cleaned) {
      try {
        const binary = atob(block);
        const decoded = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
        if (decoded.length > 0 && decoded[0] === 0x30) return decoded.buffer;
      } catch { /* next block */ }
    }
  }

  return raw;
}

function parseContentInfo(der) {
  const asn1 = asn1js.fromBER(der);
  if (asn1.offset === -1) throw new Error('Invalid ASN.1 data - cannot parse CMS envelope');
  try {
    return new pkijs.ContentInfo({ schema: asn1.result });
  } catch {
    throw new Error('Invalid ASN.1 data - cannot parse CMS envelope');
  }
}

// pkijs EnvelopedData, or the parsed AuthEnvelopedData (the one with a mac).
function extractEnvelopedData(contentInfo) {
  if (contentInfo.contentType === OID_ENVELOPED_DATA) return new pkijs.EnvelopedData({ schema: contentInfo.content });
  if (contentInfo.contentType === OID_AUTH_ENVELOPED_DATA) return parseAuthEnvelopedData(contentInfo.content);
  throw new Error(`Unexpected CMS content type: ${contentInfo.contentType}`);
}

// One parse per certificate, however many entries a message has. Null for one that can't be read.
const certificateFacts = new WeakMap();

function factsOf(keyRecord) {
  if (certificateFacts.has(keyRecord)) return certificateFacts.get(keyRecord);
  let facts = null;
  try {
    const certAsn1 = asn1js.fromBER(keyRecord.certificate);
    if (certAsn1.offset !== -1) {
      const cert = new pkijs.Certificate({ schema: certAsn1.result });
      const skiExt = cert.extensions?.find((ext) => ext.extnID === '2.5.29.14');
      const skiValue = skiExt ? asn1js.fromBER(skiExt.extnValue.valueBlock.valueHexView) : null;
      facts = {
        cert,
        serial: toHex(cert.serialNumber.valueBlock.valueHexView),
        issuer: new Uint8Array(cert.issuer.toSchema().toBER(false)),
        ski: skiValue && skiValue.offset !== -1 ? new Uint8Array(skiValue.result.valueBlock.valueHexView) : null,
      };
    }
  } catch { /* not a certificate we can use */ }
  certificateFacts.set(keyRecord, facts);
  return facts;
}

/**
 * Each key at most once, whatever a message repeats: every try can be a private key
 * operation, and with an OS key a question. So the work a message can cause is
 * bounded by the keys the user has, not by the size of its recipient list.
 */
function findMatchingKeyRecords(envelopedData, keyRecords) {
  const matches = [];
  const candidates = keyRecords.map((keyRecord) => ({ keyRecord, facts: factsOf(keyRecord) })).filter((c) => c.facts);
  const claim = (recipient, make) => {
    const at = candidates.findIndex((c) => matchesRecipient(recipient, c.facts));
    if (at === -1) return;
    matches.push(make(candidates[at].keyRecord));
    candidates.splice(at, 1);
  };

  for (let i = 0; i < envelopedData.recipientInfos.length && candidates.length > 0; i++) {
    const ri = envelopedData.recipientInfos[i];

    const ktri = ri instanceof pkijs.KeyTransRecipientInfo
      ? ri
      : ri.variant === 1 && ri.value instanceof pkijs.KeyTransRecipientInfo
        ? ri.value
        : null;

    if (ktri) {
      // A second key could hold the same certificate.
      for (let before = -1; before !== candidates.length && candidates.length > 0;) {
        before = candidates.length;
        claim(ktri, (keyRecord) => ({ keyRecord, recipientIndex: i }));
      }
      continue;
    }

    if (ri.variant === 2 && ri.value instanceof pkijs.KeyAgreeRecipientInfo) {
      for (const encryptedKey of ri.value.recipientEncryptedKeys.encryptedKeys) {
        // KeyAgreeRecipientIdentifier: issuerAndSerialNumber, or [0] with a subject key id.
        const { variant, value } = encryptedKey.rid;
        const recipient = { rid: variant === 2 ? value.subjectKeyIdentifier : value };
        for (let before = -1; before !== candidates.length && candidates.length > 0;) {
          before = candidates.length;
          claim(recipient, (keyRecord) => ({ keyRecord, recipientIndex: i, encryptedKey }));
        }
      }
    }
  }

  return matches;
}

function matchesRecipient(recipientInfo, facts) {
  const rid = recipientInfo.rid;
  try {
    if (rid instanceof pkijs.IssuerAndSerialNumber) {
      return toHex(rid.serialNumber.valueBlock.valueHexView) === facts.serial
        && arraysEqual(new Uint8Array(rid.issuer.toSchema().toBER(false)), facts.issuer);
    }
    if (rid instanceof asn1js.OctetString) {
      return !!facts.ski && arraysEqual(facts.ski, new Uint8Array(rid.valueBlock.valueHexView));
    }
  } catch { /* a malformed entry fits no key */ }
  return false;
}

async function decryptWithKey(envelopedData, { recipientIndex, encryptedKey }, privateKey, keyRecord) {
  const { cert } = factsOf(keyRecord);
  const recipient = envelopedData.recipientInfos[recipientIndex].value;

  if (encryptedKey) {
    const cek = await unwrapKeyAgree(recipient, encryptedKey, privateKey, cert);
    return withContentKey(envelopedData, cert, cek);
  }

  return withLinerEngine(async () => {
    const cryptoEngine = getLinerCryptoEngine();
    const parameters = { recipientCertificate: cert, recipientPrivateKey: privateKey };
    // pkijs does the rest of the CMS work and only needs this one call from the key. It
    // passes the key's algorithm, not the message's, so the OAEP parameters come from the
    // RecipientInfo here: that's what lets OAEP SHA-1 mail open.
    if (privateKey.keystore) {
      parameters.crypto = {
        subtle: { decrypt: (_algorithm, _key, data) => privateKey.keystore.decrypt(new Uint8Array(data), keyTransScheme(recipient)) },
      };
    }
    return envelopedData.decrypt(recipientIndex, parameters, cryptoEngine);
  });
}

/** The content key from an ECDH recipient entry, or undefined when its key isn't unlocked. */
async function agreedContentKey(recipient, encryptedKey, keyRecord, { keystoreKeys, unlockedKeys }) {
  const privateKey = keystoreKeys?.get(keyRecord.id) ?? unlockedKeys.get(keyRecord.id);
  if (!privateKey) return undefined;
  return unwrapKeyAgree(recipient, encryptedKey, privateKey, factsOf(keyRecord).cert);
}

/**
 * EnvelopedData's content, when the content key is already known. pkijs has no entry
 * point for that, so this hands it a one-off key transport entry that answers with it.
 */
function withContentKey(envelopedData, cert, cek) {
  const carrier = new pkijs.EnvelopedData({
    encryptedContentInfo: envelopedData.encryptedContentInfo,
    recipientInfos: [new pkijs.RecipientInfo({
      variant: 1,
      value: new pkijs.KeyTransRecipientInfo({
        keyEncryptionAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_RSA_ENCRYPTION }),
        encryptedKey: new asn1js.OctetString(),
      }),
    })],
  });
  return withLinerEngine(() => carrier.decrypt(0, {
    recipientCertificate: cert,
    recipientPrivateKey: { algorithm: { name: 'RSA-OAEP' } },
    crypto: { subtle: { decrypt: async () => cek } },
  }, getLinerCryptoEngine()));
}
