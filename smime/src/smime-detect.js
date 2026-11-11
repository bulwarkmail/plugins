/**
 * Whether an email message is S/MIME. Ported from lib/smime/smime-detect.ts.
 *
 * The message's own top-level Content-Type decides (the root of the JMAP
 * bodyStructure when the header isn't at hand): the plugin takes a message
 * over only when the S/MIME entity is the whole message, that is
 * application/pkcs7-mime (or x-pkcs7-mime) or multipart/signed with a pkcs7
 * signature. A signed part further down the tree reports 'partly-signed':
 * the plugin neither verifies it nor shows the message as signed.
 *
 * AuthEnvelopedData reports as 'enveloped-data' too: both are encrypted
 * mail, and smime-decrypt.js tells them apart by their CMS content type.
 */

const PKCS7_MIME = new Set(['application/pkcs7-mime', 'application/x-pkcs7-mime']);
const PKCS7_SIGNATURE = new Set(['application/pkcs7-signature', 'application/x-pkcs7-signature']);
// RFC 8551 calls it authEnveloped-data; Stalwart's encryption at rest
// writes authenticated-enveloped-data.
const ENVELOPED = new Set(['enveloped-data', 'authenveloped-data', 'authenticated-enveloped-data']);

export function detectSmime(contentType, bodyStructure, attachments) {
  const noResult = { type: null, supported: false };
  const { media, params } = parseContentType(contentType || bodyStructure?.type);

  if (PKCS7_MIME.has(media)) {
    // The root part holds the CMS blob when the server reads the message the same way.
    const part = PKCS7_MIME.has(parseContentType(bodyStructure?.type).media) ? bodyStructure : null;
    const type = smimeType(params['smime-type']);
    return { type, blobId: part?.blobId, partId: part?.partId, supported: type === 'enveloped-data' || type === 'signed-data' };
  }

  if (media === 'multipart/signed') {
    const pkcs7 = contentType
      ? PKCS7_SIGNATURE.has(params.protocol)
      : !!bodyStructure.subParts?.some(isSignaturePart);
    if (pkcs7) return { type: 'detached-sig', supported: true };
  }

  if (bodyStructure && hasSignedPart(bodyStructure)) return { type: 'partly-signed', supported: false };

  if (attachments) {
    for (const att of attachments) {
      // A CMS part below the top level is not the message, whatever its name.
      if (PKCS7_MIME.has(parseContentType(att.type).media)) continue;
      const name = att.name?.toLowerCase() || '';
      if (name.endsWith('.p7m')) {
        return { type: 'enveloped-data', blobId: att.blobId, partId: att.partId, supported: true };
      }
      if (name.endsWith('.p7s')) {
        return { type: 'detached-sig', blobId: att.blobId, partId: att.partId, supported: true };
      }
    }
  }

  return noResult;
}

/** Media type and parameters of a Content-Type value, lowercased. */
function parseContentType(value) {
  const [media, ...rest] = String(value || '').split(';');
  const params = {};
  for (const param of rest) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    const v = param.slice(eq + 1).trim().toLowerCase();
    params[param.slice(0, eq).trim().toLowerCase()] = v.length > 1 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
  }
  return { media: media.trim().toLowerCase(), params };
}

function smimeType(value) {
  // Older clients leave smime-type out of encrypted mail.
  if (!value || ENVELOPED.has(value)) return 'enveloped-data';
  return value;
}

const isSignaturePart = (part) => PKCS7_SIGNATURE.has(parseContentType(part.type).media);

// A pkcs7 signed entity anywhere in the tree.
function hasSignedPart(part) {
  const { media, params } = parseContentType(part.type);
  if (media === 'multipart/signed' && part.subParts?.some(isSignaturePart)) return true;
  if (PKCS7_MIME.has(media) && params['smime-type'] === 'signed-data') return true;
  return !!part.subParts?.some(hasSignedPart);
}
