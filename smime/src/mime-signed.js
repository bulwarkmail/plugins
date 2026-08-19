/**
 * Byte-exact extraction of the protected content and detached CMS signature
 * from a multipart/signed (RFC 1847 / RFC 5751 §3.1) MIME entity.
 *
 * Detached S/MIME verification requires the EXACT transport-encoded octets
 * of the first (protected) body part — including its own MIME headers and
 * CRLF line endings — because that is what the signature was computed over
 * (RFC 5751 §3.1.1). JMAP's decoded, per-part representation is NOT
 * guaranteed to preserve this, so this module operates on the raw bytes of
 * the whole multipart/signed section (as returned by host.jmap.fetchBlob for
 * the top-level body), sliced at the MIME boundary ourselves — mirroring how
 * the opaque path already treats blobs as "a full MIME part" in
 * smime-decrypt.js:normalizeCmsBytes.
 */

/**
 * @param {Uint8Array} raw       Raw bytes of the multipart/signed body
 *                                (boundary-delimited, as transmitted).
 * @param {string} boundary      The boundary parameter from this part's own
 *                                Content-Type header (multipart/signed;
 *                                boundary="...").
 * @returns {{ contentBytes: Uint8Array, signatureBytes: Uint8Array }}
 *   contentBytes    — part 1, canonicalised to CRLF, exactly as signed.
 *   signatureBytes  — part 2's body, CTE-decoded to raw CMS DER bytes.
 */
export function splitMultipartSigned(raw, boundary) {
  if (!boundary) {
    throw new Error('multipart/signed: missing boundary parameter — cannot split parts');
  }

  const delim = new TextEncoder().encode(`--${boundary}`);
  const offsets = findAll(raw, delim);
  if (offsets.length < 2) {
    throw new Error('multipart/signed: could not locate two MIME boundary delimiters');
  }

  // Part 1: right after the first delimiter line's CRLF, up to (but not
  // including) the CRLF that immediately precedes the second delimiter — that
  // CRLF belongs to the delimiter itself, not to the content (RFC 2046 §5.1.1).
  const part1Start = skipDelimiterLineEnd(raw, offsets[0] + delim.length);
  const part1End = stripTrailingLineBreak(raw, offsets[1]);

  // Part 2: the pkcs7-signature part, up to the closing boundary (or EOF if
  // the closing "--boundary--" wasn't included in what we fetched).
  const part2Start = skipDelimiterLineEnd(raw, offsets[1] + delim.length);
  const part2End = stripTrailingLineBreak(raw, offsets[2] !== undefined ? offsets[2] : raw.length);

  const part1 = raw.slice(part1Start, part1End);
  const part2 = raw.slice(part2Start, part2End);

  return {
    contentBytes: canonicalizeToCrlf(part1),
    signatureBytes: decodeMimePartBody(part2),
  };
}

// ── Byte search helpers ─────────────────────────────────────────────

function findAll(haystack, needle) {
  const out = [];
  let from = 0;
  for (;;) {
    const idx = indexOfBytes(haystack, needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

function indexOfBytes(haystack, needle, from) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function skipDelimiterLineEnd(bytes, offset) {
  let i = offset;
  if (bytes[i] === 0x0d) i++; // \r
  if (bytes[i] === 0x0a) i++; // \n
  return i;
}

function stripTrailingLineBreak(bytes, offset) {
  if (offset >= 2 && bytes[offset - 2] === 0x0d && bytes[offset - 1] === 0x0a) return offset - 2;
  if (offset >= 1 && bytes[offset - 1] === 0x0a) return offset - 1;
  return offset;
}

/**
 * RFC 5751 requires CRLF canonical form for the signed content. Most
 * transports already deliver CRLF; some storage layers normalise to
 * LF-only, which would otherwise break verification silently.
 */
function canonicalizeToCrlf(bytes) {
  let hasLoneLf = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i - 1] !== 0x0d) { hasLoneLf = true; break; }
  }
  if (!hasLoneLf) return bytes;

  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i - 1] !== 0x0d) out.push(0x0d);
    out.push(bytes[i]);
  }
  return new Uint8Array(out);
}

/** Parse the pkcs7-signature part's own header block and decode its CTE. */
function decodeMimePartBody(raw) {
  const text = latin1String(raw);
  const sep = text.match(/\r?\n\r?\n/);
  const headerText = sep ? text.slice(0, sep.index) : '';
  const bodyText = sep ? text.slice(sep.index + sep[0].length) : text;

  const cteMatch = headerText.match(/content-transfer-encoding:\s*([^\r\n]+)/i);
  const cte = (cteMatch ? cteMatch[1] : '7bit').trim().toLowerCase();

  if (cte === 'base64') {
    const cleaned = bodyText.replace(/[^A-Za-z0-9+/=]/g, '');
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // 7bit / 8bit / binary — body text is already a latin1 view of raw bytes.
  const out = new Uint8Array(bodyText.length);
  for (let i = 0; i < bodyText.length; i++) out[i] = bodyText.charCodeAt(i) & 0xff;
  return out;
}

function latin1String(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
