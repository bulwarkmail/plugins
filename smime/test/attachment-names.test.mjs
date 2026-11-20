// The names of attachments inside a signed or decrypted message, as the reader sees
// them: RFC 2047 encoded words and RFC 2231 parameters are decoded, not shown raw.
import { describe, expect, it } from 'vitest';
import { parseMime } from '../src/mime-parse.js';
import { buildMimeEntity } from '../src/mime-builder.js';

const enc = (s) => new TextEncoder().encode(s);
const message = (...partHeaders) => enc([
  'Content-Type: multipart/mixed; boundary="b"', '',
  '--b', 'Content-Type: text/plain; charset=utf-8', '', 'See attached.',
  '--b', ...partHeaders, 'Content-Transfer-Encoding: base64', '', 'UERG',
  '--b--', '',
].join('\r\n'));
const nameOf = (...partHeaders) => parseMime(message(...partHeaders)).attachments[0].name;

describe('attachment names in signed and decrypted mail', () => {
  it('decodes a Q encoded word in the filename parameter', () => {
    expect(nameOf('Content-Type: application/pdf', 'Content-Disposition: attachment; filename="=?UTF-8?Q?Bericht_M=C3=A4rz.pdf?="'))
      .toBe('Bericht März.pdf');
  });

  it('decodes a B encoded word in the name parameter of Content-Type', () => {
    expect(nameOf('Content-Type: application/pdf; name="=?UTF-8?B?UmVjaG51bmcgTcOkcnoucGRm?="', 'Content-Disposition: attachment'))
      .toBe('Rechnung März.pdf');
  });

  it('decodes an RFC 2231 filename with its charset', () => {
    expect(nameOf('Content-Type: application/pdf', "Content-Disposition: attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf"))
      .toBe('Rechnung März.pdf');
  });

  it('joins RFC 2231 sections', () => {
    expect(nameOf('Content-Type: application/pdf', 'Content-Disposition: attachment;', " filename*0*=UTF-8''Sehr%20langer%20Name%20;", ' filename*1*=Teil%20zwei.pdf'))
      .toBe('Sehr langer Name Teil zwei.pdf');
  });

  it('keeps a plain ASCII name as it is', () => {
    expect(nameOf('Content-Type: application/pdf', 'Content-Disposition: attachment; filename="report.pdf"')).toBe('report.pdf');
  });

  it('reads back the name of an attachment this plugin sent', () => {
    const entity = buildMimeEntity({
      from: { email: 'alice@example.com' }, to: [{ email: 'bob@example.org' }], subject: 's', textBody: 'x',
      attachments: [{ filename: 'Übersicht März.pdf', contentType: 'application/pdf', content: enc('PDF').buffer }],
    });
    expect(parseMime(entity).attachments[0].name).toBe('Übersicht März.pdf');
  });
});
