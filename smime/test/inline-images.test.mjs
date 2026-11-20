// Images an HTML body shows with cid: URLs: a part the composer marks with a cid goes
// out with that Content-ID, so the recipient sees the image where it stands in the text.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';
import { fakeKeystore } from './helpers/fake-keystore.mjs';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { extractDetachedSigned, parseMime } from '../src/mime-parse.js';
import { buildMimeEntity, buildMimeMessage } from '../src/mime-builder.js';

// Where the image part stands in the message. Thunderbird looks a cid: URL up only in
// the multipart/related that holds the HTML body (RFC 2387); an image in multipart/mixed
// is listed as an attachment and the frame in the text stays empty.
describe('the structure of a message with an image in its text', () => {
  const enc = (s) => new TextEncoder().encode(s);
  const base = { from: { email: 'alice@example.com' }, to: [{ email: 'bob@example.org' }], subject: 's' };
  const image = { filename: 'logo.png', contentType: 'image/png', cid: 'img1@example.com', content: enc('PNG').buffer };
  const pdf = { filename: 'a.pdf', contentType: 'application/pdf', content: enc('PDF').buffer };
  const html = '<p><img src="cid:img1@example.com"></p>';

  // The media types of an entity and its parts, as nested arrays.
  const tree = (raw) => {
    const at = raw.indexOf('\r\n\r\n');
    const head = raw.slice(0, at).replace(/\r\n(?=[ \t])/g, '');
    const type = /^Content-Type: ([^;\r\n]+)/im.exec(head)[1];
    const boundary = /boundary="([^"]+)"/.exec(head)?.[1];
    if (!boundary) return type;
    const parts = raw.slice(at + 4).split(new RegExp(`(?:^|\\r\\n)--${boundary}(?:--)?(?:\\r\\n|$)`)).slice(1, -1);
    return [type, ...parts.map(tree)];
  };
  const entity = (input) => new TextDecoder().decode(buildMimeEntity({ ...base, ...input }));

  it('puts the image into multipart/related with the HTML body', () => {
    expect(tree(entity({ htmlBody: html, attachments: [image] }))).toEqual(['multipart/related', 'text/html', 'image/png']);
  });

  it('keeps the plain text as the other form of that body', () => {
    expect(tree(entity({ textBody: 'text', htmlBody: html, attachments: [image] })))
      .toEqual(['multipart/alternative', 'text/plain', ['multipart/related', 'text/html', 'image/png']]);
  });

  it('keeps an ordinary attachment beside the body in multipart/mixed', () => {
    expect(tree(entity({ textBody: 'text', htmlBody: html, attachments: [pdf, image] })))
      .toEqual(['multipart/mixed', ['multipart/alternative', 'text/plain', ['multipart/related', 'text/html', 'image/png']], 'application/pdf']);
  });

  it('builds the same structure for an opaque or encrypted message', () => {
    const raw = new TextDecoder().decode(buildMimeMessage({ ...base, htmlBody: html, attachments: [image, pdf] }));
    expect(tree(raw)).toEqual(['multipart/mixed', ['multipart/related', 'text/html', 'image/png'], 'application/pdf']);
  });

  it('leaves a message without an image in its text as it was', () => {
    expect(tree(entity({ textBody: 'text', htmlBody: '<p>x</p>', attachments: [pdf] })))
      .toEqual(['multipart/mixed', ['multipart/alternative', 'text/plain', 'text/html'], 'application/pdf']);
    expect(tree(entity({ textBody: 'text', htmlBody: '<p>x</p>' }))).toEqual(['multipart/alternative', 'text/plain', 'text/html']);
    expect(tree(entity({ textBody: 'text' }))).toBe('text/plain');
  });

  it('keeps a part with a cid in multipart/mixed when there is no HTML body to show it', () => {
    expect(tree(entity({ textBody: 'text', attachments: [image] }))).toEqual(['multipart/mixed', 'text/plain', 'image/png']);
  });

  it('writes the image part as inline with its Content-ID', () => {
    const raw = entity({ htmlBody: html, attachments: [image] });
    expect(raw).toContain('Content-Disposition: inline; filename="logo.png"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <img1@example.com>\r\n\r\n');
  });

  it('ends every nested multipart of a signed entity with a line break of its own', () => {
    const raw = entity({ textBody: 'text', htmlBody: html, attachments: [pdf, image] });
    for (const m of raw.matchAll(/\r\n(--[^\r\n]+--)\r\n(?=--)/g)) throw new Error(`no blank line after ${m[1]}`);
    expect(raw.endsWith('--\r\n')).toBe(true);
  });

  it('is read back by this plugin with its HTML and both parts', () => {
    const parsed = parseMime(buildMimeEntity({ ...base, textBody: 'text', htmlBody: html, attachments: [pdf, image] }));
    expect(parsed.html).toBe(html);
    expect(parsed.text).toBe('text');
    expect(parsed.attachments.map((a) => a.name).sort()).toEqual(['a.pdf', 'logo.png']);
  });
});

