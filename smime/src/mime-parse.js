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
 * The message's own signed entity and signature as { entityBytes, signatureDer, entity },
 * or null when the message is not signed as a whole: its top-level type has to be
 * multipart/signed with a pkcs7 signature, holding exactly the signed entity and
 * the signature (RFC 1847), so nothing in the message lies outside the signature.
 * The headers this relies on (the message's, the entity's and the signature's
 * Content-Type) have to read one way (see readsOneWay), and the boundary may appear
 * only on delimiter lines (see boundaryOnlyOnDelimiters). `entity` describes the signed
 * entity's parts for a comparison with the mail server's reading (see shapeOf).
 */
export function extractDetachedSigned(bytes) {
  const node = parseEntity(binaryString(bytes));
  if (!readsOneWay(node, true)) return null;
  if (node.type !== 'multipart/signed' || !PKCS7_SIGNATURE.test((node.params.protocol || '').toLowerCase())) return null;
  if (node.children.length !== 2) return null;
  const [entity, sig] = node.children;
  if (!readsOneWay(entity, false) || !readsOneWay(sig, true)) return null;
  if (!PKCS7_SIGNATURE.test(sig.type)) return null;
  if (!boundaryOnlyOnDelimiters(node, entity)) return null;
  return { entityBytes: latin1Bytes(entity.raw), signatureDer: decodeBody(sig), entity: shapeOf(entity) };
}

/**
 * The body of a message that is application/pkcs7-mime as a whole, as { body, shape }:
 * the body as bytes, and the message described for a comparison with the mail server's
 * reading (see shapeOf). null when it is not, or when its header doesn't read one way
 * (see readsOneWay).
 */
export function opaqueBody(bytes) {
  const node = parseEntity(binaryString(bytes));
  if (!readsOneWay(node, true) || !PKCS7_MIME.test(node.type)) return null;
  return { body: latin1Bytes(node.body), shape: shapeOf(node) };
}

/**
 * Whether the boundary of a multipart/signed message appears in its body only where this
 * reader split it: on the message's own delimiter lines, and on the delimiter lines of
 * multiparts inside the signed entity whose boundary begins with it (a boundary may be
 * the beginning of another one). A mail server may split anywhere else it appears: in the
 * middle of a line, after a lone CR, in the preamble, in the signature part or after the
 * closing delimiter. mail-parser, which Stalwart uses, takes every "--boundary" for a
 * delimiter and stops at its first closing delimiter.
 */
function boundaryOnlyOnDelimiters(node, entity) {
  const allowed = new Set(node.delimiters);
  addDelimiters(entity, allowed);
  const delim = `--${node.params.boundary}`;
  for (let at = node.body.indexOf(delim); at >= 0; at = node.body.indexOf(delim, at + 1)) {
    if (!allowed.has(node.bodyStart + at)) return false;
  }
  return true;
}

function addDelimiters(node, into) {
  for (const at of node.delimiters) into.add(at);
  for (const child of node.children) addDelimiters(child, into);
}

/**
 * A part as a mail server describes it in a JMAP body structure: its media type, its
 * subparts (null where this reader kept a deep multipart whole), the name it is listed
 * under, and for a part a server keeps as bytes its size once the transfer encoding is
 * undone (`size()`, null where it can't be compared). Text parts have no size here:
 * Stalwart counts them after converting their charset. Quoted-printable decoders differ
 * in details, so those parts have none either.
 */
function shapeOf(node) {
  const bytesPart = !/^(text|message|multipart)\//.test(node.type) && ['base64', '7bit', '8bit', 'binary'].includes(node.cte);
  let size;
  return {
    type: node.type,
    parts: node.opaque ? null : node.children.map(shapeOf),
    name: listedName(node),
    size: bytesPart ? () => {
      if (size === undefined) size = decodeBody(node).length;
      return size;
    } : null,
  };
}

// The name a mail server lists a part under: the filename parameter of
// Content-Disposition, else the name parameter of Content-Type.
function listedName(node) {
  return paramText(node.headers['content-disposition'], 'filename') || paramText(node.headers['content-type'], 'name');
}

/**
 * A parameter's value as text, decoded the way mail-parser decodes it: RFC 2231 sections
 * (`name*0*=utf-8''...; name*1*=...`, where only the section that names the charset is
 * read in it, the others as UTF-8), RFC 2047 encoded words where a word starts, and raw
 * bytes as UTF-8. The first value given counts; later sections are appended to it.
 */
function paramText(value, key) {
  const parts = value ? splitParams(value) : null;
  if (!parts) return '';
  let first = null;
  const sections = [];
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const m = part.slice(0, eq).trim().toLowerCase().match(/^([^*\s]+)(?:\*(\d+))?(\*)?$/);
    if (!m || m[1] !== key) continue;
    const raw = unquote(part.slice(eq + 1).trim());
    const text = m[3] ? percentText(raw) : wordsText(raw);
    const section = Number(m[2] || 0);
    if (section > 0) sections.push([section, text]);
    else if (first === null) first = text;
  }
  sections.sort((a, b) => a[0] - b[0]);
  return (first ?? '') + sections.map(([, text]) => text).join('');
}

function unquote(value) {
  return value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;
}

// RFC 2231 encoded value: `charset'language'%XX...`, or only `%XX...` in a later section.
function percentText(raw) {
  const q1 = raw.indexOf("'");
  const q2 = q1 < 0 ? -1 : raw.indexOf("'", q1 + 1);
  const charset = q2 < 0 ? 'utf-8' : raw.slice(0, q1) || 'utf-8';
  const data = q2 < 0 ? raw : raw.slice(q2 + 1);
  if (!/^(?:[^%]|%[0-9A-Fa-f]{2})*$/.test(data)) return textOf(latin1Bytes(data));
  return textOf(latin1Bytes(data.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))), charset);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

