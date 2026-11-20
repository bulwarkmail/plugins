// The quoted-printable text of outgoing S/MIME mail. It is what a signature covers, so
// it has to decode to the text that went in, and hold nothing a relay rewrites on the
// way: no long line, no blank at the end of a line, no CR outside a
// line break (RFC 8551 §1.2), no "From " at the start of a line (RFC 3156 §3).
import { describe, expect, it } from 'vitest';
import { quotedPrintableEncode } from '../src/mime-builder.js';

const lines = (s) => quotedPrintableEncode(s).split('\r\n');

// RFC 2045 §6.7, read strictly: soft line breaks go, =XX is a byte, the rest stands.
function decode(qp) {
  const joined = qp.replace(/=\r\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=') {
      expect(joined.slice(i + 1, i + 3)).toMatch(/^[0-9A-F]{2}$/);
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

const SAMPLES = [
  'plain text',
  'Grüße aus Köln, 5 € = fünf Euro',
  'line one\r\nline two\r\n',
  'trailing blank \r\ntrailing tab\t\r\nend',
  `${'ä'.repeat(100)} ${'a'.repeat(200)}`,
  'From the start\r\nFrom the second line\r\nnot From inside',
  `${'a'.repeat(75)}From after a soft break`,
  'a lone\rCR and a CRLF\r\nend',
  '',
  '\r\n\r\n',
  '日本語 🙂 mixed',
];

describe('quoted-printable text', () => {
  it.each(SAMPLES.map((s) => [JSON.stringify(s).slice(0, 40), s]))('decodes to what went in: %s', (_, sample) => {
    expect(decode(quotedPrintableEncode(sample))).toBe(sample);
  });

  it.each(SAMPLES.map((s) => [JSON.stringify(s).slice(0, 40), s]))('keeps every line within 76 characters: %s', (_, sample) => {
    for (const line of lines(sample)) expect(line.length).toBeLessThanOrEqual(76);
  });

  it('leaves printable ASCII as it is and encodes the equals sign', () => {
    expect(quotedPrintableEncode('a=b, c!')).toBe('a=3Db, c!');
  });

  it('turns a bare LF into CRLF', () => {
    expect(quotedPrintableEncode('a\nb')).toBe('a\r\nb');
  });

  it('encodes a blank or tab at the end of a line', () => {
    expect(lines('trailing \r\ntab\t\r\nend')).toEqual(['trailing=20', 'tab=09', 'end']);
  });

  it('breaks a long line between characters of the encoding, never inside =XX', () => {
    for (const line of lines('ä'.repeat(200)).slice(0, -1)) expect(line).toMatch(/^(=[0-9A-F]{2})+=$/);
  });
});

describe('what a relay would rewrite', () => {
  it('encodes the F of "From " at the start of a line', () => {
    expect(lines('From here on\r\nFrom there')).toEqual(['=46rom here on', '=46rom there']);
  });

  it('encodes it after a soft line break too', () => {
    const out = lines(`${'a'.repeat(75)}From here`);
    expect(out).toEqual([`${'a'.repeat(75)}=`, '=46rom here']);
  });

  it('leaves "From" alone inside a line and without the blank', () => {
    expect(lines('Not From here\r\nFromage\r\nFrom')).toEqual(['Not From here', 'Fromage', 'From']);
  });

  it('encodes "From " that ends its line', () => {
    expect(lines('From \r\nx')).toEqual(['=46rom=20', 'x']);
  });

  it('encodes a CR that is no part of a line break', () => {
    const out = quotedPrintableEncode('lone\rCR');
    expect(out).toBe('lone=0DCR');
    expect(out).not.toMatch(/\r(?!\n)/);
  });

  it('encodes the first CR of CR CR LF and keeps the line break', () => {
    expect(quotedPrintableEncode('a\r\r\nb')).toBe('a=0D\r\nb');
  });

  it('encodes a CR at the very end', () => {
    expect(quotedPrintableEncode('end\r')).toBe('end=0D');
  });
});
