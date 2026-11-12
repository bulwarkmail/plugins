/**
 * Minimal RFC 5322 / MIME parser used only for the inner content recovered
 * after decryption / signature-stripping. We need just enough to pull out the
 * best-alternative text/html body and any leaf attachments; the host
 * re-sanitizes returned HTML, so this never has to be a hardened renderer.
 */

const decoder = new TextDecoder('utf-8', { fatal: false });

/** Parse raw inner MIME bytes into { html, text, attachments }. */
export function parseMime(bytes) {
  const text = binaryString(bytes);
  const node = parseEntity(text);
  const out = { html: '', text: '', attachments: [] };
  collect(node, out);
  // Fallback for non-MIME inner content (e.g. messages signed/encrypted by
  // OpenSSL or older clients where the protected payload is raw text with no
  // Content-Type). If structured parsing produced no renderable body, surface
  // the decoded bytes as plain text so the message is never shown blank.
  if (!out.html && !out.text) {
    const raw = decoder.decode(bytes).trim();
    if (raw) out.text = raw;
  }
  return out;
}

const PKCS7_SIGNATURE = /^application\/(x-)?pkcs7-signature$/;
const PKCS7_MIME = /^application\/(x-)?pkcs7-mime$/;

/**
 * The message's own signed entity and signature as { entityBytes, signatureDer },
 * or null when the message is not signed as a whole: its top-level type has to be
 * multipart/signed with a pkcs7 signature, holding exactly the signed entity and
 * the signature (RFC 1847), so nothing in the message lies outside the signature.
 * The headers this relies on (the message's, the entity's and the signature's
 * Content-Type) have to read one way (see readsOneWay).
 */
export function extractDetachedSigned(bytes) {
  const node = parseEntity(binaryString(bytes));
  if (!readsOneWay(node, true)) return null;
  if (node.type !== 'multipart/signed' || !PKCS7_SIGNATURE.test((node.params.protocol || '').toLowerCase())) return null;
  if (node.children.length !== 2) return null;
  const [entity, sig] = node.children;
  if (!readsOneWay(entity, false) || !readsOneWay(sig, true)) return null;
  if (!PKCS7_SIGNATURE.test(sig.type)) return null;
  return { entityBytes: latin1Bytes(entity.raw), signatureDer: decodeBody(sig) };
}

/**
 * The body of a message that is application/pkcs7-mime as a whole, as bytes, or null
 * when it is not, or when its header doesn't read one way (see readsOneWay).
 */
export function opaqueBody(bytes) {
  const node = parseEntity(binaryString(bytes));
  if (!readsOneWay(node, true) || !PKCS7_MIME.test(node.type)) return null;
  return latin1Bytes(node.body);
}

/**
 * Whether an entity's header block reads the same way in every parser, as far as its
 * Content-Type goes. Mail servers and clients differ on duplicate fields (first or
 * last wins), duplicate parameters, blanks in field names and odd line breaks, so the
 * plugin only relies on a header block where none of that occurs:
 * - one kind of line break, no lone CR, no NUL, no line of only blanks, every line a
 *   field or the continuation of one;
 * - exactly one Content-Type field (or none, where `required` is false), counting
 *   every spelling of the name a parser might take for it (any case, blanks or tabs
 *   inside it or before the colon), and spelled the way this reader knows it;
 * - in that field no 8-bit byte, each parameter at most once (RFC 2231 sections and
 *   encoded forms count as that parameter), and the media type and the parameters
 *   this reader uses as a strict reading of the field gives them.
 */
