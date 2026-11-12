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
  // engine. Variant 1 is key transport: pkijs would otherwise pick OAEP for an
  // RSA certificate, which far fewer clients accept (RFC 8551 s2.3).
  await withLinerEngine(async () => {
    const engine = getLinerCryptoEngine();
    for (const cert of recipientCerts) {
      cmsEnveloped.addRecipientByCertificate(cert, { useOAEP: false }, 1, engine);
    }
    await cmsEnveloped.encrypt(
      contentEncryptionAlgorithm,
      mimeBytes.buffer.slice(mimeBytes.byteOffset, mimeBytes.byteOffset + mimeBytes.byteLength),
      engine,
    );
  });

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
