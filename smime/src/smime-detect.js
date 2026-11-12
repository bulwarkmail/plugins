/**
 * Whether an email message is S/MIME. Ported from lib/smime/smime-detect.ts.
 *
 * The message's own top-level Content-Type decides (the root of the JMAP
 * bodyStructure when the header isn't at hand): the plugin takes a message
 * over only when the S/MIME entity is the whole message, that is
 * application/pkcs7-mime (or x-pkcs7-mime) or multipart/signed with a pkcs7
 * signature. A signed part further down the tree reports 'partly-signed':
 * the plugin neither verifies it nor shows the message as signed. Attachments
 * decide nothing, whatever they are called (.p7m, .p7s). What is verified or
 * decrypted is read from the raw message, whose own header has to agree
 * (mime-parse.js), and the server's reading of it has to match what the
 * plugin read (serverPartIsEntity, serverPartIsMessage).
 *
 * AuthEnvelopedData reports as 'enveloped-data' too: both are encrypted
 * mail, and smime-decrypt.js tells them apart by their CMS content type.
 */

const PKCS7_MIME = new Set(['application/pkcs7-mime', 'application/x-pkcs7-mime']);
const PKCS7_SIGNATURE = new Set(['application/pkcs7-signature', 'application/x-pkcs7-signature']);
// RFC 8551 calls it authEnveloped-data; Stalwart's encryption at rest
// writes authenticated-enveloped-data.
const ENVELOPED = new Set(['enveloped-data', 'authenveloped-data', 'authenticated-enveloped-data']);

