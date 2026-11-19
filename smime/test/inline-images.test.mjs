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
import { extractDetachedSigned } from '../src/mime-parse.js';

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

  it('sends an ordinary attachment without one', async () => {
    const { sent, hooks } = plugin();
    await hooks.onComposeSend(request([{ name: 'photo.png', type: 'image/png', blobId: 'blob-1', cid: undefined }]));
    const head = imagePart(sent);
    expect(head.some((line) => /^Content-ID:/i.test(line))).toBe(false);
    expect(head).toContain('Content-Disposition: attachment; filename="photo.png"');
  });
});
