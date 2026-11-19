// Signed or encrypted content without MIME headers of its own (`openssl cms -sign` or
// `-encrypt` over plain text), and a part whose header block is empty (RFC 2046 §5.1.1:
// text/plain then). The whole text is the body; its first paragraph is not a header.
import { describe, expect, it } from 'vitest';
import { parseMime, extractDetachedSigned, opaqueBody } from '../src/mime-parse.js';

const enc = (s) => new TextEncoder().encode(s);

describe('content without headers', () => {
  it('shows every paragraph of content that has no header block', () => {
    const { text } = parseMime(enc('Hello Bob,\r\n\r\nsecond paragraph.\r\n'));
    expect(text).toContain('Hello Bob,');
    expect(text).toContain('second paragraph.');
  });

  it('shows every paragraph of a part with an empty header block', () => {
    const { text } = parseMime(enc([
      'Content-Type: multipart/mixed; boundary="b"', '',
      '--b', '', 'Paragraph one.', '', 'Paragraph two.',
      '--b--', '',
    ].join('\r\n')));
    expect(text).toContain('Paragraph one.');
    expect(text).toContain('Paragraph two.');
  });

  it('still reads a header block when there is one', () => {
    const { text } = parseMime(enc('Content-Type: text/plain; charset=utf-8\r\n\r\nOnly the body.\r\n'));
    expect(text.trim()).toBe('Only the body.');
  });

  it('reads content that starts with a line holding a colon further in as text too', () => {
    const { text } = parseMime(enc('Dear Bob, one thing: call me.\r\n\r\nThanks.\r\n'));
    expect(text).toContain('Dear Bob, one thing: call me.');
    expect(text).toContain('Thanks.');
  });

  it('shows text that has no blank line at all', () => {
    expect(parseMime(enc('just one line')).text).toBe('just one line');
  });
});

// The plugin vouches only for a message whose headers read one way. Content without a
// header block is shown, but never taken for the signed or encrypted message itself.
describe('what is verified or decrypted still needs its headers', () => {
  const signed = (entity) => enc([
    'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary="b"', '',
    '--b', ...entity,
    '--b', 'Content-Type: application/pkcs7-signature', 'Content-Transfer-Encoding: base64', '', 'MAA=',
    '--b--', '',
  ].join('\r\n'));

  it('takes a signed entity with a header block', () => {
    expect(extractDetachedSigned(signed(['Content-Type: text/plain', '', 'Hello']))).not.toBeNull();
  });

  it('does not take a signed entity with an empty header block', () => {
    expect(extractDetachedSigned(signed(['', 'Hello', '', 'again']))).toBeNull();
  });

  it('does not take a message without a header block for pkcs7-mime', () => {
    expect(opaqueBody(enc('MIIB\r\n\r\nAAAA\r\n'))).toBeNull();
    expect(opaqueBody(enc('\r\nContent-Type: application/pkcs7-mime\r\n\r\nMIIB\r\n'))).toBeNull();
  });
});