export function detectSmime(contentType, bodyStructure) {
  const noResult = { type: null, supported: false };
  const { media, params } = parseContentType(contentType || bodyStructure?.type);

  if (PKCS7_MIME.has(media)) {
    const type = smimeType(params['smime-type']);
    return { type, supported: ['enveloped-data', 'signed-data', 'pkcs7-mime'].includes(type) };
  }

  if (media === 'multipart/signed') {
    const pkcs7 = contentType
      ? PKCS7_SIGNATURE.has(params.protocol)
      : !!bodyStructure.subParts?.some(isSignaturePart);
    if (pkcs7) return { type: 'detached-sig', supported: true };
    // Signed as a whole with a pkcs7 signature by the server's reading, under a header that
    // names another protocol or none (RFC 1847 requires it): damaged, not partly signed.
    if (parseContentType(bodyStructure?.type).media === 'multipart/signed' && bodyStructure.subParts?.some(isSignaturePart)) {
      return { type: 'malformed-signed', supported: false };
    }
  }

  if (bodyStructure && hasSignedPart(bodyStructure)) return { type: 'partly-signed', supported: false };

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

// Without the parameter (older clients leave it out) it is 'pkcs7-mime': the CMS
// content type inside the blob tells signed from encrypted.
function smimeType(value) {
  if (!value) return 'pkcs7-mime';
  if (ENVELOPED.has(value)) return 'enveloped-data';
  return value;
}

const isSignaturePart = (part) => PKCS7_SIGNATURE.has(parseContentType(part.type).media);

// The webmail lists the server's attachments wherever the plugin returns none, so the
// plugin vouches for a message only where the server reads its structure the same way.
// Without a body structure from the host, only S/MIME parts may be listed.

/**
 * Whether the server reads the message as signed as a whole: its body structure is
 * multipart/signed with exactly the signed part and a pkcs7 signature, and every
 * attachment it lists other than the signature lies inside the signed part.
 */
export function serverReadsSignedWhole(bodyStructure, attachments) {
  const listed = attachments || [];
  if (!bodyStructure) return listed.every(isSignaturePart);
  if (parseContentType(bodyStructure.type).media !== 'multipart/signed') return false;
  const parts = bodyStructure.subParts || [];
  if (parts.length !== 2 || !isSignaturePart(parts[1])) return false;
  const known = partKeys(parts[0], partKeys(parts[1]));
  return listed.every((att) => known.has(keyOf(att)));
}

/** Whether the server reads the message as one application/pkcs7-mime part, and lists nothing else. */
export function serverReadsPkcs7Mime(bodyStructure, attachments) {
  const listed = attachments || [];
  if (!bodyStructure) return listed.every((att) => PKCS7_MIME.has(parseContentType(att.type).media));
  if (!PKCS7_MIME.has(parseContentType(bodyStructure.type).media) || bodyStructure.subParts?.length) return false;
  const known = partKeys(bodyStructure);
  return listed.every((att) => known.has(keyOf(att)));
}

// The checks above run on the server's view alone, before the message is fetched. Once
// the plugin has read the message, the two below compare the server's view with what the
// plugin verifies or decrypts. The server's part has to have the same tree of media
// types, part for part, and the same name and size on each leaf where both give one; and
// every attachment the server lists has to be one of those leaves (or the signature part).

/**
 * Whether the server's signed part, the first part of its multipart/signed, is the entity
 * the plugin verified (`entity` from extractDetachedSigned). Without a body structure there
 * is nothing to compare; serverReadsSignedWhole then let only signature parts through.
 */
export function serverPartIsEntity(bodyStructure, attachments, entity) {
  if (!bodyStructure) return true;
  const [first, signature] = bodyStructure.subParts || [];
  const leaves = new Map();
  if (!first || !signature || !samePart(first, entity, leaves)) return false;
  for (const key of partKeys(signature)) leaves.set(key, null);
  return listedAmong(attachments, leaves);
}

/**
 * Whether the server reads the message as the one application/pkcs7-mime part the plugin
 * unwraps (`shape` from opaqueBody). The server can't look into the CMS, so this compares
 * the part itself: media type, a leaf, its name, and its size, the length of the body the
 * CMS is read from.
 */
export function serverPartIsMessage(bodyStructure, attachments, shape) {
  if (!bodyStructure) return true;
  const leaves = new Map();
  return samePart(bodyStructure, shape, leaves) && listedAmong(attachments, leaves);
}

// One part of the server's view against the plugin's reading, with its subparts. Each leaf
// is filed under the server's keys for it, for the attachment list.
function samePart(server, shape, leaves) {
  if (!shape.parts || !sameLeaf(server, shape)) return false;
  const subs = server.subParts || [];
  if (subs.length !== shape.parts.length) return false;
  if (!subs.length) for (const key of ownKeys(server)) leaves.set(key, shape);
  return subs.every((sub, i) => samePart(sub, shape.parts[i], leaves));
}

// The media type always; the name and the size where the server gives them and the
// plugin has them too.
function sameLeaf(server, shape) {
  if (parseContentType(server.type).media !== shape.type) return false;
  const name = nameKey(server.name);
  const ownName = nameKey(shape.name);
  if (name && ownName && name !== ownName) return false;
  return typeof server.size !== 'number' || !shape.size || server.size === shape.size();
}

// Every listed attachment is a leaf filed above (null: the signature part).
function listedAmong(attachments, leaves) {
  return (attachments || []).every((att) => {
    const key = keyOf(att);
    if (!leaves.has(key)) return false;
    const leaf = leaves.get(key);
    return leaf === null || sameLeaf(att, leaf);
  });
}

// A name compared by its printable ASCII characters. Servers and this plugin decode
// non-ASCII names a little differently (charset tables, a character split over two
// RFC 2231 sections, the blank between two encoded words), and a name only tells parts
// apart.
const nameKey = (name) => String(name || '').replace(/[^\x21-\x7e]|["\\]/g, '');

// A part is known by its partId, or by its blobId where the host gives no partId.
const keyOf = (part) => (part.partId != null ? `part:${part.partId}` : part.blobId != null ? `blob:${part.blobId}` : null);

function ownKeys(part) {
  const keys = [];
  if (part.partId != null) keys.push(`part:${part.partId}`);
  if (part.blobId != null) keys.push(`blob:${part.blobId}`);
  return keys;
}

function partKeys(part, keys = new Set()) {
  for (const key of ownKeys(part)) keys.add(key);
  for (const sub of part.subParts || []) partKeys(sub, keys);
  return keys;
}

// A pkcs7 signed entity anywhere in the tree.
function hasSignedPart(part) {
  const { media, params } = parseContentType(part.type);
  if (media === 'multipart/signed' && part.subParts?.some(isSignaturePart)) return true;
  if (PKCS7_MIME.has(media) && params['smime-type'] === 'signed-data') return true;
  return !!part.subParts?.some(hasSignedPart);
}