// RFC 2047 encoded words, decoded where a word starts (at the start, after a blank or
// right after another encoded word); the rest as UTF-8.
function wordsText(raw) {
  let out = '';
  let last = 0;
  let wordEnd = -1;
  for (const m of raw.matchAll(ENCODED_WORD)) {
    if (m.index > 0 && m.index !== wordEnd && raw[m.index - 1] !== ' ' && raw[m.index - 1] !== '\t') continue;
    const word = wordText(m[1].split('*')[0], m[2].toLowerCase(), m[3]);
    if (word === null) continue;
    out += textOf(latin1Bytes(raw.slice(last, m.index))) + word;
    last = wordEnd = m.index + m[0].length;
  }
  return out + textOf(latin1Bytes(raw.slice(last)));
}

function wordText(charset, encoding, data) {
  if (encoding === 'q') {
    const bin = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return textOf(latin1Bytes(bin), charset);
  }
  try {
    return textOf(latin1Bytes(atob(data)), charset);
  } catch {
    return null;
  }
}

// Bytes as text in a charset, as UTF-8 where the charset is unknown.
function textOf(bytes, charset = 'utf-8') {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return decoder.decode(bytes);
  }
}

/**
 * Whether an entity's header block reads the same way in every parser, as far as its
 * Content-Type goes. Mail servers and clients differ on duplicate fields (first or
 * last wins), duplicate parameters, blanks in field names and odd line breaks, so the
 * plugin only relies on a header block where none of that occurs:
 * - no lone CR, no NUL, no line of only blanks, every line a field or the continuation
 *   of one. CRLF and LF line breaks may be mixed (a gateway adds LF lines, Stalwart's
 *   encryption at rest adds CRLF lines to a message that came with LF): servers take
 *   both for a line break, as this reader does;
 * - exactly one Content-Type field (or none, where `required` is false), counting
 *   every spelling of the name a parser might take for it (any case, blanks or tabs
 *   inside it or before the colon), and spelled the way this reader knows it;
 * - in that field each parameter at most once (RFC 2231 sections and encoded forms
 *   count as that parameter), no 8-bit byte in the media type, the boundary, the
 *   protocol or the smime-type (servers read such bytes as UTF-8, this reader byte by
 *   byte; elsewhere in the field, a file name for one, they change nothing), and the
 *   media type and the parameters this reader uses as a strict reading of the field
 *   gives them.
 */
function readsOneWay(node, required) {
  const text = node.headerText;
  if (text.includes('\0') || /\r(?!\n)/.test(text)) return false;

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
  const strict = strictContentType(named[0].slice(colon + 1));
  // strictContentType takes no 8-bit byte into a media type.
  return !!strict && strict.type === node.type
    && ['boundary', 'protocol', 'smime-type'].every((k) => strict.params[k] === node.params[k] && !/[^\x00-\x7f]/.test(strict.params[k] ?? ''));
}

// A header value split at each ';' outside quoted strings, or null when a quote is left open.
function splitParams(value) {
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
  return parts;
}

// A Content-Type value read by the rules: ';' only outside quoted strings, a media type
// of two tokens, and each parameter name once.
function strictContentType(value) {
  const parts = splitParams(value);
  if (!parts) return null;

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

// `base` is where `raw` starts in the text the reader was given: `bodyStart` and
// `delimiters` (where each delimiter line this reader split at begins) count from there.
function parseEntity(raw, depth = 1, base = 0) {
  const sepMatch = raw.match(/\r?\n\r?\n/);
  const headerText = sepMatch ? raw.slice(0, sepMatch.index) : raw;
  const body = sepMatch ? raw.slice(sepMatch.index + sepMatch[0].length) : '';

  const headers = parseHeaders(headerText);
  const ctRaw = headers['content-type'] || 'text/plain';
  const { type, params } = parseContentType(ctRaw);
  const cte = (headers['content-transfer-encoding'] || '7bit').trim().toLowerCase();
  const disposition = (headers['content-disposition'] || '').toLowerCase();

  const bodyStart = base + raw.length - body.length;
  const node = { type, params, cte, disposition, headers, headerText, body, bodyStart, raw, children: [], delimiters: [] };

  if (type.startsWith('multipart/') && params.boundary) {
    if (depth <= MAX_DEPTH) {
      const { parts, delimiters } = splitMultipart(body, params.boundary);
      node.children = parts.map(([start, end]) => parseEntity(body.slice(start, end), depth + 1, bodyStart + start));
      node.delimiters = delimiters.map((at) => bodyStart + at);
    } else {
      node.opaque = true;
    }
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

// The parts of a multipart body as [start, end] offsets, found by walking its delimiter
// lines once, and where each delimiter line taken begins. A delimiter is a whole line:
// "--boundary" with optional blanks after it, or "--boundary--" to close. A line that
// only starts with it (a longer boundary) is content. The line break before a delimiter
// belongs to it. Without a closing delimiter the last part runs to the end of the body.
function splitMultipart(body, boundary) {
  const delim = `--${boundary}`;
  const parts = [];
  const delimiters = [];
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
      delimiters.push(line);
      if (start >= 0) parts.push([start, Math.max(start, lineBreakBefore(body, line))]);
      if (closing) return { parts, delimiters };
      start = lineEnd + 1;
    }
    if (eol < 0) break;
    from = eol;
  }
  if (start >= 0) parts.push([start, Math.max(start, lineBreakBefore(body, body.length))]);
  return { parts, delimiters };
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
