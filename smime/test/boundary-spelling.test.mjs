// The rule "the boundary appears only on the plugin's delimiter lines" holds only if both readers take
// the same string for the boundary. mail-parser decodes the parameter value before it scans: it drops
// comments, undoes quoted pairs, ignores what follows the closing quote, and decodes RFC 2047 encoded
// words. The plugin keeps the value as written. So with `boundary="\B"` the plugin would split at `--\B`
// lines and look for no other string, while the server splits at every `--B`, and a copy of the signed
// part's tree (another event in a signed invitation) delimited by `--B` before the signer's parts would
// be what the server reads. The plugin relies only on a boundary written plainly: a bare token, or a
// quoted string of RFC 2046 boundary characters with nothing around the quotes, no backslash, no =? and
// no parentheses or blanks outside the quotes. Anything else reads as a damaged message, also for a
// multipart inside the signed entity.
//
// The server views in the first block are mail-parser 0.11.9's reading of these bytes (a local build of
// the crate prints the boundary it reads).
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
import { smimeSignDetached } from '../src/smime-sign.js';
import { bannerRows } from '../src/ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const en = manifest.locales.en;
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));
const enc = new TextEncoder();
const SIGNER = 'ceo@victim.example';
const b64 = (bytes) => Buffer.from(bytes).toString('base64').match(/.{1,76}/g).join('\r\n');

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
  cert.serialNumber = new asn1js.Integer({ value: 15 });
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

const head = `From: The CEO <${SIGNER}>\r\nTo: me@victim.example\r\nSubject: Planning\r\nMIME-Version: 1.0\r\n`;
const invite = (summary, loc) => 'Content-Type: multipart/alternative; boundary="M"\r\n\r\n'
  + '--M\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee the invitation.\r\n'
  + `--M\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:7@victim.example\r\nSUMMARY:${summary}\r\nLOCATION:${loc}\r\nDTSTART:20261120T100000Z\r\nORGANIZER:mailto:ceo@victim.example\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n--M--`;
const sigHeaders = 'Content-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
const ctOf = (param) => `multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; ${param}`;

// mail-parser 0.11.9's reading of every mail below (and of the control): the invitation's tree.
const view = {
  bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [
    { partId: '1', type: 'multipart/alternative', subParts: [{ partId: '2', type: 'text/plain', size: 19 }, { partId: '3', type: 'text/calendar', size: 182 }] },
    { partId: '4', type: 'application/pkcs7-signature', name: 'smime.p7s' }] },
  attachments: [{ partId: '3', type: 'text/calendar', name: '' }, { partId: '4', type: 'application/pkcs7-signature', name: 'smime.p7s' }],
};

async function open(raw, param) {
  const { api, hooks } = plugin(raw);
  const result = await hooks.onRenderEmailBody({ html: '', text: '' }, {
    id: 'mail-1', blobId: 'raw', from: [{ email: SIGNER }], contentType: ` ${ctOf(param)}`, ...view,
  });
  const status = await api.storage.get('verify:mail-1');
  const rows = status ? bannerRows(status, { t: (k, v) => api.i18n.t(k, v) }) : [];
  return { result, rows: rows.map(({ icon, tone, text }) => ({ icon, tone, text })), success: rows.filter((r) => r.tone === 'success') };
}

describe('the boundary both readers split at', () => {
  it('a signed invitation verifies (control)', async () => {
    const entity = invite('Quarterly planning', 'Room 4');
    const sig = b64(await smimeSignDetached(enc.encode(entity), signer.key, signer.cert));
    const raw = `${head}Content-Type: ${ctOf('boundary="B"')}\r\n\r\n--B\r\n${entity}\r\n--B\r\n${sigHeaders}${sig}\r\n--B--\r\n`;
    const o = await open(raw, 'boundary="B"');
    expect(o.result?.handledBy).toBe('smime');
    expect(o.success).toHaveLength(1);
  });

  // [label, parameter as written, what mail-parser reads, what the plugin reads]
  it.each([
    ['a quoted pair in a quoted boundary', 'boundary="\\B"', 'B', '\\B'],
    ['a backslash in an unquoted boundary', 'boundary=\\B', 'B', '\\B'],
    ['a comment before the boundary', 'boundary=(c)B', 'B', '(c)B'],
    ['a comment after the boundary', 'boundary=B(c)', 'B', 'B(c)'],
    ['text after the closing quote', 'boundary="B"x', 'B', '"B"x'],
    ['an RFC 2047 encoded word', 'boundary="=?utf-8?q?B?="', 'B', '=?utf-8?q?B?='],
    ['a quoted pair inside the boundary', 'boundary="B\\C"', 'BC', 'B\\C'],
  ])('not with %s', async (_, param, server, mine) => {
    const entity = invite('Quarterly planning', 'Room 4');
    const sig = b64(await smimeSignDetached(enc.encode(entity), signer.key, signer.cert));
    const raw = `${head}Content-Type: ${ctOf(param)}\r\n\r\n`
      + `--${server}\r\n${invite('Payment approval', 'https://pay.example/meet')}\r\n--${server}\r\n${sigHeaders}MAA=\r\n--${server}--\r\n`
      + `--${mine}\r\n${entity}\r\n--${mine}\r\n${sigHeaders}${sig}\r\n--${mine}--\r\n`;
    const o = await open(raw, param);
    expect(o.result?.handledBy).toBeUndefined();
    expect(o.success).toEqual([]);
  });
});

