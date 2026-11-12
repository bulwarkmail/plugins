// Honest mail whose header block the plugin relies on, written by senders and servers that mix line
// breaks or put raw UTF-8 into a file name. It verifies or decrypts.
// The server views are mail-parser 0.11.9's reading of these bytes (a local build of the crate).
//
// - Stalwart's own encryption at rest copies the original header lines as they are and appends its
//   Content-Type block with CRLF (crates/email/src/message/crypto.rs). A message that arrived with LF
//   (IMAP or JMAP append with encryption on append, the webmail's mbox import keeps line endings) gets a
//   header block with both kinds of line break.
// - A gateway that adds LF-only header lines on top of a CRLF mail.
// - A raw UTF-8 file name in `name=` of a Content-Type the plugin checks.
//
// Mixed CRLF/LF breaks and 8-bit bytes in parameters other than boundary, protocol and smime-type read
// the same in mail-parser and in the plugin; lone CR, NUL and blank-only lines are what differ.
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
import { trustSigner } from './helpers/trusted-signer.mjs';
import { smimeSign, smimeSignDetached } from '../src/smime-sign.js';
import { bannerRows } from '../src/ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));
const SIGNER = 'ceo@victim.example';
const latin1 = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
const utf8AsLatin1 = (s) => Buffer.from(s, 'utf8').toString('latin1');
const b64 = (bytes) => Buffer.from(bytes).toString('base64').match(/.{1,76}/g).join('\r\n');
const pemDer = (pem) => new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64'));

let code;
let signer;
beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(here, '../src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    alias: { crypto: path.join(here, '../src/node-crypto-shim.js') },
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  });
  code = out.outputFiles[0].text;
  const alg = { name: 'ECDSA', namedCurve: 'P-256' };
  const ca = await crypto.subtle.generateKey(alg, false, ['sign', 'verify']);
  const leaf = await crypto.subtle.generateKey(alg, false, ['sign', 'verify']);
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: 14 });
  cert.issuer.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'Some CA' }) }));
  cert.subject.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'The CEO' }) }));
  cert.notBefore.value = new Date(Date.now() - 86_400_000);
  cert.notAfter.value = new Date(Date.now() + 86_400_000);
  cert.extensions = [new pkijs.Extension({
    extnID: '2.5.29.17',
    extnValue: new pkijs.GeneralNames({ names: [new pkijs.GeneralName({ type: 1, value: SIGNER })] }).toSchema().toBER(false),
  })];
  await cert.subjectPublicKeyInfo.importKey(leaf.publicKey);
  await cert.sign(ca.privateKey, 'SHA-256');
  signer = { key: leaf.privateKey, cert: new Uint8Array(cert.toSchema(true).toBER(false)) };
}, 120_000);

// The user trusts the signer's certificate, so these honest mails show the trusted verdict.
beforeEach(async () => { globalThis.indexedDB = fakeIndexedDB(); await trustSigner(signer.cert); });

function plugin(raw) {
  const ks = fakeKeystore([{ certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() }]);
  const api = fakeApi({
    id: 'smime', translations: manifest.locales, hostFeatures: { keystore: true },
    handlers: { ...ks.handlers, 'jmap.fetchBlob': async () => latin1(raw), 'ui.rerenderEmail': async () => {}, 'ui.setActions': async () => {} },
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === '@plugin-host') return api;
    if (id === '@plugin-host/ui') return kit;
    return require(id);
  });
  return { api, ...mod.exports };
}

async function open(raw, contentType, view) {
  const { api, hooks } = plugin(raw);
  const result = await hooks.onRenderEmailBody({ html: '', text: '' }, { id: 'mail-1', blobId: 'raw', from: [{ email: SIGNER }], contentType, ...view });
  const status = await api.storage.get('verify:mail-1');
  return { result, rows: status ? bannerRows(status, { t: (k, v) => api.i18n.t(k, v) }).map((r) => `${r.tone}: ${r.text}`) : [] };
}

