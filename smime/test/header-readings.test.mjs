// A mail signed as a whole is one whose top-level entity is multipart/signed with exactly the signed
// part and the signature. The plugin reads that from the raw message, the server (Stalwart, mail-parser)
// reads the same headers its own way, and the webmail lists the server's attachments whenever the
// plugin returns none. Where the two readings of the top-level Content-Type can differ, the plugin must
// not vouch for the mail: otherwise the reader shows the signed text, a valid signature, and attachments
// only the server sees.
//
// mail-parser 0.11.9 (Stalwart 1.0): the LAST Content-Type header builds the structure, the FIRST
// boundary parameter wins, and blanks inside a header name are dropped ("Content - Type" is
// Content-Type). The webmail hands the hook the FIRST Content-Type header. The plugin's MIME reader
// takes the media type of the first header and the last value of each parameter. So the plugin relies
// only on a header block that reads one way, and on a server view that agrees with it.
//
// A header that says opaque signed data over content that can't be verified gets a verdict too, so the
// reader bar doesn't keep its guess from the header, "Signed message", above whatever the webmail shows.
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
import { smimeSign, smimeSignDetached } from '../src/smime-sign.js';
import { bannerRows } from '../src/ui.js';
import { detectSmime } from '../src/smime-detect.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const en = manifest.locales.en;
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));
const enc = new TextEncoder();
const SIGNER = 'ceo@victim.example';
const SIGNED_TEXT = 'Please see the attached document';
const ENTITY = `Content-Type: text/plain; charset=utf-8\r\n\r\n${SIGNED_TEXT}. Regards, the CEO`;
const b64 = (bytes) => Buffer.from(bytes).toString('base64').match(/.{1,76}/g).join('\r\n');

let code;
let sigB64;
let signer; // the signer's key and certificate, for the other shapes below
beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(here, '../src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    alias: { crypto: path.join(here, '../src/node-crypto-shim.js') },
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  });
  code = out.outputFiles[0].text;
  // A throwaway certificate for the signer; who issued it is not the point here.
  const alg = { name: 'ECDSA', namedCurve: 'P-256' };
  const ca = await crypto.subtle.generateKey(alg, false, ['sign', 'verify']);
  const leaf = await crypto.subtle.generateKey(alg, false, ['sign', 'verify']);
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: 9 });
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
  sigB64 = b64(await smimeSignDetached(enc.encode(ENTITY), signer.key, signer.cert));
}, 120_000);

beforeEach(() => { globalThis.indexedDB = fakeIndexedDB(); });

const SIGNED_CT = 'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="inner"';
const signedBody = () => `--inner\r\n${ENTITY}\r\n--inner\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\n`
  + `Content-Transfer-Encoding: base64\r\n\r\n${sigB64}\r\n--inner--\r\n`;
const signedTree = { type: 'multipart/signed', subParts: [{ type: 'text/plain', partId: '1' }, { type: 'application/pkcs7-signature', partId: '2' }] };
const head = `From: The CEO <${SIGNER}>\r\nTo: me@victim.example\r\nSubject: Invoice\r\nMIME-Version: 1.0\r\n`;
const invoicePart = (boundary) => `--${boundary}\r\nContent-Type: text/html; name="invoice.html"\r\nContent-Disposition: attachment; filename="invoice.html"\r\n\r\n`
  + '<form action="https://pay.example/">Your password</form>\r\n';
const invoice = { type: 'text/html', name: 'invoice.html', blobId: 'att', size: 60, partId: '1' };
// What the server sees in cases 1-3: a multipart (split at "Y") of invoice.html and a text part that holds
// the signed parts as text.
const serverView = (rootType) => ({ type: rootType, subParts: [invoice, { type: 'text/plain', partId: '2' }] });
const bodyY = () => `${invoicePart('Y')}--Y\r\nContent-Type: text/plain\r\n\r\n${signedBody()}--Y--\r\n`;

