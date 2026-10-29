// Find the e-invoice among a message's attachments: an XML file in UBL or
// CII (XRechnung), or a PDF with the invoice XML embedded (ZUGFeRD,
// Factur-X). XML files are tried first: when both come, the XML is the
// invoice and the PDF its picture.

import { looksLikeInvoiceXml, parseInvoice } from './parse.js';
import { embeddedFiles, isPdf } from './pdf.js';

/** Larger attachments are not read: invoices are small, and the host stops at 25 MB. */
export const MAX_XML_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

const ext = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();

export function kindOf(att) {
  const type = (att.type || '').toLowerCase();
  const e = ext(att.name);
  if (e === 'xml' || /[/+]xml$/.test(type)) return 'xml';
  if (e === 'pdf' || type === 'application/pdf') return 'pdf';
  return null;
}

/** The attachments worth reading, XML before PDF. */
export function candidates(attachments) {
  const out = [];
  for (const att of attachments || []) {
    const kind = kindOf(att);
    if (!kind || !att.blobId) continue;
    if (att.size > (kind === 'xml' ? MAX_XML_BYTES : MAX_PDF_BYTES)) continue;
    out.push({ ...att, kind });
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'xml' ? -1 : 1));
}

/** Whether a message may hold an e-invoice, from its attachment list alone. */
export function mayHoldInvoice(email) {
  return candidates(email?.attachments).length > 0;
}

/** XML bytes as text, in the encoding the XML declaration names. */
export function decodeXml(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 200));
  const declared = /encoding\s*=\s*["']([\w.-]+)["']/i.exec(head)?.[1];
  try {
    return new TextDecoder(declared || 'utf-8').decode(u8);
  } catch {
    return new TextDecoder('utf-8').decode(u8);
  }
}

function tryParse(text) {
  if (!looksLikeInvoiceXml(text)) return null;
  try {
    return parseInvoice(text);
  } catch {
    return null;
  }
}

/** The invoice in one attachment's bytes, or null. */
export function invoiceFromBytes(kind, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (kind === 'xml') {
    const text = decodeXml(u8);
    const invoice = tryParse(text);
    return invoice ? { invoice, xml: text } : null;
  }
  if (kind === 'pdf' && isPdf(u8)) {
    for (const file of embeddedFiles(u8)) {
      const text = decodeXml(file.data);
      const invoice = tryParse(text);
      if (invoice) return { invoice, xml: text, embeddedName: file.name || '' };
    }
  }
  return null;
}

/**
 * The e-invoice of a message, or null. `read(blobId)` resolves to the
 * attachment's bytes (api.email.getAttachment(...).data).
 */
export async function findInvoice(attachments, read) {
  for (const att of candidates(attachments)) {
    let data;
    try {
      data = await read(att.blobId);
    } catch {
      continue;
    }
    const found = invoiceFromBytes(att.kind, data);
    if (found) {
      return {
        ...found,
        source: { blobId: att.blobId, name: att.name || '', kind: att.kind, embeddedName: found.embeddedName || '' },
      };
    }
  }
  return null;
}