function readsOneWay(node, required) {
  const text = node.headerText;
  const sep = node.headerEnd;
  if (text.includes('\0') || /\r(?!\n)/.test(text)) return false;
  const crlf = sep ? sep === '\r\n\r\n' : text.includes('\r\n');
  if (sep && !crlf && sep !== '\n\n') return false;
  if (crlf ? /(^|[^\r])\n/.test(text) : text.includes('\r')) return false;

  const fields = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (!fields.length || !line.trim()) return false;
      fields[fields.length - 1] += line;
    } else if (line.indexOf(':') > 0) {
      fields.push(line);
    } else {
      return false;
    }
  }
  const named = fields.filter((f) => f.slice(0, f.indexOf(':')).toLowerCase().replace(/[^a-z0-9-]/g, '') === 'content-type');
  if (named.length !== 1) return named.length === 0 && !required;
  const colon = named[0].indexOf(':');
  if (named[0].slice(0, colon).trim().toLowerCase() !== 'content-type') return false;
  const value = named[0].slice(colon + 1);
  if (/[^\x00-\x7f]/.test(value)) return false;
  const strict = strictContentType(value);
  return !!strict && strict.type === node.type
    && ['boundary', 'protocol', 'smime-type'].every((k) => strict.params[k] === node.params[k]);
}

// A Content-Type value read by the rules: ';' only outside quoted strings, a media type
// of two tokens, and each parameter name once.
function strictContentType(value) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted && c === '\\') {
      current += value.slice(i, i + 2);
      i++;
    } else if (c === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      if (c === '"') quoted = !quoted;
      current += c;
    }
  }
  if (quoted) return null;
  parts.push(current);

  const type = parts[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return null;
  const params = {};
  const counts = new Map();
  const sections = new Map();
  for (const part of parts.slice(1)) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const name = part.slice(0, eq).toLowerCase().replace(/[ \t\r\n]/g, '');
    const m = name.match(/^([a-z0-9!#$&^_.+-]+?)(?:\*(\d+))?\*?$/);
    if (!m) return null;
    const [, base, section] = m;
    let count = counts.get(base) ?? 0;
    if (section === undefined) {
      count++;
    } else {
      // RFC 2231 sections of one value count once; the same section twice is a second value.
      const seen = sections.get(base) ?? new Set();
      if (seen.has(section)) return null;
      if (seen.size === 0) count++;
      seen.add(section);
      sections.set(base, seen);
    }
    if (count > 1) return null;
    counts.set(base, count);
    if (name === base) {
      const v = part.slice(eq + 1).trim();
      params[base] = v.length > 1 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
    }
  }
  return { type, params };
}

function latin1Bytes(s) {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

// Treat bytes as latin1 so byte boundaries survive; decode per-part by charset. Built in
// chunks: one character at a time makes a string of millions of pieces for a large mail.
const CHUNK = 0x2000;

function binaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return s;
}

// Multiparts are read this many levels deep. A deeper one stays whole, as one
// opaque leaf, so no level costs another walk over the rest of the message.
const MAX_DEPTH = 32;

function parseEntity(raw, depth = 1) {
  const sepMatch = raw.match(/\r?\n\r?\n/);
  const headerText = sepMatch ? raw.slice(0, sepMatch.index) : raw;
  const body = sepMatch ? raw.slice(sepMatch.index + sepMatch[0].length) : '';

  const headers = parseHeaders(headerText);
  const ctRaw = headers['content-type'] || 'text/plain';
  const { type, params } = parseContentType(ctRaw);
  const cte = (headers['content-transfer-encoding'] || '7bit').trim().toLowerCase();
  const disposition = (headers['content-disposition'] || '').toLowerCase();

  const headerEnd = sepMatch ? sepMatch[0] : '';
  const node = { type, params, cte, disposition, headers, headerText, headerEnd, body, raw, children: [] };

  if (type.startsWith('multipart/') && params.boundary) {
    if (depth <= MAX_DEPTH) node.children = splitMultipart(body, params.boundary).map((part) => parseEntity(part, depth + 1));
    else node.opaque = true;
  }
  return node;
}

function parseHeaders(headerText) {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

function parseContentType(value) {
  const parts = value.split(';');
  const type = parts[0].trim().toLowerCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 0) continue;
    const k = parts[i].slice(0, eq).trim().toLowerCase();
    let v = parts[i].slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { type, params };
}

// The parts of a multipart body, found by walking its delimiter lines once. A delimiter
// is a whole line: "--boundary" with optional blanks after it, or "--boundary--" to
// close. A line that only starts with it (a longer boundary) is content. The line break
// before a delimiter belongs to it. Without a closing delimiter the last part runs to
// the end of the body.
function splitMultipart(body, boundary) {
  const delim = `--${boundary}`;
  const parts = [];
  let start = -1; // where the open part's content begins
  let from = 0;
  for (;;) {
    let line;
    if (from === 0 && body.startsWith(delim)) line = 0;
    else {
      const hit = body.indexOf(`\n${delim}`, from);
      if (hit < 0) break;
      line = hit + 1;
    }
    const after = line + delim.length;
    const eol = body.indexOf('\n', after);
    const lineEnd = eol < 0 ? body.length : eol;
    const closing = body.startsWith('--', after);
    if (closing || onlyBlanks(body, after, lineEnd)) {
      if (start >= 0) parts.push(body.slice(start, Math.max(start, lineBreakBefore(body, line))));
      if (closing) return parts;
      start = lineEnd + 1;
    }
    if (eol < 0) break;
    from = eol;
  }
  if (start >= 0) parts.push(body.slice(start, Math.max(start, lineBreakBefore(body, body.length))));
  return parts;
}

function onlyBlanks(s, from, to) {
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0d) return false;
  }
  return true;
}