function plugin(raw, blobs = {}, handlers = {}) {
  const ks = fakeKeystore([{ certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() }]);
  const api = fakeApi({
    id: 'smime', translations: manifest.locales, hostFeatures: { keystore: true },
    handlers: {
      ...ks.handlers, 'jmap.fetchBlob': async (id) => blobs[id] ?? enc.encode(raw), 'ui.rerenderEmail': async () => {}, 'ui.setActions': async () => {}, ...handlers,
    },
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === '@plugin-host') return api;
    if (id === '@plugin-host/ui') return kit;
    return require(id);
  });
  return { api, ...mod.exports };
}

// The reader bar: the stored verdict, or while none is stored the banner's guess from the first
// Content-Type header (EmailBanner in ui.js).
function bar(status, headerCt, t) {
  let shown = status;
  if (!shown) {
    const det = detectSmime(headerCt);
    shown = det.type === 'enveloped-data' ? { isEncrypted: true }
      : det.type === 'signed-data' || det.type === 'detached-sig' ? { isSigned: true } : null;
  }
  return shown ? bannerRows(shown, { t }).map(({ icon, tone, text }) => ({ icon, tone, text })) : [];
}

async function open(raw, ctx, blobs) {
  const { api, hooks } = plugin(raw, blobs);
  const result = await hooks.onRenderEmailBody({ html: '', text: '' }, { id: 'mail-1', blobId: 'raw', from: [{ email: SIGNER }], ...ctx });
  const status = await api.storage.get('verify:mail-1');
  return { result, status, rows: bar(status, ctx.contentType, (k, v) => api.i18n.t(k, v)) };
}
const takenOver = (r) => !!r && `${r.text ?? ''}${r.html ?? ''}`.includes(SIGNED_TEXT);
const success = (rows) => rows.filter((r) => r.tone === 'success');

describe('a top-level Content-Type the server may read differently', () => {
  it('a mail signed as a whole is still verified (control)', async () => {
    const o = await open(`${head}Content-Type: ${SIGNED_CT}\r\n\r\n${signedBody()}`, { contentType: SIGNED_CT, bodyStructure: signedTree, attachments: [] });
    expect(takenOver(o.result)).toBe(true);
    expect(success(o.rows)).toHaveLength(1);
  });

  it('1. the boundary parameter given twice', async () => {
    const ct = 'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="Y"; boundary="inner"';
    const o = await open(`${head}Content-Type: ${ct}\r\n\r\n${bodyY()}`, { contentType: ct, bodyStructure: serverView('multipart/signed'), attachments: [invoice] });
    expect(takenOver(o.result)).toBe(false);
    expect(success(o.rows)).toEqual([]);
  });

  it('2. two Content-Type headers', async () => {
    const raw = `${head}Content-Type: ${SIGNED_CT}\r\nContent-Type: multipart/mixed; boundary="Y"; boundary="inner"\r\n\r\n${bodyY()}`;
    const o = await open(raw, { contentType: SIGNED_CT, bodyStructure: serverView('multipart/mixed'), attachments: [invoice] });
    expect(takenOver(o.result)).toBe(false);
    expect(success(o.rows)).toEqual([]);
  });

  it('3. a second Content-Type header spelled with blanks in its name', async () => {
    const raw = `${head}Content-Type: ${SIGNED_CT}\r\nContent - Type: multipart/mixed; boundary="Y"\r\n\r\n${bodyY()}`;
    const o = await open(raw, { contentType: SIGNED_CT, bodyStructure: serverView('multipart/mixed'), attachments: [invoice] });
    expect(takenOver(o.result)).toBe(false);
    expect(success(o.rows)).toEqual([]);
  });
});