// Below, each mail is delimited the way the plugin reads its boundary, and the server view is the
// plugin's own reading, so only the spelling of the boundary decides.
describe('a boundary the plugin relies on is written plainly', () => {
  const damaged = [{ icon: 'shield-exclamation', tone: 'destructive', text: en['banner.invalid'].replace('{error}', en['error.malformedSigned']) }];
  // The value as this plugin reads it: trimmed, outer quotes removed.
  const asRead = (value) => (value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value);
  const LONGEST = 'x'.repeat(70);

  /** A signed invitation whose top-level boundary is `outer` and whose multipart/alternative has `inner`, both as written. */
  async function signedInvitation(outer, inner = '"M"') {
    const top = asRead(outer);
    const alt = asRead(inner);
    const entity = `Content-Type: multipart/alternative; boundary=${inner}\r\n\r\n`
      + `--${alt}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee the invitation.\r\n`
      + `--${alt}\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:7@victim.example\r\nSUMMARY:Quarterly planning\r\nLOCATION:Room 4\r\nDTSTART:20261120T100000Z\r\nORGANIZER:mailto:ceo@victim.example\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n--${alt}--`;
    const sig = b64(await smimeSignDetached(enc.encode(entity), signer.key, signer.cert));
    return `${head}Content-Type: ${ctOf(`boundary=${outer}`)}\r\n\r\n--${top}\r\n${entity}\r\n--${top}\r\n${sigHeaders}${sig}\r\n--${top}--\r\n`;
  }

  // [label, boundary as written]
  const refused = [
    ['a quoted pair', '"\\B"'],
    ['a backslash, unquoted', '\\B'],
    ['a comment before it', '(c)B'],
    ['a comment after it', 'B(c)'],
    ['a comment after a blank', 'B (c)'],
    ['text after the closing quote', '"B"x'],
    ['text before the opening quote', 'x"B"'],
    ['a quoted pair inside it', '"B\\C"'],
    ['an RFC 2047 encoded word in quotes', '"=?utf-8?q?B?="'],
    ['an RFC 2047 encoded word, unquoted', '=?utf-8?q?B?='],
    ['an RFC 2047 encoded word in base64', '"=?utf-8?b?Qg==?="'],
    ['a blank, unquoted', 'a b'],
    ['a blank at the end', '"B "'],
    ['71 characters', `${LONGEST}x`],
  ];

  it.each(refused)('refuses a message boundary with %s', async (_, outer) => {
    const param = `boundary=${outer}`;
    const o = await open(await signedInvitation(outer), param);
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual(damaged);
  });

  it.each(refused)('refuses a boundary inside the signed entity with %s', async (_, inner) => {
    const o = await open(await signedInvitation('T', inner), 'boundary=T');
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual(damaged);
  });

  it.each([
    ['a blank inside the quotes', '"a b"'],
    ['parentheses inside the quotes', '"(a)b"'],
    ['the longest boundary, 70 characters', LONGEST],
    ['the characters of a common client', '"----=_NextPart_000_0001_01DB0000.12345678"'],
    ['every other boundary character, unquoted', "a'+_,-./:?=b"],
  ])('still verifies a boundary with %s, at the top and inside the signed entity (control)', async (_, spelling) => {
    for (const [outer, inner] of [[spelling, '"M"'], ['T', spelling]]) {
      const o = await open(await signedInvitation(outer, inner), `boundary=${outer}`);
      expect(o.result?.handledBy, `${outer} / ${inner}`).toBe('smime');
      expect(o.success).toHaveLength(1);
    }
  });
});
