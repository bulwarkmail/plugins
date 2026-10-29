// The XML files embedded in a PDF: how ZUGFeRD and Factur-X carry the
// invoice (a PDF/A-3 with factur-x.xml, zugferd-invoice.xml, xrechnung.xml
// or ZUGFeRD-invoice.xml attached).
//
// Not a PDF parser. Embedded files are stream objects marked
// /Type /EmbeddedFile, and stream objects never sit inside compressed
// object streams, so their dictionaries can be read as text. The file
// names often can, too; when they are compressed away the caller goes by
// the content instead.

import { inflate } from './inflate.js';

const latin1 = (bytes) => new TextDecoder('latin1').decode(bytes);

export function isPdf(bytes) {
  return bytes.length > 5 && latin1(bytes.subarray(0, 1024)).includes('%PDF-');
}

/** A PDF string literal or hex string as text: (factur-x.xml) or <FEFF...>. */
function pdfString(raw) {
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s/g, '');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return decodeTextBytes(bytes);
  }
  const body = raw.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => {
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[e] ?? e;
  });
  const bytes = Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
  return decodeTextBytes(bytes);
}

function decodeTextBytes(bytes) {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(bytes.subarray(3));
  return latin1(bytes);
}

/** File names of the embedded files, by the object number of their stream. */
function fileNames(text) {
  const names = new Map();
  // /EF << /F 12 0 R /UF 12 0 R >> next to /F (name) or /UF (name), in either order.
  const spec = /\/EF\s*<<\s*\/(?:U?F)\s+(\d+)\s+\d+\s+R[^>]*>>/g;
  let m;
  while ((m = spec.exec(text))) {
    const objectNumber = Number(m[1]);
    // The filespec dictionary around it: look a little back and ahead.
    const around = text.slice(Math.max(0, m.index - 600), m.index + m[0].length + 600);
    const name = /\/UF\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(around) || /\/F\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(around);
    if (name && !names.has(objectNumber)) names.set(objectNumber, pdfString(name[1]));
  }
  return names;
}

function directLength(dict, text) {
  const ref = /\/Length\s+(\d+)\s+(\d+)\s+R/.exec(dict);
  if (ref) {
    const target = new RegExp(`(?:^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj\\s*(\\d+)\\s*endobj`).exec(text);
    return target ? Number(target[1]) : null;
  }
  const direct = /\/Length\s+(\d+)/.exec(dict);
  return direct ? Number(direct[1]) : null;
}

/**
 * Every embedded file of the PDF as { name, data }, data inflated.
 * Streams that can't be read (encrypted, other filters) are skipped.
 */
export function embeddedFiles(bytes, { maxFiles = 20, maxFileBytes = 20 * 1024 * 1024 } = {}) {
  const text = latin1(bytes);
  const encrypted = /\/Encrypt\s+(\d+\s+\d+\s+R|<<)/.test(text);
  const names = fileNames(text);
  const files = [];
  // The keyword `stream` after a dictionary; the object header is the
  // nearest `N G obj` before it.
  const streamRe = />>\s*stream(\r\n|\n|\r)/g;
  let m;
  while ((m = streamRe.exec(text)) && files.length < maxFiles) {
    const objAt = text.lastIndexOf('obj', m.index);
    const header = objAt > 0 ? /(\d+)\s+\d+\s+$/.exec(text.slice(Math.max(0, objAt - 24), objAt)) : null;
    const dict = objAt > 0 ? text.slice(objAt + 3, m.index + 2) : '';
    const objectNumber = header ? Number(header[1]) : -1;
    if (!/\/Type\s*\/EmbeddedFile\b/.test(dict) && !/\/Subtype\s*\/(?:text#2[Ff]xml|application#2[Ff]xml)/.test(dict)) continue;
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    const length = directLength(dict, text);
    let raw = bytes.subarray(start, length !== null && start + length <= end ? start + length : end);
    // Without a usable /Length, endstream comes after an end-of-line.
    if (length === null) {
      let e = raw.length;
      while (e > 0 && (raw[e - 1] === 0x0a || raw[e - 1] === 0x0d)) e--;
      raw = raw.subarray(0, e);
    }
    streamRe.lastIndex = end;
    const filter = /\/Filter\s*\[?\s*\/(\w+)/.exec(dict)?.[1];
    let data;
    try {
      if (!filter) data = raw.slice();
      else if (filter === 'FlateDecode' || filter === 'Fl') data = inflate(raw, maxFileBytes);
      else continue;
    } catch {
      continue;
    }
    files.push({ name: names.get(objectNumber) || '', data, encrypted });
  }
  return files;
}
