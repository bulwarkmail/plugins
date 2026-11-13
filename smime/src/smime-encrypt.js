import * as pkijs from 'pkijs';
import { parseCertificateDer } from './certificate-utils.js';
import { getLinerCryptoEngine, withLinerEngine } from './crypto-engine.js';
import { toHex } from './util.js';

/**
 * Produce CMS EnvelopedData for the given MIME content.
 * Content type: application/pkcs7-mime; smime-type=enveloped-data.
 * Always includes the sender's cert so the sender can decrypt their Sent mail.
 * Ported from lib/smime/smime-encrypt.ts.
 */
export async function smimeEncrypt(mimeBytes, recipientCertsDer, senderCertDer, useAes128) {
  const allCertDers = deduplicateCerts([...recipientCertsDer, senderCertDer]);
  if (allCertDers.length === 0) throw new Error('No recipient certificates provided');

  const recipientCerts = allCertDers.map((der) => parseCertificateDer(der));
  const cmsEnveloped = new pkijs.EnvelopedData();

  // RFC 8551 s2.7: AES-CBC is the content-encryption baseline for EnvelopedData.
  // An AEAD cipher such as AES-GCM belongs in AuthEnvelopedData (RFC 5083/5084),
  // and a reader that meets its parameter block inside EnvelopedData stops at the
  // cipher before any key is tried.
  const contentEncryptionAlgorithm = useAes128
    ? { name: 'AES-CBC', length: 128 }
    : { name: 'AES-CBC', length: 256 };

  // Native WebCrypto has no RSAES-PKCS1-v1_5, so both steps run on the liner
  // engine, which hands everything else to native WebCrypto. useOAEP: false picks
  // RSAES-PKCS1-v1_5 for an RSA certificate; pkijs picks OAEP otherwise, which
  // far fewer clients accept (RFC 8551 s2.3). pkijs takes the recipient type from
  // the certificate: key transport for RSA, ECDH key agreement for EC.
  await withLinerEngine(async () => {
    const engine = getLinerCryptoEngine();
    for (const cert of recipientCerts) {
      cmsEnveloped.addRecipientByCertificate(cert, { useOAEP: false }, undefined, engine);
    }
    await cmsEnveloped.encrypt(
      contentEncryptionAlgorithm,
      mimeBytes.buffer.slice(mimeBytes.byteOffset, mimeBytes.byteOffset + mimeBytes.byteLength),
      engine,
    );
  });

  // pkijs swallows a failed key transport and leaves that recipient's key empty,
  // which would send mail that recipient can never open.
  for (const { variant, value } of cmsEnveloped.recipientInfos) {
    if (variant === 1 && value.encryptedKey.valueBlock.valueHexView.byteLength === 0) {
      throw new Error('Could not encrypt the message key for every recipient');
    }
  }

  const cms = new pkijs.ContentInfo({
    contentType: '1.2.840.113549.1.7.3', // id-envelopedData
    content: cmsEnveloped.toSchema(),
  });

  const cmsBytes = cms.toSchema().toBER(false);
  return new Blob([cmsBytes], { type: 'application/pkcs7-mime; smime-type=enveloped-data' });
}

function deduplicateCerts(certs) {
  const seen = new Set();
  const result = [];
  for (const cert of certs) {
    const key = toHex(cert);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cert);
    }
  }
  return result;
}
