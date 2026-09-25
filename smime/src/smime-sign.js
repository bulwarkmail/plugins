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
  const cmsSigned = newSignedData(
    new pkijs.EncapsulatedContentInfo({
      eContentType: '1.2.840.113549.1.7.1', // id-data
      eContent: new asn1js.OctetString({ valueHex: copyBytes(mimeBytes) }),
    }),
    signerCertDer,
    chainCertsDer,
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
  );

  await cmsSigned.sign(privateKey, 0, 'SHA-256', copyBytes(entityBytes), nativeEngine());

  return new Uint8Array(contentInfoDer(cmsSigned));
}

function newSignedData(encapContentInfo, signerCertDer, chainCertsDer) {
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
      }),
    ],
    certificates: [signerCert, ...chainCerts],
  });
}

function contentInfoDer(cmsSigned) {
  const cms = new pkijs.ContentInfo({
    contentType: '1.2.840.113549.1.7.2', // id-signedData
    content: cmsSigned.toSchema(true),
  });
  return cms.toSchema().toBER(false);
}

function copyBytes(u8) {
  return new Uint8Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}
