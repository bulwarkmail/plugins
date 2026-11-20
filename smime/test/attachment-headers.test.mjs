// The Content-Type and Content-Disposition of an attachment in outgoing S/MIME mail: the
// file name arrives whole whatever characters it holds, and no line grows past what mail
// servers take. mime-builder.test.mjs has the message headers.
import { describe, expect, it } from 'vitest';
import { buildMimeEntity } from '../src/mime-builder.js';

const enc = (s) => new TextEncoder().encode(s);
// The header block of the attachment's part: the last part of the multipart/mixed.
const entityWith = (filename, extra = {}) => {
  const raw = new TextDecoder().decode(buildMimeEntity({
    from: { email: 'alice@example.com' }, to: [{ email: 'bob@example.org' }], subject: 's', textBody: 'x',
    attachments: [{ filename, contentType: 'application/pdf', content: enc('PDF').buffer, ...extra }],
  }));
  const part = raw.split(/\r\n------=_Part_[0-9a-f]+\r\n/).at(-1);
  return part.slice(0, part.indexOf('\r\n\r\n'));
};
const unfold = (s) => s.replace(/\r\n(?=[ \t])/g, '');
const field = (raw, name) => unfold(raw).split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`)) ?? '';

// A quoted parameter read by the rules of RFC 2045: a backslash escapes the next character.
const quoted = (raw, header, param) => {
  const m = field(raw, header).match(new RegExp(`[; ]${param}="((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1].replace(/\\(.)/g, '$1') : null;
};
// An RFC 2231 extended parameter, one value or numbered sections, each decoded on its own.
const sections = (raw, header, param) => [...field(raw, header).matchAll(new RegExp(`[; ]${param}\\*(\\d*)\\*?=([^;]*)`, 'g'))]
  .sort((a, b) => Number(a[1]) - Number(b[1]))
  .map((m, i) => (i === 0 ? m[2].replace(/^UTF-8''/, '') : m[2]));
const extended = (raw, header, param) => sections(raw, header, param).map((s) => decodeURIComponent(s)).join('');
const longestLine = (raw) => Math.max(...raw.split('\r\n').map((l) => l.length));

describe('an ASCII file name', () => {
  it('goes into both headers as it is', () => {
    const raw = entityWith('report.pdf');
    expect(field(raw, 'Content-Type')).toBe('Content-Type: application/pdf; name="report.pdf"');
    expect(field(raw, 'Content-Disposition')).toBe('Content-Disposition: attachment; filename="report.pdf"');
  });

  it('keeps blanks as they are', () => {
    expect(quoted(entityWith('two  blanks.pdf'), 'Content-Disposition', 'filename')).toBe('two  blanks.pdf');
  });

  it('keeps a double quote', () => {
    const raw = entityWith('Offer "final".pdf');
    expect(quoted(raw, 'Content-Disposition', 'filename')).toBe('Offer "final".pdf');
    expect(quoted(raw, 'Content-Type', 'name')).toBe('Offer "final".pdf');
  });

  it('keeps a backslash', () => {
    const raw = entityWith('a\\b.pdf');
    expect(quoted(raw, 'Content-Disposition', 'filename')).toBe('a\\b.pdf');
    expect(quoted(raw, 'Content-Type', 'name')).toBe('a\\b.pdf');
  });

  it('keeps a semicolon inside the quotes', () => {
    expect(quoted(entityWith('a;b.pdf'), 'Content-Disposition', 'filename')).toBe('a;b.pdf');
  });
});

describe('a file name with non-ASCII characters', () => {
  it('goes into Content-Disposition by RFC 2231 and into Content-Type as an encoded word', () => {
    const raw = entityWith('Übung 1.pdf');
    expect(field(raw, 'Content-Disposition')).toBe("Content-Disposition: attachment; filename*=UTF-8''%C3%9Cbung%201.pdf");
    expect(field(raw, 'Content-Type')).toBe('Content-Type: application/pdf; name="=?UTF-8?Q?=C3=9Cbung=201=2Epdf?="');
  });

  it('moves a name that no longer fits the line into sections', () => {
    const raw = entityWith('Übersicht März.pdf');
    expect(raw.split('\r\n')).toContain('Content-Disposition: attachment;');
    expect(extended(raw, 'Content-Disposition', 'filename')).toBe('Übersicht März.pdf');
    expect(longestLine(raw)).toBeLessThanOrEqual(78);
  });

  it('puts a long encoded word in Content-Type on a line of its own', () => {
    const raw = entityWith('Übersicht März.pdf');
    expect(raw.split('\r\n')).toContain('Content-Type: application/pdf;');
    expect(field(raw, 'Content-Type')).toBe('Content-Type: application/pdf; name="=?UTF-8?Q?=C3=9Cbersicht=20M=C3=A4rz=2Epdf?="');
  });

  it('writes no raw 8-bit byte and no line break from the name into the headers', () => {
    const head = entityWith('Ü\r\nX-Injected: yes.pdf');
    expect(head).not.toMatch(/[^\x00-\x7f]/);
    expect(head).not.toMatch(/^X-Injected:/m);
  });

  it('keeps every line within 78 characters for a long name', () => {
    const name = `${'Ä'.repeat(200)}.pdf`;
    const raw = entityWith(name);
    expect(longestLine(raw)).toBeLessThanOrEqual(78);
    expect(extended(raw, 'Content-Disposition', 'filename')).toBe(name);
  });

  it('splits a long name into sections that each hold whole characters', () => {
    const name = `${'日本語のファイル名'.repeat(12)} 🙂.pdf`;
    const raw = entityWith(name);
    const parts = sections(raw, 'Content-Disposition', 'filename');
    expect(parts.length).toBeGreaterThan(1);
    // decodeURIComponent throws on a section that ends inside a character.
    expect(parts.map((s) => decodeURIComponent(s)).join('')).toBe(name);
    expect(longestLine(raw)).toBeLessThanOrEqual(78);
  });

  it('leaves the name out of Content-Type when one encoded word could not hold it', () => {
    const raw = entityWith(`${'Ä'.repeat(40)}.pdf`);
    expect(field(raw, 'Content-Type')).toBe('Content-Type: application/pdf');
    expect(extended(raw, 'Content-Disposition', 'filename')).toBe(`${'Ä'.repeat(40)}.pdf`);
  });

  it('writes an image in the text the same way, as inline with its Content-ID', () => {
    const raw = entityWith('Grüße.png', { cid: 'img1@example.com', contentType: 'image/png' });
    expect(field(raw, 'Content-Disposition')).toBe("Content-Disposition: inline; filename*=UTF-8''Gr%C3%BC%C3%9Fe.png");
    expect(field(raw, 'Content-ID')).toBe('Content-ID: <img1@example.com>');
  });
});
