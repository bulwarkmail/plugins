import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { parseCertificateDer } from './certificate-utils.js';
import { nativeEngine } from './crypto-engine.js';

/**
 * Produce an opaque CMS SignedData wrapping the given MIME content.
 * Content type: application/pkcs7-mime; smime-type=signed-data.
 * Ported from lib/smime/smime-sign.ts.
 */
export async function smimeSign(mimeBytes, privateKey, signerCertDer, chainCertsDer = []) {
  const encap = new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.7.1' }); // id-data
  // pkijs' constructor wraps eContent in a BER *constructed* OCTET STRING
  // (OCTET STRING inside OCTET STRING). Outlook/CryptoAPI is picky, so assign a
  // plain primitive OCTET STRING, as OpenSSL and Outlook themselves emit.
  encap.eContent = new asn1js.OctetString({ valueHex: copyBytes(mimeBytes) });
  const cmsSigned = newSignedData(
    encap,
    signerCertDer,
    chainCertsDer,
    await sha256(mimeBytes),
  );

  const hashAlgorithm = 'SHA-256';
  await cmsSigned.sign(privateKey, 0, hashAlgorithm, undefined, nativeEngine());

  const cmsBytes = contentInfoDer(cmsSigned);
  return new Blob([cmsBytes], { type: 'application/pkcs7-mime; smime-type=signed-data' });
}

/** Detached CMS SignedData over a CRLF MIME entity. Returns the DER bytes. */
export async function smimeSignDetached(entityBytes, privateKey, signerCertDer, chainCertsDer = []) {
  const cmsSigned = newSignedData(
    // No eContent = detached.
    new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.7.1' }),
    signerCertDer,
    chainCertsDer,
    await sha256(entityBytes),
  );

  await cmsSigned.sign(privateKey, 0, 'SHA-256', copyBytes(entityBytes), nativeEngine());

  return new Uint8Array(contentInfoDer(cmsSigned));
}

async function sha256(u8) {
  return crypto.subtle.digest('SHA-256', copyBytes(u8));
}

/** SMIMECapabilities: AES-256-CBC, AES-128-CBC, 3DES-CBC. */
function smimeCapabilities() {
  const cap = (oid) => new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: oid })] });
  return new asn1js.Sequence({
    value: [cap('2.16.840.1.101.3.4.1.42'), cap('2.16.840.1.101.3.4.1.2'), cap('1.2.840.113549.3.7')],
  });
}

function newSignedData(encapContentInfo, signerCertDer, chainCertsDer, contentDigest) {
  const signerCert = parseCertificateDer(signerCertDer);
  const chainCerts = chainCertsDer.map((der) => parseCertificateDer(der));

  return new pkijs.SignedData({
    version: 1,
    encapContentInfo,
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: signerCert.issuer,
          serialNumber: signerCert.serialNumber,
        }),
        // Signed attributes (RFC 5652 §11 / RFC 8551 §2.5). Without them Outlook
        // finds no signing time (shows 01.01.1601) and reports the message as
        // modified.
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: derSorted([
            new pkijs.Attribute({
              type: '1.2.840.113549.1.9.3', // contentType
              values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' })],
            }),
            new pkijs.Attribute({
              type: '1.2.840.113549.1.9.4', // messageDigest
              values: [new asn1js.OctetString({ valueHex: contentDigest })],
            }),
            new pkijs.Attribute({
              type: '1.2.840.113549.1.9.5', // signingTime
              values: [new asn1js.UTCTime({ valueDate: new Date() })],
            }),
            new pkijs.Attribute({
              type: '1.2.840.113549.1.9.15', // smimeCapabilities
              values: [smimeCapabilities()],
            }),
          ]),
        }),
      }),
    ],
    certificates: [signerCert, ...chainCerts],
  });
}

/**
 * The signature covers the DER encoding of signedAttrs (RFC 5652 §5.4), and DER
 * sorts a SET OF by the encoded bytes, not by OID. pkijs encodes the attributes
 * in array order, so a verifier that re-encodes them as DER would otherwise
 * hash a different order than the one that was signed.
 */
function derSorted(attributes) {
  const enc = (a) => new Uint8Array(a.toSchema().toBER(false));
  const cmp = (x, y) => {
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  };
  return attributes
    .map((a) => ({ a, der: enc(a) }))
    .sort((p, q) => cmp(p.der, q.der))
    .map((p) => p.a);
}

/**
 * pkijs emits sha256WithRSAEncryption WITHOUT the NULL parameters. RFC 4055 /
 * RFC 5754 require them and Windows CryptoAPI (Outlook) rejects the signature
 * as "possibly modified". Use rsaEncryption + NULL, the form Outlook itself
 * and OpenSSL produce (RFC 5754 §3.2). Other key types (ECDSA) stay untouched.
 */
function fixRsaSignatureAlgorithm(cmsSigned) {
  const si = cmsSigned.signerInfos[0];
  const oid = si.signatureAlgorithm.algorithmId;
  const RSA_WITH_SHA = ['1.2.840.113549.1.1.11', '1.2.840.113549.1.1.12', '1.2.840.113549.1.1.13', '1.2.840.113549.1.1.5'];
  if (RSA_WITH_SHA.includes(oid)) {
    si.signatureAlgorithm = new pkijs.AlgorithmIdentifier({
      algorithmId: '1.2.840.113549.1.1.1', // rsaEncryption
      algorithmParams: new asn1js.Null(),
    });
  }
}

function contentInfoDer(cmsSigned) {
  fixRsaSignatureAlgorithm(cmsSigned);
  const cms = new pkijs.ContentInfo({
    contentType: '1.2.840.113549.1.7.2', // id-signedData
    content: cmsSigned.toSchema(true),
  });
  return cms.toSchema().toBER(false);
}

function copyBytes(u8) {
  return new Uint8Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}