describe('a header that says signed data over content that is none', () => {
  const ct = 'application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"';
  const pemDer = (pem) => new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64'));

  it('4. encrypted data under a signed-data header: a verdict is stored, the bar does not say "Signed message"', async () => {
    const der = pemDer(fixture('cbc.p7m').toString('latin1').split(/\r?\n\r?\n/).slice(1).join(''));
    const o = await open(`${head}Content-Type: ${ct}\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(der)}\r\n`,
      { contentType: ct, bodyStructure: { type: 'application/pkcs7-mime', blobId: 'p7m', partId: '1' }, attachments: [] }, { p7m: der });
    expect(o.status).toBeTruthy();
    expect(o.rows).not.toContainEqual(expect.objectContaining({ text: en['banner.signed'] }));
  });

  it('leaves no verdict when the message could not be fetched (control)', async () => {
    const { api, hooks } = plugin('', {}, { 'jmap.fetchBlob': async () => { throw new Error('offline'); } });
    const ctx = { id: 'mail-1', blobId: 'raw', from: [{ email: SIGNER }], contentType: ct, bodyStructure: { type: 'application/pkcs7-mime', partId: '1' }, attachments: [] };
    expect(await hooks.onRenderEmailBody({ html: '', text: '' }, ctx)).toBeUndefined();
    expect(await api.storage.get('verify:mail-1')).toBeNull();
  });

  it('5. a second Content-Type header the server reads as text/html: a verdict is stored, the bar does not say "Signed message"', async () => {
    const raw = `${head}Content-Type: ${ct}\r\nContent-Type: text/html\r\n\r\n<h1>New bank details</h1><p>IBAN XX00</p>\r\n`;
    const o = await open(raw, { contentType: ct, bodyStructure: { type: 'text/html', blobId: 'html', partId: '1' }, attachments: [] });
    expect(o.status).toBeTruthy();
    expect(o.rows).not.toContainEqual(expect.objectContaining({ text: en['banner.signed'] }));
  });
});