// The built bundle against the fake api, as the webmail's sandbox runs it: the composer
// hands every attachment over with its blob, and an image placed in the text with its cid.
describe('sending a message with an image in its text', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
  const fixture = (name) => readFileSync(path.join(here, 'fixtures', name)).toString();
  const FROM = 'smime-test@example.com';
  const IMAGE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  let code;

  beforeAll(async () => {
    const out = await build({
      entryPoints: [path.join(here, '../src/index.js')],
      bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
      alias: { crypto: path.join(here, '../src/node-crypto-shim.js') },
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
    });
    code = out.outputFiles[0].text;
  }, 120_000);

  beforeEach(() => {
    globalThis.indexedDB = fakeIndexedDB();
  });

  function plugin() {
    const ks = fakeKeystore([{ certificate: fixture('cert.pem'), key: fixture('key.pem') }]);
    const sent = [];
    const api = fakeApi({
      id: 'smime',
      translations: manifest.locales,
      hostFeatures: { keystore: true },
      handlers: {
        ...ks.handlers,
        'jmap.fetchBlob': async () => IMAGE,
        'jmap.sendRaw': async (bytes) => { sent.push(new Uint8Array(bytes)); },
        'ui.rerenderEmail': async () => {},
        'ui.setActions': async () => {},
      },
    });
    const mod = { exports: {} };
    const req = (name) => {
      if (name === '@plugin-host') return api;
      if (name === '@plugin-host/ui') return kit;
      if (name === 'react' || name === 'react/jsx-runtime' || name === 'react-dom') return require(name);
      throw new Error(`module ${name} is not available`);
    };
    new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
    return { sent, hooks: mod.exports.hooks };
  }

  const request = (attachments) => ({
    identityId: 'identity', fromEmail: FROM, to: ['someone@example.org'], subject: 'Hi', sign: true, encrypt: false,
    htmlBody: '<p><img src="cid:img1@bulwark"></p>', textBody: '', attachments,
  });
  // The header block of the attachment's part in the signed entity.
  const imagePart = (sent) => {
    const entity = new TextDecoder().decode(extractDetachedSigned(sent[0]).entityBytes);
    const part = entity.split(/\r\n------=_Part_[0-9a-f]+\r\n/).at(-1);
    return part.slice(0, part.indexOf('\r\n\r\n')).split('\r\n');
  };

  it('keeps the cid of an image the composer placed in the text', async () => {
    const { sent, hooks } = plugin();
    await expect(hooks.onComposeSend(request([
      { name: 'logo.png', type: 'image/png', size: IMAGE.length, blobId: 'blob-1', cid: 'img1@bulwark' },
    ]))).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    const head = imagePart(sent);
    expect(head).toContain('Content-ID: <img1@bulwark>');
    expect(head).toContain('Content-Disposition: inline; filename="logo.png"');
    expect(head).toContain('Content-Type: image/png; name="logo.png"');
  });

  it('takes a cid written with angle brackets too', async () => {
    const { sent, hooks } = plugin();
    await hooks.onComposeSend(request([{ name: 'logo.png', type: 'image/png', blobId: 'blob-1', cid: '<img1@bulwark>' }]));
    expect(imagePart(sent)).toContain('Content-ID: <img1@bulwark>');
  });

  // A forwarded attachment keeps the Content-ID it had in the message it came from. Only
  // what the new text shows is an image in the text.
  it('sends an attachment whose cid the text does not show as an ordinary attachment', async () => {
    const { sent, hooks } = plugin();
    await hooks.onComposeSend(request([
      { name: 'logo.png', type: 'image/png', blobId: 'blob-1', cid: 'img1@bulwark' },
      { name: 'report.pdf', type: 'application/pdf', blobId: 'blob-2', cid: 'part2@sender.example' },
    ]));
    const entity = new TextDecoder().decode(extractDetachedSigned(sent[0]).entityBytes);
    expect(entity).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(entity).not.toContain('part2@sender.example');
    expect(entity.match(/^Content-ID:/gim)).toHaveLength(1);
    expect(entity).toMatch(/^Content-Type: multipart\/mixed;/);
  });

  it('does not take a cid for shown when it only begins like one the text shows', async () => {
    const { sent, hooks } = plugin();
    await hooks.onComposeSend(request([{ name: 'a.png', type: 'image/png', blobId: 'blob-1', cid: 'img1' }]));
    expect(imagePart(sent).some((line) => /^Content-ID:/i.test(line))).toBe(false);
  });

  it.each([
    ['a line break', 'img1@bulwark\r\nX-Injected: yes'],
    ['a blank', 'img1@bulwark x'],
    ['an angle bracket', 'img1@bulwark>\r\nX-Injected: yes\r\nX: <'],
    ['a NUL', 'img1@bulwark\u0000'],
  ])('writes no Content-ID for a cid with %s in it', async (_, cid) => {
    const { sent, hooks } = plugin();
    const over = request([{ name: 'logo.png', type: 'image/png', blobId: 'blob-1', cid }]);
    // The text shows exactly that cid, as far as a cid: URL can hold it.
    over.htmlBody = `<p><img src="cid:${cid}"></p>`;
    await expect(hooks.onComposeSend(over)).resolves.toBe(false);
    // The header block of the image's part: nothing of the cid stands in it.
    const head = imagePart(sent);
    expect(head).toEqual([
      'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: attachment; filename="logo.png"',
      'Content-Transfer-Encoding: base64',
    ]);
  });

  it('sends an ordinary attachment without one', async () => {
    const { sent, hooks } = plugin();
    await hooks.onComposeSend(request([{ name: 'photo.png', type: 'image/png', blobId: 'blob-1', cid: undefined }]));
    const head = imagePart(sent);
    expect(head.some((line) => /^Content-ID:/i.test(line))).toBe(false);
    expect(head).toContain('Content-Disposition: attachment; filename="photo.png"');
  });
});
