/**
 * Minimal, deterministic MIME builder for outgoing S/MIME messages.
 * Ported from lib/smime/mime-builder.ts. All line endings are CRLF.
 */

import { generateUUID } from './util.js';

const CRLF = '\r\n';

/** Build a complete MIME message and return it as a Uint8Array (UTF-8). */
export function buildMimeMessage(input) {
  const lines = messageHeaderLines(input);
  lines.push('MIME-Version: 1.0');
  lines.push(...entityLines(input));
  return new TextEncoder().encode(lines.join(CRLF));
}

/** Build only the body entity (Content-* headers + body) — the part a detached signature covers. */
export function buildMimeEntity(input) {
  const entity = entityLines(input, true).join(CRLF);
  // Sign the terminal CRLF too; the wrapper adds a separate boundary CRLF.
  return new TextEncoder().encode(entity.endsWith(CRLF) ? entity : entity + CRLF);
}

function messageHeaderLines(input) {
  const lines = [];
  lines.push(formatHeader('From', formatAddress(input.from)));
  lines.push(formatHeader('To', input.to.map(formatAddress).join(', ')));
  if (input.cc?.length) lines.push(formatHeader('Cc', input.cc.map(formatAddress).join(', ')));
  lines.push(formatHeader('Subject', encodeHeaderWords(input.subject)));
  lines.push(formatHeader('Date', formatDate(input.date ?? new Date())));
  lines.push(formatHeader('Message-ID', input.messageId ?? `<${generateUUID()}@${messageIdDomain(input.from)}>`));
  // In-Reply-To / References come from the host as bare ids (JMAP strips the
  // angle brackets) and may carry folding whitespace from the original header.
  // A stray CRLF here becomes an empty line, which ends the header block: the
  // recipient then sees Content-Type and everything after it as plain text.
  const inReplyTo = msgIdList(input.inReplyTo);
  if (inReplyTo) lines.push(formatHeader('In-Reply-To', inReplyTo));
  const references = msgIdList(input.references);
  if (references) lines.push(formatHeader('References', references));
  return lines;
}

