// A mail with an ordinary body and an attachment whose name ends in .p7m (a signed PDF
// from an Italian PEC provider, or any file a sender names that way) is not an
// encrypted mail. The plugin must not put "Encrypted — couldn't be decrypted" above it.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';
import { fakeKeystore } from './helpers/fake-keystore.mjs';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { smimeSign } from '../src/smime-sign.js';
import { bannerRows } from '../src/ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));

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

function plugin(blob) {
  const ks = fakeKeystore([{ certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() }]);
  const api = fakeApi({
    id: 'smime', translations: manifest.locales, hostFeatures: { keystore: true },
    handlers: { ...ks.handlers, 'jmap.fetchBlob': async () => blob, 'ui.rerenderEmail': async () => {}, 'ui.setActions': async () => {} },
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === '@plugin-host') return api;
    if (id === '@plugin-host/ui') return kit;
    return require(id);
  });
  return { api, ...mod.exports };
}

/** CMS SignedData around a document, signed with a throwaway certificate. */
async function signedDocument(content = '%PDF-1.7 the contract') {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: 1 });
  const cn = [new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'Notary' }) })];
  cert.issuer.typesAndValues.push(...cn);
  cert.subject.typesAndValues.push(...cn);
  cert.notBefore.value = new Date(Date.now() - 86_400_000);
  cert.notAfter.value = new Date(Date.now() + 86_400_000);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, 'SHA-256');
  const der = new Uint8Array(cert.toSchema(true).toBER(false));
  const blob = await smimeSign(new TextEncoder().encode(content), keys.privateKey, der);
  return new Uint8Array(await blob.arrayBuffer());
}

// What the webmail hands the hook for a multipart/mixed mail: text body plus one attachment.
const mailWith = (attachment) => ({
  id: 'mail-1',
  contentType: 'multipart/mixed; boundary="b"',
  blobId: 'raw-mail',
  from: [{ email: 'sender@example.org' }],
  bodyStructure: {
    type: 'multipart/mixed',
    subParts: [
      { type: 'text/plain', partId: '1', blobId: 'body-blob' },
      { ...attachment, partId: '2' },
    ],
  },
  attachments: [attachment],
});

async function banner(api) {
  const status = await api.storage.get('verify:mail-1');
  return status ? bannerRows(status, { t: (k, v) => api.i18n.t(k, v) }) : [];
}

describe('an attachment named .p7m on an ordinary mail', () => {
  it('leaves the body alone when the file is a signed document (CAdES, what PEC providers send)', async () => {
    // A CMS SignedData file, as "contract.pdf.p7m" is.
    const signedFile = await signedDocument();
    const { api, hooks } = plugin(signedFile);
    const result = await hooks.onRenderEmailBody(
      { html: '<p>Please find the signed contract attached.</p>', text: 'Please find the signed contract attached.' },
      mailWith({ type: 'application/octet-stream', name: 'contract.pdf.p7m', blobId: 'att-blob', size: signedFile.length }),
    );
    // Not S/MIME mail: the hook stays out of it, and no bar claims a failed decryption.
    expect(result?.verification?.isEncrypted).not.toBe(true);
    expect((await banner(api)).filter((row) => row.tone === 'danger' || row.tone === 'destructive')).toEqual([]);
  });

  it('leaves the body alone when the file is anything else', async () => {
    const { api, hooks } = plugin(new TextEncoder().encode('just some bytes, not CMS at all'));
    const result = await hooks.onRenderEmailBody(
      { html: '<p>Hello</p>', text: 'Hello' },
      mailWith({ type: 'application/octet-stream', name: 'notes.p7m', blobId: 'att-blob', size: 31 }),
    );
    expect(result?.verification?.isEncrypted).not.toBe(true);
    expect((await banner(api)).filter((row) => row.tone === 'danger' || row.tone === 'destructive')).toEqual([]);
  });
});

describe('what makes a mail S/MIME mail', () => {
  const PLAINTEXT = 'Hello from the S/MIME test fixture.';
  const bytes = (text) => Uint8Array.from(Buffer.from(text, 'latin1'));

  it('leaves an ordinary mail with a .p7s attachment alone', async () => {
    const raw = 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nHello\r\n'
      + '--b\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Disposition: attachment; filename="smime.p7s"\r\n'
      + 'Content-Transfer-Encoding: base64\r\n\r\nMAA=\r\n--b--\r\n';
    const { api, hooks } = plugin(bytes(raw));
    const result = await hooks.onRenderEmailBody(
      { html: '<p>Hello</p>', text: 'Hello' },
      mailWith({ type: 'application/pkcs7-signature', name: 'smime.p7s', blobId: 'att-blob', size: 2 }),
    );
    expect(result).toBeUndefined();
    expect(await banner(api)).toEqual([]);
  });

  // Some older clients send a mail as one application/pkcs7-mime part named smime.p7m,
  // without the smime-type parameter. Its top-level type alone makes it S/MIME.
  const withoutSmimeType = () => ({
    id: 'mail-1',
    contentType: 'application/pkcs7-mime; name="smime.p7m"',
    blobId: 'raw-mail',
    from: [{ email: 'sender@example.org' }],
    bodyStructure: { type: 'application/pkcs7-mime', name: 'smime.p7m', partId: '1' },
    attachments: [{ type: 'application/pkcs7-mime', name: 'smime.p7m', partId: '1' }],
  });

  it('decrypts such a mail when it is encrypted (control)', async () => {
    const message = fixture('cbc.p7m').toString('latin1').replace('; smime-type=enveloped-data', '');
    expect(message).not.toContain('smime-type');
    const { hooks } = plugin(bytes(message));
    const result = await hooks.onRenderEmailBody({ html: '', text: '' }, withoutSmimeType());
    expect(result.text).toContain(PLAINTEXT);
    expect(result.verification).toMatchObject({ isEncrypted: true, decryptionSuccess: true });
  });

  it('verifies such a mail when the CMS inside is signed data', async () => {
    const cms = await signedDocument('Content-Type: text/plain; charset=utf-8\r\n\r\nSigned, without an smime-type.\r\n');
    const message = 'MIME-Version: 1.0\r\nContent-Type: application/pkcs7-mime; name="smime.p7m"\r\nContent-Transfer-Encoding: base64\r\n\r\n'
      + `${Buffer.from(cms).toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n`;
    const { hooks } = plugin(bytes(message));
    const result = await hooks.onRenderEmailBody({ html: '', text: '' }, withoutSmimeType());
    expect(result.text).toContain('Signed, without an smime-type.');
    expect(result.verification.isEncrypted).not.toBe(true);
    expect(result.verification).toMatchObject({ isSigned: true, cryptoValid: true });
  });
});
