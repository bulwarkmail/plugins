// Header serialisation of outgoing S/MIME messages: folding must never end the
// header block early, split a message id or an RFC 2047 encoded-word.
import { describe, expect, it } from 'vitest';
import { buildMimeMessage } from '../src/mime-builder.js';

const base = {
  from: { email: 'alice@example.com', name: 'Alice Example' },
  to: [{ email: 'bob@example.org' }],
  subject: 'Re: Test',
  textBody: 'Hello\r\n',
};

function headerBlock(input) {
  const raw = new TextDecoder().decode(buildMimeMessage({ ...base, ...input }));
  const end = raw.indexOf('\r\n\r\n');
  return raw.slice(0, end);
}

const unfold = (h) => h.replace(/\r\n(?=[ \t])/g, '');
const field = (h, name) => unfold(h).split('\r\n').find((l) => l.startsWith(`${name}:`)) ?? '';

const outlookId = 'AB1PR09MB0000A0AA00AA0000000AAAAA0000@AB1PR09MB0000.EURPRD09.PROD.OUTLOOK.COM';

describe('mime-builder headers', () => {
  it('keeps MIME-Version and Content-Type in the header block when references carry CRLF', () => {
    const h = headerBlock({
      inReplyTo: 'c@example.net',
      references: ['a@example.net\r\n', ` ${outlookId}`, 'b@example.net\r\n', 'c@example.net'],
    });
    expect(h).toMatch(/^MIME-Version: 1\.0$/m);
    expect(h).toMatch(/^Content-Type: /m);
    expect(h.split('\r\n').every((l) => l.trim() !== '')).toBe(true);
  });

  it('writes message ids in angle brackets and never splits one', () => {
    const h = headerBlock({ inReplyTo: 'c@example.net', references: ['<a@example.net>', outlookId, 'c@example.net'] });
    expect(field(h, 'In-Reply-To')).toBe('In-Reply-To: <c@example.net>');
    expect(field(h, 'References')).toBe(`References: <a@example.net> <${outlookId}> <c@example.net>`);
    expect(h).toContain(`<${outlookId}>`);
  });

  it('folds long non-ASCII subjects between complete encoded-words', () => {
    const subject = 'AW: Dein Wikipedia-Artikel ist jetzt veröffentlicht – Prüfbericht für die Geschäftsführung';
    const h = headerBlock({ subject });
    const words = field(h, 'Subject').slice('Subject: '.length).split(' ');
    for (const w of words) expect(w).toMatch(/^=\?UTF-8\?Q\?[^?\s]*\?=$/);
    for (const line of h.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    const decoded = words
      .map((w) => w.slice(10, -2).replace(/_/g, ' ').replace(/=([0-9A-F]{2})/g, '%$1'))
      .map((w) => decodeURIComponent(w))
      .join('');
    expect(decoded).toBe(subject);
  });

  it('encodes non-ASCII display names instead of sending raw 8-bit', () => {
    const h = headerBlock({ to: [{ email: 'bob@example.org', name: 'Bob Müller' }] });
    expect(field(h, 'To')).toBe('To: =?UTF-8?Q?Bob_M=C3=BCller?= <bob@example.org>');
    expect(/[^\x00-\x7f]/.test(h)).toBe(false);
  });

  it("uses the sender's domain for the generated Message-ID", () => {
    expect(field(headerBlock({}), 'Message-ID')).toMatch(/^Message-ID: <[0-9a-f-]+@example\.com>$/);
  });

  it('keeps the display name in From', () => {
    expect(field(headerBlock({}), 'From')).toBe('From: "Alice Example" <alice@example.com>');
  });
});