function entityLines(input, terminateNestedMultiparts = false) {
  const boundary = generateBoundary();
  const lines = [];

  const hasText = !!input.textBody;
  const hasHtml = !!input.htmlBody;
  const hasAttachments = !!input.attachments?.length;

  if (!hasAttachments && hasText && !hasHtml) {
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('Content-Transfer-Encoding: quoted-printable');
    lines.push('');
    lines.push(quotedPrintableEncode(input.textBody));
  } else if (!hasAttachments && hasText && hasHtml) {
    const altBoundary = generateBoundary();
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push('');
    lines.push(`--${altBoundary}`);
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('Content-Transfer-Encoding: quoted-printable');
    lines.push('');
    lines.push(quotedPrintableEncode(input.textBody));
    lines.push(`--${altBoundary}`);
    lines.push('Content-Type: text/html; charset=utf-8');
    lines.push('Content-Transfer-Encoding: quoted-printable');
    lines.push('');
    lines.push(quotedPrintableEncode(input.htmlBody));
    lines.push(`--${altBoundary}--`);
  } else if (!hasAttachments && !hasText && hasHtml) {
    lines.push('Content-Type: text/html; charset=utf-8');
    lines.push('Content-Transfer-Encoding: quoted-printable');
    lines.push('');
    lines.push(quotedPrintableEncode(input.htmlBody));
  } else if (hasAttachments) {
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');

    if (hasText && hasHtml) {
      const altBoundary = generateBoundary();
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push('');
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/plain; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(quotedPrintableEncode(input.textBody));
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/html; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(quotedPrintableEncode(input.htmlBody));
      lines.push(`--${altBoundary}--`);
      // Keep the nested entity's terminal CRLF separate from its parent boundary.
      if (terminateNestedMultiparts) lines.push('');
    } else if (hasText) {
      lines.push(`--${boundary}`);
      lines.push('Content-Type: text/plain; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(quotedPrintableEncode(input.textBody));
    } else if (hasHtml) {
      lines.push(`--${boundary}`);
      lines.push('Content-Type: text/html; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(quotedPrintableEncode(input.htmlBody));
    }

    for (const att of input.attachments) {
      lines.push(`--${boundary}`);
      const disposition = att.cid ? 'inline' : 'attachment';
      lines.push(...contentTypeWithName(att.contentType, att.filename));
      lines.push(...dispositionWithFilename(disposition, att.filename));
      lines.push('Content-Transfer-Encoding: base64');
      if (att.cid) lines.push(`Content-ID: <${att.cid}>`);
      lines.push('');
      lines.push(base64Encode(att.content));
    }
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('');
  }

  return lines;
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateBoundary() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `----=_Part_${hex}`;
}

function formatAddress(addr) {
  if (addr.name) {
    const name = unfold(addr.name);
    // Raw 8-bit in a header is rejected by some MTAs (e.g. IONOS); encode it.
    if (!/^[\x20-\x7e]*$/.test(name)) return `${encodeHeaderWords(name)} <${addr.email}>`;
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}" <${addr.email}>`;
  }
  return addr.email;
}

/** Collapse CR/LF/tabs (folding leftovers, user input) to single spaces. */
function unfold(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Normalise one id or a list of ids to "<a@b> <c@d>"; empty string if none. */
function msgIdList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .flatMap((v) => unfold(v).split(' '))
    .map((v) => v.replace(/^<+|>+$/g, ''))
    .filter((v) => v.includes('@'))
    .map((v) => `<${v}>`)
    .join(' ');
}

function messageIdDomain(from) {
  const domain = String(from?.email ?? '').split('@')[1];
  return domain && /^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'smime.local';
}

/**
 * Fold a header at whitespace only (RFC 5322 §2.2.3). A word is never split:
 * message ids and RFC 2047 encoded-words must stay intact, so a single word
 * longer than the soft limit gets its own (long) line instead.
 */
function formatHeader(name, value) {
  const words = unfold(value).split(' ').filter(Boolean);
  const lines = [];
  let line = `${name}:`;
  for (const word of words) {
    if (line.length + 1 + word.length > 76 && line.length > name.length + 1) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

/**
 * RFC 2047 for header text: one or more Q encoded-words split only between
 * whole characters, separated by spaces so formatHeader can fold between them.
 * Each word stays at or below 60 characters so a folded line, including a
 * header name such as "Subject: ", stays within the 78-character limit.
 */
function encodeHeaderWords(value) {
  const text = unfold(value);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const prefix = '=?UTF-8?Q?';
  const words = [];
  let current = '';
  for (const ch of text) {
    const enc = Array.from(new TextEncoder().encode(ch))
      .map((b) =>
        (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
          ? String.fromCharCode(b)
          : b === 0x20
            ? '_'
            : '=' + b.toString(16).toUpperCase().padStart(2, '0'),
      )
      .join('');
    if (prefix.length + current.length + enc.length + 2 > 60) {
      words.push(`${prefix}${current}?=`);
      current = '';
    }
    current += enc;
  }
  if (current) words.push(`${prefix}${current}?=`);
  return words.join(' ');
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** A parameter value as a quoted string: a backslash before each quote and backslash. */
function quotedString(value) {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * Content-Type with the attachment's name, as header lines. A non-ASCII name goes in as
 * one RFC 2047 encoded word, for clients that read no RFC 2231, on a line of its own
 * when it is long, and is left out when that line would pass 78 characters:
 * Content-Disposition carries it.
 */
function contentTypeWithName(contentType, filename) {
  if (PRINTABLE_ASCII.test(filename)) return [`Content-Type: ${contentType}; name=${quotedString(filename)}`];
  const name = ` name="${encodeHeaderValue(filename)}"`;
  if (name.length > 78) return [`Content-Type: ${contentType}`];
  const single = `Content-Type: ${contentType};${name}`;
  return single.length <= 78 ? [single] : [`Content-Type: ${contentType};`, name];
}

// What stands for itself in an RFC 2231 extended value (RFC 5987 attr-char).
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;
// So a line " filename*10*=...;" stays within 78 characters.
const SECTION_LENGTH = 60;

/**
 * Content-Disposition with the attachment's file name, as header lines. A non-ASCII name
 * is written by RFC 2231: `filename*=UTF-8''...` with each byte outside attr-char as
 * %XX, and in numbered sections on lines of their own when it is long, each section
 * holding whole characters.
 */
function dispositionWithFilename(disposition, filename) {
  if (PRINTABLE_ASCII.test(filename)) return [`Content-Disposition: ${disposition}; filename=${quotedString(filename)}`];
  const chars = Array.from(filename, (ch) => (ATTR_CHAR.test(ch)
    ? ch
    : Array.from(new TextEncoder().encode(ch), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')));
  const single = `Content-Disposition: ${disposition}; filename*=UTF-8''${chars.join('')}`;
  if (single.length <= 78) return [single];
  const sections = [];
  let current = "UTF-8''";
  for (const ch of chars) {
    if (current.length + ch.length > SECTION_LENGTH) {
      sections.push(current);
      current = '';
    }
    current += ch;
  }
  sections.push(current);
  return [
    `Content-Disposition: ${disposition};`,
    ...sections.map((section, i) => ` filename*${i}*=${section}${i < sections.length - 1 ? ';' : ''}`),
  ];
}

function encodeHeaderValue(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const encoded = Array.from(new TextEncoder().encode(value))
    .map((b) => {
      if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) {
        return String.fromCharCode(b);
      }
      return '=' + b.toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');
  return `=?UTF-8?Q?${encoded}?=`;
}

function formatDate(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = days[date.getUTCDay()];
  const dd = date.getUTCDate();
  const m = months[date.getUTCMonth()];
  const y = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${d}, ${dd} ${m} ${y} ${hh}:${mm}:${ss} +0000`;
}

/**
 * Wrap a CMS binary blob in a proper RFC 5322 / S/MIME message.
 * Returns a Blob of type message/rfc822.
 */
export function wrapCmsAsSmimeMessage(cmsBlob, input) {
  const lines = messageHeaderLines(input);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: application/pkcs7-mime; smime-type=${input.smimeType}; name="smime.p7m"`);
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('Content-Disposition: attachment; filename="smime.p7m"');

  // Terminate the header block with a BLANK LINE (CRLFCRLF) before the base64
  // body. The body is concatenated as a separate Blob below, so a trailing ''
  // in `lines` only yields a single CRLF — gluing the CMS onto the last header.
  // A strict parser (Stalwart/mail-parser) then reads the base64 as malformed
  // headers and leaves the pkcs7-mime part empty, which surfaces on the
  // receiving side as "Invalid ASN.1 data - cannot parse CMS envelope".
  const headerBytes = new TextEncoder().encode(lines.join(CRLF) + CRLF + CRLF);
  return new Blob([headerBytes, cmsToBase64Blob(cmsBlob)], { type: 'message/rfc822' });
}

/**
 * Wrap a signed entity and its detached signature as multipart/signed (RFC 8551 §3.5.3).
 * Returns a Blob of type message/rfc822.
 */
export function wrapDetachedSignedMessage(entityBytes, signatureDer, input) {
  const boundary = generateBoundary();
  const lines = messageHeaderLines(input);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: multipart/signed; protocol="application/pkcs7-signature";');
  lines.push(` micalg=sha-256; boundary="${boundary}"`);
  lines.push('');
  lines.push('This is a cryptographically signed message in MIME format.');
  lines.push('');
  lines.push(`--${boundary}`);
  const head = new TextEncoder().encode(lines.join(CRLF) + CRLF);

  // The CRLF before a boundary belongs to the boundary (RFC 2046 §5.1.1).
  const tail = [
    '',
    `--${boundary}`,
    'Content-Type: application/pkcs7-signature; name="smime.p7s"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="smime.p7s"',
    '',
    base64Encode(signatureDer.buffer.slice(signatureDer.byteOffset, signatureDer.byteOffset + signatureDer.byteLength)),
    `--${boundary}--`,
    '',
  ].join(CRLF);

  return new Blob([head, entityBytes, new TextEncoder().encode(tail)], { type: 'message/rfc822' });
}

function cmsToBase64Blob(data) {
  let bytes;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else bytes = new Uint8Array(0);
  const b64 = base64Encode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return new Blob([new TextEncoder().encode(b64 + CRLF)]);
}

/**
 * Encode string as quoted-printable (RFC 2045). A line break is CRLF or a bare LF. What
 * a relay may rewrite under a signature is encoded: a CR that is no part of a line break
 * (in the 7-bit and 8-bit data of RFC 8551 §1.2 a CR occurs only in CRLF), and the F of
 * "From " at the start of a line (delivery agents write ">From "; RFC 3156 §3 suggests
 * encoding it for that reason).
 */
export function quotedPrintableEncode(input) {
  const bytes = new TextEncoder().encode(input);
  const lines = [];
  let line = '';

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    // The CR of a CRLF: the LF that follows ends the line.
    if (b === 0x0d && bytes[i + 1] === 0x0a) continue;
    if (b === 0x0a) {
      lines.push(...hardLine(line));
      line = '';
      continue;
    }

    const encoded = b === 0x09 || (b >= 0x20 && b <= 0x7e && b !== 0x3d)
      ? String.fromCharCode(b)
      : '=' + b.toString(16).toUpperCase().padStart(2, '0');
    if (line === 'From' && encoded === ' ') line = '=46rom';

    if (line.length + encoded.length > 75) {
      lines.push(line + '=');
      line = encoded;
    } else {
      line += encoded;
    }
  }
  lines.push(...hardLine(line));
  return lines.join(CRLF);
}

// Encode trailing whitespace (RFC 2045 §6.7) — relays may strip it and break the signature.
function hardLine(line) {
  const last = line[line.length - 1];
  if (last !== ' ' && last !== '\t') return [line];
  const escaped = last === ' ' ? '=20' : '=09';
  const rest = line.slice(0, -1);
  return rest.length + escaped.length > 76 ? [rest + '=', escaped] : [rest + escaped];
}

/** Encode ArrayBuffer as base64 with line breaks at 76 chars. */
export function base64Encode(data) {
  const bytes = new Uint8Array(data);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}