describe('a top-level multipart/signed whose header names no pkcs7 protocol', () => {
  const damaged = { icon: 'shield-exclamation', tone: 'destructive', text: en['banner.invalid'].replace('{error}', en['error.malformedSigned']) };

  it.each([
    ['no protocol', 'multipart/signed; micalg=sha-256; boundary="inner"'],
    ['another protocol', 'multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256; boundary="inner"'],
  ])('reads as a damaged signed message with %s, not as partly signed', async (_, ct) => {
    const o = await open(`${head}Content-Type: ${ct}\r\n\r\n${signedBody()}`, { contentType: ct, bodyStructure: signedTree, attachments: [] });
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  it('leaves a PGP/MIME signed mail alone (control)', async () => {
    const ct = 'multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256; boundary="inner"';
    const raw = `${head}Content-Type: ${ct}\r\n\r\n--inner\r\n${ENTITY}\r\n--inner\r\nContent-Type: application/pgp-signature\r\n\r\n`
      + '-----BEGIN PGP SIGNATURE-----\r\nAAAA\r\n-----END PGP SIGNATURE-----\r\n--inner--\r\n';
    const tree = { type: 'multipart/signed', subParts: [{ type: 'text/plain', partId: '1' }, { type: 'application/pgp-signature', partId: '2' }] };
    const o = await open(raw, { contentType: ct, bodyStructure: tree, attachments: [] });
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([]);
  });
});

describe('a header block the plugin relies on reads one way', () => {
  const damaged = { icon: 'shield-exclamation', tone: 'destructive', text: en['banner.invalid'].replace('{error}', en['error.malformedSigned']) };
  // The server reads the mail as signed as a whole here, so only the raw header decides.
  const agreeing = { contentType: SIGNED_CT, bodyStructure: signedTree, attachments: [] };
  const withHeader = (lines, body = signedBody()) => `${head}${lines}\r\n\r\n${body}`;
  // A reader that joins the fields and lets the last parameter win still finds "inner" here.
  const mixedY = 'multipart/mixed; boundary="Y"; boundary="inner"';

  it.each([
    ['the Content-Type field twice with the same value', `Content-Type: ${SIGNED_CT}\r\nContent-Type: ${SIGNED_CT}`],
    ['a second field in lower case', `Content-Type: ${SIGNED_CT}\r\ncontent-type: ${mixedY}`],
    ['a second field with a blank before the colon', `Content-Type: ${SIGNED_CT}\r\nContent-Type : ${mixedY}`],
    ['a second field with a tab inside its name', `Content-Type: ${SIGNED_CT}\r\nContent\t-Type: ${mixedY}`],
    ['a second field after a lone LF', `Content-Type: ${SIGNED_CT}\r\nX-Note: a\nContent-Type: ${mixedY}`],
    ['a second field after a lone CR', `Content-Type: ${SIGNED_CT}\r\nX-Note: a\rContent-Type: ${mixedY}`],
    ['a field name folded onto the next line', `Content-Type: ${SIGNED_CT}\r\nContent-\r\n Type: ${mixedY}`],
    ['a line of only blanks inside the header', `X-Note: a\r\n \r\nContent-Type: ${SIGNED_CT}`],
    ['the boundary again as an RFC 2231 section', `Content-Type: ${SIGNED_CT}; boundary*0="Y"`],
    ['the boundary again in RFC 2231 encoded form', `Content-Type: ${SIGNED_CT}; boundary*=utf-8''Y`],
    ['the protocol given twice', `Content-Type: ${SIGNED_CT}; protocol="application/pkcs7-signature"`],
    ['an 8-bit byte in the boundary', `Content-Type: ${SIGNED_CT.replace('"inner"', '"inneré"')}`, signedBody().replace(/--inner/g, '--inneré')],
    ['a NUL in the header block', `X-Note: a\u0000b\r\nContent-Type: ${SIGNED_CT}`],
  ])('is not shown as signed with %s', async (_, lines, body) => {
    const o = await open(withHeader(lines, body), agreeing);
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  it.each([
    ['a Content-Type folded over several lines', `Content-Type: multipart/signed;\r\n\tprotocol="application/pkcs7-signature";\r\n\tmicalg=sha-256;\r\n\tboundary="inner"`],
    ['upper-case names and values', 'CONTENT-TYPE: Multipart/Signed; Protocol="Application/PKCS7-Signature"; Micalg=SHA-256; Boundary="inner"'],
    // Servers read both line breaks and 8-bit bytes outside the parameters the split depends on as this reader does.
    ['an 8-bit byte in another parameter of the Content-Type field', `Content-Type: ${SIGNED_CT}; x="é"`],
    ['a header block that ends in a mixed line break', `Content-Type: ${SIGNED_CT}\n`],
  ])('still verifies a mail with %s (control)', async (_, lines) => {
    const o = await open(withHeader(lines), agreeing);
    expect(takenOver(o.result)).toBe(true);
    expect(success(o.rows)).toHaveLength(1);
  });

  it('still verifies a mail whose header block has LF line breaks throughout (control)', async () => {
    const o = await open(`${head.replace(/\r\n/g, '\n')}Content-Type: ${SIGNED_CT}\n\n${signedBody()}`, agreeing);
    expect(takenOver(o.result)).toBe(true);
  });

  async function signedOver(entity) {
    const signature = b64(await smimeSignDetached(enc.encode(entity), signer.key, signer.cert));
    return `--inner\r\n${entity}\r\n--inner\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\n`
      + `Content-Transfer-Encoding: base64\r\n\r\n${signature}\r\n--inner--\r\n`;
  }

  describe('and the server reads the mail the same way', () => {
    const raw = () => withHeader(`Content-Type: ${SIGNED_CT}`);
    const signature = { type: 'application/pkcs7-signature', name: 'smime.p7s', partId: '2' };

    it.each([
      ['a body structure of three parts', { type: 'multipart/signed', subParts: [{ type: 'text/plain', partId: '1' }, invoice, signature] }, [invoice]],
      ['a second part that is no signature', { type: 'multipart/signed', subParts: [{ type: 'text/plain', partId: '1' }, { ...invoice, partId: '2' }] }, []],
      ['an attachment listed that lies outside the signed part', signedTree, [{ ...invoice, partId: '3' }]],
      ['an attachment listed without a part id or blob id', signedTree, [{ type: 'text/html', name: 'invoice.html' }]],
      ['no body structure, and an attachment listed', undefined, [invoice]],
    ])('is not shown as signed with %s', async (_, bodyStructure, attachments) => {
      const o = await open(raw(), { contentType: SIGNED_CT, bodyStructure, attachments });
      expect(o.result).toBeUndefined();
      expect(o.rows).toEqual([damaged]);
    });

    it.each([
      ['the signature listed as an attachment', signedTree, [signature]],
      ['no body structure, and only the signature listed', undefined, [signature]],
    ])('still verifies a mail with %s (control)', async (_, bodyStructure, attachments) => {
      const o = await open(raw(), { contentType: SIGNED_CT, bodyStructure, attachments });
      expect(takenOver(o.result)).toBe(true);
    });
  });

  it('is not shown as signed when the signed entity has two Content-Type fields', async () => {
    const entity = `Content-Type: text/plain; charset=utf-8\r\nContent-Type: ${mixedY}\r\n\r\n${SIGNED_TEXT}. Regards, the CEO`;
    const o = await open(withHeader(`Content-Type: ${SIGNED_CT}`, await signedOver(entity)), agreeing);
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  it('still verifies a signed entity without a Content-Type field (control)', async () => {
    const entity = `Content-Transfer-Encoding: 7bit\r\n\r\n${SIGNED_TEXT}. Regards, the CEO`;
    const o = await open(withHeader(`Content-Type: ${SIGNED_CT}`, await signedOver(entity)), agreeing);
    expect(takenOver(o.result)).toBe(true);
  });

  it('is not shown as signed when the signature part has two Content-Type fields', async () => {
    const body = signedBody().replace('Content-Type: application/pkcs7-signature; name="smime.p7s"\r\n',
      'Content-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Type: text/html\r\n');
    const o = await open(withHeader(`Content-Type: ${SIGNED_CT}`, body), agreeing);
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  describe('for an opaque signed or encrypted mail', () => {
    const opaqueCt = 'application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"';
    const leaf = { type: 'application/pkcs7-mime', name: 'smime.p7m', blobId: 'p7m', partId: '1' };
    const opaque = async (lines) => {
      const cms = new Uint8Array(await (await smimeSign(enc.encode(ENTITY), signer.key, signer.cert)).arrayBuffer());
      return withHeader(`${lines}\r\nContent-Transfer-Encoding: base64`, `${b64(cms)}\r\n`);
    };

    it('verifies one with a header that reads one way (control)', async () => {
      const o = await open(await opaque(`Content-Type: ${opaqueCt}`), { contentType: opaqueCt, bodyStructure: leaf, attachments: [leaf] });
      expect(takenOver(o.result)).toBe(true);
    });

    it('does not verify one with a second Content-Type field', async () => {
      const raw = await opaque(`Content-Type: ${opaqueCt}\r\ncontent-type: application/pkcs7-mime; smime-type=enveloped-data`);
      const o = await open(raw, { contentType: opaqueCt, bodyStructure: leaf, attachments: [leaf] });
      expect(o.result).toBeUndefined();
      expect(o.rows).toEqual([damaged]);
    });

    it('does not verify or decrypt one the server reads as something else', async () => {
      const other = { type: 'multipart/mixed', partId: '0', subParts: [invoice, { ...leaf, partId: '2' }] };
      const o = await open(await opaque(`Content-Type: ${opaqueCt}`), { contentType: opaqueCt, bodyStructure: other, attachments: [invoice] });
      expect(o.result).toBeUndefined();
      expect(o.rows).toEqual([damaged]);
      const listed = await open(await opaque(`Content-Type: ${opaqueCt}`), { contentType: opaqueCt, bodyStructure: leaf, attachments: [leaf, { ...invoice, partId: '3' }] });
      expect(listed.result).toBeUndefined();
      expect(listed.rows).toEqual([damaged]);
      const encrypted = await open(fixture('cbc.p7m').toString('latin1'), {
        contentType: 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"', bodyStructure: other, attachments: [invoice],
      });
      expect(encrypted.result).toBeUndefined();
      expect(encrypted.status).toMatchObject({ isEncrypted: true, decryptionSuccess: false });
    });

    it('does not decrypt one with a second Content-Type field', async () => {
      const raw = fixture('cbc.p7m').toString('latin1').replace('Content-Transfer-Encoding: base64', 'Content - Type: text/html\r\nContent-Transfer-Encoding: base64');
      const ct = 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"';
      const { api, hooks } = plugin(raw);
      const result = await hooks.onRenderEmailBody({ html: '', text: '' }, { id: 'mail-1', blobId: 'raw', from: [{ email: SIGNER }], contentType: ct, bodyStructure: leaf, attachments: [leaf] });
      expect(result).toBeUndefined();
      expect(await api.storage.get('verify:mail-1')).toMatchObject({ isEncrypted: true, decryptionSuccess: false });
    });
  });
});