// Where the line break that ends just before `at` begins (`at` itself when there is none).
function lineBreakBefore(s, at) {
  if (s[at - 1] !== '\n') return at;
  return s[at - 2] === '\r' ? at - 2 : at - 1;
}

function decodeBody(node) {
  const { cte, body } = node;
  if (cte === 'base64') {
    const cleaned = body.replace(/[^A-Za-z0-9+/=]/g, '');
    try {
      const bin = atob(cleaned);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch {
      return new Uint8Array(0);
    }
  }
  if (cte === 'quoted-printable') {
    return qpDecode(body);
  }
  // 7bit / 8bit / binary — body is a latin1 binary string
  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
  return bytes;
}

function qpDecode(input) {
  const out = [];
  const cleaned = input.replace(/=\r?\n/g, ''); // soft line breaks
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '=' && i + 2 < cleaned.length) {
      const hex = cleaned.substr(i + 1, 2);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(cleaned.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

function decodeText(node) {
  const bytes = decodeBody(node);
  const charset = (node.params.charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return decoder.decode(bytes);
  }
}

function filenameFor(node) {
  const cd = node.headers['content-disposition'] || '';
  const m = cd.match(/filename\*?=(?:"([^"]+)"|([^;]+))/i);
  if (m) return (m[1] || m[2] || '').trim();
  if (node.params.name) return node.params.name;
  return 'attachment';
}

function collect(node, out) {
  const { type, disposition } = node;
  const isAttachment = disposition.includes('attachment') ||
    (!type.startsWith('text/') && !type.startsWith('multipart/'));

  if (type.startsWith('multipart/') && !node.opaque) {
    if (type === 'multipart/alternative') {
      // Prefer the richest alternative; collect text+html, last wins per type.
      for (const child of node.children) collect(child, out);
    } else {
      for (const child of node.children) collect(child, out);
    }
    return;
  }

  if (type === 'text/html' && !isAttachment) {
    out.html = decodeText(node);
    return;
  }
  if (type === 'text/plain' && !isAttachment) {
    out.text = decodeText(node);
    return;
  }

  // Leaf attachment
  const bytes = decodeBody(node);
  out.attachments.push({
    name: filenameFor(node),
    type: type || 'application/octet-stream',
    size: bytes.length,
    dataUrl: bytesToDataUrl(bytes, type || 'application/octet-stream'),
  });
}

function bytesToDataUrl(bytes, type) {
  return `data:${type};base64,${btoa(binaryString(bytes))}`;
}
