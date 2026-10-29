import { describe, expect, it } from 'vitest';
import { embeddedFiles, isPdf } from '../src/lib/pdf.js';
import { fixture, makePdf } from './helpers.mjs';

const xml = fixture('zugferd-cii.xml');
const text = (u8) => new TextDecoder().decode(u8);

describe('embedded files of a PDF', () => {
  it('finds factur-x.xml with its name', () => {
    const files = embeddedFiles(makePdf([{ name: 'factur-x.xml', content: xml }]));
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('factur-x.xml');
    expect(text(files[0].data)).toBe(xml);
  });

  it('reads the length from another object, or finds endstream when the length is wrong', () => {
    for (const lengthAs of ['ref', 'wrong']) {
      const [file] = embeddedFiles(makePdf([{ name: 'zugferd-invoice.xml', content: xml }], { lengthAs }));
      expect(text(file.data)).toBe(xml);
    }
  });

  it('copes with line breaks after the compressed data, which the browser decompressor rejects', () => {
    const [file] = embeddedFiles(makePdf([{ name: 'factur-x.xml', content: xml }], { lengthAs: 'wrong', junkAfterData: true }));
    expect(text(file.data)).toBe(xml);
  });

  it('reads uncompressed files, several files and UTF-16 names', () => {
    const files = embeddedFiles(makePdf([
      { name: 'notes.txt', content: 'hello' },
      { name: 'xrechnung.xml', content: xml },
    ], { compress: false, hexNames: true }));
    expect(files.map((f) => f.name)).toEqual(['notes.txt', 'xrechnung.xml']);
    expect(text(files[1].data)).toBe(xml);
  });

  it('finds nothing in a PDF without attachments, or in something that is not a PDF', () => {
    const plain = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n%%EOF');
    expect(isPdf(plain)).toBe(true);
    expect(embeddedFiles(plain)).toEqual([]);
    expect(isPdf(new TextEncoder().encode('<?xml version="1.0"?>'))).toBe(false);
  });
});