const lf = (s) => s.replace(/\r\n/g, '\n');
const transport = 'Return-Path: <ceo@victim.example>\r\nReceived: from mx.victim.example\r\n\tby mail.victim.example; Tue, 12 Nov 2026 10:00:00 +0100\r\n';
const basics = `From: The CEO <${SIGNER}>\r\nTo: me@victim.example\r\nSubject: Quarterly report\r\nMIME-Version: 1.0\r\n`;
const sigView = (first) => ({
  bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [first, { partId: '2', type: 'application/pkcs7-signature', name: 'smime.p7s' }] },
  attachments: [...(first.name ? [first] : []), { partId: '2', type: 'application/pkcs7-signature', name: 'smime.p7s' }],
});
const SIGNED_CT = 'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="inner"';
async function detached(entity) {
  const sig = b64(await smimeSignDetached(latin1(entity), signer.key, signer.cert));
  return `--inner\r\n${entity}\r\n--inner\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Transfer-Encoding: base64\r\n\r\n${sig}\r\n--inner--\r\n`;
}

describe('honest mail the header rule should not refuse', () => {
  it('Stalwart encryption at rest of a message that arrived with LF line breaks: decrypted', async () => {
    const der = pemDer(fixture('cbc.p7m').toString('latin1').split(/\r?\n\r?\n/).slice(1).join(''));
    const raw = `${lf(transport)}${lf(basics)}Content-Type: application/pkcs7-mime;\r\n\tname="smime.p7m";\r\n\tsmime-type=enveloped-data\r\n`
      + `Content-Disposition: attachment;\r\n\tfilename="smime.p7m"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(der)}\r\n`;
    const leaf = { partId: '0', type: 'application/pkcs7-mime', name: 'smime.p7m' };
    const o = await open(raw, ' application/pkcs7-mime;\r\n\tname="smime.p7m";\r\n\tsmime-type=enveloped-data', { bodyStructure: leaf, attachments: [leaf] });
    expect(o.result?.text ?? '(not taken over)').toContain('Hello from the S/MIME test fixture.');
  });

  it('a gateway added LF-only header lines on top of a CRLF signed mail: verified', async () => {
    const entity = 'Content-Type: text/plain; charset=utf-8\r\n\r\nHi, the report.';
    const raw = `X-Virus-Scanned: clean\nX-Gateway: av\n${transport}${basics}Content-Type: ${SIGNED_CT}\r\n\r\n${await detached(entity)}`;
    const o = await open(raw, ` ${SIGNED_CT}`, sigView({ partId: '1', type: 'text/plain' }));
    expect(o.result?.text ?? '(not taken over)').toContain('Hi, the report.');
    expect(o.rows.some((r) => r.startsWith('success:'))).toBe(true);
  });

  it('opaque signed with a raw UTF-8 file name in name=: verified', async () => {
    const cms = new Uint8Array(await (await smimeSign(latin1('Content-Type: text/plain\r\n\r\nOpaque.\r\n'), signer.key, signer.cert)).arrayBuffer());
    const name = `Signierte Nachricht ${utf8AsLatin1('ü')}.p7m`;
    const ct = `application/pkcs7-mime; smime-type=signed-data; name="${name}"`;
    const raw = `${transport}${basics}Content-Type: ${ct}\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(cms)}\r\n`;
    const leaf = { partId: '0', type: 'application/pkcs7-mime', name: 'Signierte Nachricht ü.p7m' };
    const o = await open(raw, ` ${ct}`, { bodyStructure: leaf, attachments: [leaf] });
    expect(o.result?.text ?? '(not taken over)').toContain('Opaque.');
  });

  it('a signed entity that is one attachment with a raw UTF-8 name: verified', async () => {
    const entity = `Content-Type: application/pdf; name="Bericht M${utf8AsLatin1('ä')}rz.pdf"\r\nContent-Disposition: attachment\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjcK`;
    const raw = `${transport}${basics}Content-Type: ${SIGNED_CT}\r\n\r\n${await detached(entity)}`;
    const o = await open(raw, ` ${SIGNED_CT}`, sigView({ partId: '1', type: 'application/pdf', name: 'Bericht März.pdf' }));
    expect(o.result?.handledBy).toBe('smime');
    expect(o.rows.some((r) => r.startsWith('success:'))).toBe(true);
  });
});
