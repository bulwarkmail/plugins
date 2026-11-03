// Build CMS AuthEnvelopedData the way Stalwart's encryption at rest does
// (crates/email/src/message/crypto.rs, EncryptMessage::encrypt): one
// KeyTransRecipientInfo by issuer and serial, RSA-OAEP with SHA-256 and
// MGF1-SHA-256 (hash parameters NULL), content type id-data, no authAttrs
// unless asked for, and the outer message as base64 application/pkcs7-mime.
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_AUTH_ENVELOPED_DATA = '1.2.840.113549.1.9.16.1.23';
const OID_CONTENT_TYPE_ATTR = '1.2.840.113549.1.9.3';
const OID_RSAES_OAEP = '1.2.840.113549.1.1.7';
const OID_MGF1 = '1.2.840.113549.1.1.8';
const OID_P_SPECIFIED = '1.2.840.113549.1.1.9';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
export const OID_AES256_GCM = '2.16.840.1.101.3.4.1.46';
export const OID_CHACHA20_POLY1305 = '1.2.840.113549.1.9.16.3.18';

const oid = (value) => new asn1js.ObjectIdentifier({ value });
const algorithm = (id, params) => new asn1js.Sequence({ value: [oid(id), ...(params ? [params] : [])] });
const sha256 = () => algorithm(OID_SHA256, new asn1js.Null());
const explicit = (tagNumber, value) => new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber }, value: [value] });
const contentTypeAttr = (type) => new asn1js.Sequence({ value: [oid(OID_CONTENT_TYPE_ATTR), new asn1js.Set({ value: [oid(type)] })] });

export function parseCertificatePem(pem) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  return new pkijs.Certificate({ schema: asn1js.fromBER(der).result });
}

const SEALERS = {
  async [OID_AES256_GCM](key, nonce, plaintext, aad) {
    const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, ...(aad ? { additionalData: aad } : {}) }, k, plaintext));
    return { ciphertext: out.slice(0, -16), mac: out.slice(-16) };
  },
};

/** Register another content cipher: (key, nonce, plaintext, aad) => { ciphertext, mac }. */
export function addSealer(contentOid, seal) {
  SEALERS[contentOid] = seal;
}

/**
 * DER ContentInfo with AuthEnvelopedData for cert.
 * authAttrs: undefined (Stalwart), 'match', or 'altered' (sent attributes
 * differ from the ones the MAC covers).
 */
export async function buildAuthEnveloped(cert, { contentOid = OID_AES256_GCM, plaintext, authAttrs, oaepLabel } = {}) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  let aad;
  let sentAttrs;
  if (authAttrs) {
    aad = new Uint8Array(new asn1js.Set({ value: [contentTypeAttr(OID_DATA)] }).toBER(false));
    const sent = contentTypeAttr(authAttrs === 'altered' ? OID_SIGNED_DATA : OID_DATA);
    sentAttrs = new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 1 }, value: [sent] });
  }
  const { ciphertext, mac } = await SEALERS[contentOid](key, nonce, plaintext, aad);

  const params = contentOid === OID_AES256_GCM
    ? new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: nonce }), new asn1js.Integer({ value: 16 })] })
    : new asn1js.OctetString({ valueHex: nonce });

  const publicKey = await crypto.subtle.importKey(
    'spki', cert.subjectPublicKeyInfo.toSchema().toBER(false), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'],
  );
  const encryptedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP', ...(oaepLabel ? { label: oaepLabel } : {}) }, publicKey, key);
  const labelSource = oaepLabel ? [explicit(2, algorithm(OID_P_SPECIFIED, new asn1js.OctetString({ valueHex: oaepLabel })))] : [];

  const recipient = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 0 }),
      new asn1js.Sequence({ value: [cert.issuer.toSchema(), cert.serialNumber] }),
      algorithm(OID_RSAES_OAEP, new asn1js.Sequence({
        value: [explicit(0, sha256()), explicit(1, algorithm(OID_MGF1, sha256())), ...labelSource],
      })),
      new asn1js.OctetString({ valueHex: encryptedKey }),
    ],
  });
  const encryptedContentInfo = new asn1js.Sequence({
    value: [
      oid(OID_DATA),
      algorithm(contentOid, params),
      new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: ciphertext }),
    ],
  });
  const authEnvelopedData = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 0 }),
      new asn1js.Set({ value: [recipient] }),
      encryptedContentInfo,
      ...(sentAttrs ? [sentAttrs] : []),
      new asn1js.OctetString({ valueHex: mac }),
    ],
  });
  return new asn1js.Sequence({
    value: [oid(OID_AUTH_ENVELOPED_DATA), explicit(0, authEnvelopedData)],
  }).toBER(false);
}

/** The DER as Stalwart stores it: the message headers, then base64 CMS. */
export function stalwartMessage(der) {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der))).replace(/.{76}/g, '$&\r\n');
  return new TextEncoder().encode([
    'From: sender@example.com',
    'To: smime-test@example.com',
    'Subject: Encrypted at rest',
    'Content-Type: application/pkcs7-mime;',
    '\tname="smime.p7m";',
    '\tsmime-type=authenticated-enveloped-data',
    'Content-Disposition: attachment;',
    '\tfilename="smime.p7m"',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
  ].join('\r\n')).buffer;
}

/** A copy of DER AuthEnvelopedData (mac last, 16 bytes) with one mac byte flipped. */
export function flipMacByte(der) {
  const bytes = new Uint8Array(der.slice(0));
  if (bytes[bytes.length - 18] !== 0x04 || bytes[bytes.length - 17] !== 16) throw new Error('mac is not the last element');
  bytes[bytes.length - 1] ^= 0x01;
  return bytes.buffer;
}
