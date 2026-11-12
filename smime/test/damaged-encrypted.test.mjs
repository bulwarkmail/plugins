// An encrypted mail the plugin doesn't open because its structure can't be relied on (its header reads
// more than one way, or the server reads the message as something else) says it is damaged. "Couldn't
// be decrypted with your keys" would send the reader looking for a key, and no key would help.
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
import { bannerRows } from '../src/ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const en = manifest.locales.en;
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));
const enc = new TextEncoder();
const pemDer = (pem) => new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64'));

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

beforeEach(() => { globalThis.indexedDB = fakeIndexedDB(); });

function plugin(raw) {
  const ks = fakeKeystore([{ certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() }]);
  const api = fakeApi({
    id: 'smime', translations: manifest.locales, hostFeatures: { keystore: true },
    handlers: { ...ks.handlers, 'jmap.fetchBlob': async () => enc.encode(raw), 'ui.rerenderEmail': async () => {}, 'ui.setActions': async () => {} },
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === '@plugin-host') return api;
    if (id === '@plugin-host/ui') return kit;
    return require(id);
  });
  return { api, ...mod.exports };
}

const CT = 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"';
const leaf = { partId: '0', type: 'application/pkcs7-mime', name: 'smime.p7m' };

async function open(raw, view, contentType = CT) {
  const { api, hooks } = plugin(raw);
  const result = await hooks.onRenderEmailBody({ html: '', text: '' }, {
    id: 'mail-1', blobId: 'raw', from: [{ email: 'a@example.org' }], contentType, ...view,
  });
  const status = await api.storage.get('verify:mail-1');
  return { result, rows: bannerRows(status, { t: (k, v) => api.i18n.t(k, v) }).map(({ icon, tone, text }) => ({ icon, tone, text })) };
}

const damaged = [{ icon: 'lock', tone: 'destructive', text: en['banner.encryptedDamaged'] }];
const cbc = () => fixture('cbc.p7m').toString('latin1');

describe('an encrypted mail the plugin does not open', () => {
  it('says it is damaged when its header has a second Content-Type field', async () => {
    const raw = cbc().replace('Content-Transfer-Encoding: base64', 'Content - Type: text/html\r\nContent-Transfer-Encoding: base64');
    const o = await open(raw, { bodyStructure: leaf, attachments: [leaf] });
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual(damaged);
  });

  it('says it is damaged when the server reads it as something else', async () => {
    const invoice = { partId: '1', type: 'text/html', name: 'invoice.html' };
    const o = await open(cbc(), { bodyStructure: { type: 'multipart/mixed', subParts: [invoice, { ...leaf, partId: '2' }] }, attachments: [invoice] });
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual(damaged);
  });

  it('says it is damaged when the server sizes its part as another body', async () => {
    const der = pemDer(cbc().split(/\r?\n\r?\n/).slice(1).join(''));
    const o = await open(cbc(), { bodyStructure: { ...leaf, size: der.length + 2 }, attachments: [{ ...leaf, size: der.length + 2 }] });
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual(damaged);
  });

  it('says it is damaged without an smime-type parameter too', async () => {
    const raw = cbc().replace('; smime-type=enveloped-data', '').replace('Content-Transfer-Encoding: base64', 'Content - Type: text/html\r\nContent-Transfer-Encoding: base64');
    const o = await open(raw, { bodyStructure: leaf, attachments: [leaf] }, 'application/pkcs7-mime; name="smime.p7m"');
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual(damaged);
  });

  it('still says it could not be decrypted when no key fits (control)', async () => {
    const o = await open(fixture('ec-p256.p7m').toString('latin1'), { bodyStructure: leaf, attachments: [leaf] });
    expect(o.rows).toEqual([{ icon: 'lock', tone: 'destructive', text: en['banner.undecryptable'] }]);
  });
});
