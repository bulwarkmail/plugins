// A message can carry more than one text part outside multipart/alternative: text before
// and after an attachment, or a footer in a part of its own. All of them are the
// message's body, in order.
import { describe, expect, it } from 'vitest';
import { parseMime } from '../src/mime-parse.js';

const enc = (s) => new TextEncoder().encode(s);
const pdf = ['Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"', 'Content-Transfer-Encoding: base64', '', 'UERG'];

describe('several text parts in one message', () => {
  it('keeps the plain text before and after an attachment', () => {
    const parsed = parseMime(enc([
      'Content-Type: multipart/mixed; boundary="b"', '',
      '--b', 'Content-Type: text/plain; charset=utf-8', '', 'First paragraph, before the attachment.',
      '--b', ...pdf,
      '--b', 'Content-Type: text/plain; charset=utf-8', '', 'Second paragraph, after the attachment.',
      '--b--', '',
    ].join('\r\n')));
    expect(parsed.text).toContain('First paragraph, before the attachment.');
    expect(parsed.text).toContain('Second paragraph, after the attachment.');
    expect(parsed.text.indexOf('First')).toBeLessThan(parsed.text.indexOf('Second'));
    expect(parsed.attachments).toHaveLength(1);
  });

  it('keeps the HTML before and after an attachment', () => {
    const parsed = parseMime(enc([
      'Content-Type: multipart/mixed; boundary="b"', '',
      '--b', 'Content-Type: text/html; charset=utf-8', '', '<p>First</p>',
      '--b', ...pdf,
      '--b', 'Content-Type: text/html; charset=utf-8', '', '<p>Second</p>',
      '--b--', '',
    ].join('\r\n')));
    expect(parsed.html).toContain('<p>First</p>');
    expect(parsed.html).toContain('<p>Second</p>');
  });

  it('keeps a footer part a list appended', () => {
    const parsed = parseMime(enc([
      'Content-Type: multipart/mixed; boundary="b"', '',
      '--b', 'Content-Type: text/plain; charset=utf-8', '', 'The actual message.',
      '--b', 'Content-Type: text/plain; charset=utf-8', '', '-- ', 'list footer',
      '--b--', '',
    ].join('\r\n')));
    expect(parsed.text).toContain('The actual message.');
    expect(parsed.text).toContain('list footer');
  });

  it('still takes one text and one HTML body from multipart/alternative', () => {
    const parsed = parseMime(enc([
      'Content-Type: multipart/alternative; boundary="a"', '',
      '--a', 'Content-Type: text/plain; charset=utf-8', '', 'plain version',
      '--a', 'Content-Type: text/html; charset=utf-8', '', '<p>html version</p>',
      '--a--', '',
    ].join('\r\n')));
    expect(parsed.text).toBe('plain version');
    expect(parsed.html).toBe('<p>html version</p>');
  });
});
