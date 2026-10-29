// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { candidates, decodeXml, findInvoice } from '../src/lib/detect.js';
import { fixture, makePdf } from './helpers.mjs';

const enc = (s) => new TextEncoder().encode(s);
const ubl = fixture('xrechnung-ubl.xml');
const cii = fixture('zugferd-cii.xml');

function reader(files) {
  const read = vi.fn(async (blobId) => {
    if (!(blobId in files)) throw new Error('no such blob');
    return files[blobId].buffer;
  });
  return read;
}

describe('findInvoice', () => {
  it('reads an XRechnung XML attachment', async () => {
    const read = reader({ x: enc(ubl) });
    const found = await findInvoice([{ blobId: 'x', name: 'RE-2026-117.xml', type: 'application/xml', size: 9000 }], read);
    expect(found.invoice.number).toBe('RE-2026-117');
    expect(found.source).toEqual({ blobId: 'x', name: 'RE-2026-117.xml', kind: 'xml', embeddedName: '' });
  });

  it('reads the XML inside a ZUGFeRD PDF', async () => {
    const read = reader({ p: makePdf([{ name: 'factur-x.xml', content: cii }]) });
    const found = await findInvoice([{ blobId: 'p', name: 'Rechnung.pdf', type: 'application/pdf', size: 20000 }], read);
    expect(found.invoice.syntax).toBe('cii');
    expect(found.source).toMatchObject({ kind: 'pdf', embeddedName: 'factur-x.xml' });
  });

  it('skips an embedded file that is not the invoice, even with a long comment first', async () => {
    const other = '<?xml version="1.0"?><!-- ' + 'x'.repeat(5000) + ' --><adt:additionalData xmlns:adt="urn:x"/>';
    const commented = cii.replace('<x:CrossIndustryInvoice', `<!-- ${'Nutzungsrechte '.repeat(400)} -->\n<x:CrossIndustryInvoice`);
    const read = reader({ p: makePdf([{ name: 'additional.xml', content: other }, { name: 'ZUGFeRD-invoice.xml', content: commented }]) });
    const found = await findInvoice([{ blobId: 'p', name: 'a.pdf', type: 'application/pdf', size: 1 }], read);
    expect(found.source.embeddedName).toBe('ZUGFeRD-invoice.xml');
  });

  it('prefers the XML when a message has XML and PDF, and only reads what it needs', async () => {
    const read = reader({ p: makePdf([{ name: 'factur-x.xml', content: cii }]), x: enc(ubl) });
    const found = await findInvoice([
      { blobId: 'p', name: 'Rechnung.pdf', type: 'application/pdf', size: 1 },
      { blobId: 'x', name: 'Rechnung.xml', type: 'text/xml', size: 1 },
    ], read);
    expect(found.source.kind).toBe('xml');
    expect(read.mock.calls).toEqual([['x']]);
  });

  it('finds nothing in a plain PDF, an order XML or a picture, and skips files that fail to load', async () => {
    const read = reader({
      p: enc('%PDF-1.4\n%%EOF'),
      o: enc('<?xml version="1.0"?><Order xmlns="urn:oasis:names:specification:ubl:schema:xsd:Order-2"/>'),
    });
    expect(await findInvoice([
      { blobId: 'gone', name: 'lost.xml', type: 'application/xml', size: 1 },
      { blobId: 'p', name: 'scan.pdf', type: 'application/pdf', size: 1 },
      { blobId: 'o', name: 'order.xml', type: 'application/xml', size: 1 },
      { blobId: 'i', name: 'photo.jpg', type: 'image/jpeg', size: 1 },
    ], read)).toBeNull();
    expect(read).not.toHaveBeenCalledWith('i');
  });

  it('leaves out files too large to be an invoice', () => {
    expect(candidates([
      { blobId: 'a', name: 'big.pdf', type: 'application/pdf', size: 50 * 1024 * 1024 },
      { blobId: 'b', name: 'x.XML', type: 'application/octet-stream', size: 10 },
    ]).map((c) => c.blobId)).toEqual(['b']);
  });
});

describe('decodeXml', () => {
  it('uses the encoding the XML declares', () => {
    const latin1 = Uint8Array.from('<?xml version="1.0" encoding="ISO-8859-1"?><a>Müller</a>', (c) => c.charCodeAt(0));
    expect(decodeXml(latin1)).toContain('Müller');
    expect(decodeXml(enc('﻿<?xml version="1.0"?><a>Müller</a>'))).toContain('Müller');
  });
});
