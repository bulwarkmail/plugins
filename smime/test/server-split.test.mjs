// A mail signed as a whole is taken over only when the mail server reads its signed part as the
// entity the plugin verified. The server (Stalwart, mail-parser) finds a boundary delimiter at ANY
// "--<boundary>" in the body, in the middle of a line or after a lone CR, and stops at its first
// closing delimiter. The plugin splits at whole lines only. So a body can hold a second complete
// multipart/signed, written with such delimiters before the plugin's first delimiter line: the
// server reads that one (with its own attachment in the first part), the plugin verifies the parts
// after it. Both see multipart/signed with two parts, and every attachment the server lists lies
// inside its first part.
//
// The plugin refuses such a mail in two ways: the boundary may appear only on the delimiter lines
// it split at, and the server's first part has to have the verified entity's tree of media types,
// with the entity's names and sizes, and every attachment the server lists has to be one of its
// leaves. Refused mail reads as a damaged signed message and is shown the way the server reads it.
//
// The server views below are what mail-parser 0.11.9 (Stalwart 1.0) gives for these bytes (partId =
// index in its part list), from a local build of the crate. Sizes of signature parts are left out:
// the signatures here are made afresh on every run.
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

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const en = manifest.locales.en;
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));
const enc = new TextEncoder();
const latin1 = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
const SIGNER = 'ceo@victim.example';
const SIGNED_TEXT = 'Please see the attached document';
const ENTITY = `Content-Type: text/plain; charset=utf-8\r\n\r\n${SIGNED_TEXT}. Regards, the CEO`;
const b64 = (bytes) => Buffer.from(bytes).toString('base64').match(/.{1,76}/g).join('\r\n');

let code;
let sigB64;
let signer; // the signer's key and certificate, for the other signed entities below
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
  cert.serialNumber = new asn1js.Integer({ value: 13 });
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

// `raw` is the message as text (sent as UTF-8) or as bytes.
function plugin(raw) {
  const ks = fakeKeystore([{ certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() }]);
  const api = fakeApi({
    id: 'smime', translations: manifest.locales, hostFeatures: { keystore: true },
    handlers: {
      ...ks.handlers, 'jmap.fetchBlob': async () => (typeof raw === 'string' ? enc.encode(raw) : raw), 'ui.rerenderEmail': async () => {}, 'ui.setActions': async () => {},
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

const SIGNED_CT = 'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="B"';
const head = `From: The CEO <${SIGNER}>\r\nTo: me@victim.example\r\nSubject: Invoice\r\nMIME-Version: 1.0\r\nContent-Type: ${SIGNED_CT}\r\n\r\n`;
const signedParts = () => `--B\r\n${ENTITY}\r\n--B\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Transfer-Encoding: base64\r\n\r\n${sigB64}\r\n--B--\r\n`;
const sig = { partId: '4', type: 'application/pkcs7-signature', name: 'smime.p7s' };

// The sender's own multipart/signed, with delimiters that start with `lead` (mid-line or after a lone CR).
function senderStructure(lead, firstPart) {
  return `${lead}--B\r\n${firstPart}${lead}--B\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\n\r\nMAA=\r\n${lead}--B--\r\n`;
}
const invoiceMixed = 'Content-Type: multipart/mixed; boundary="M"\r\n\r\n--M\r\nContent-Type: text/plain\r\n\r\nhi\r\n'
  + '--M\r\nContent-Type: text/html; name="invoice.html"\r\nContent-Disposition: attachment; filename="invoice.html"\r\n\r\n<form action="https://pay.example/">Your password</form>\r\n--M--\r\n';
const invitation = 'Content-Type: multipart/alternative; boundary="M"\r\n\r\n--M\r\nContent-Type: text/plain\r\n\r\nhi\r\n'
  + '--M\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:1@pay.example\r\nSUMMARY:Payment approval\r\nDTSTART:20261113T100000Z\r\nORGANIZER:mailto:ceo@victim.example\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n--M--\r\n';

// mail-parser 0.11.9's reading of the three mails below.
const invoiceView = {
  bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [
    { partId: '1', type: 'multipart/mixed', subParts: [{ partId: '2', type: 'text/plain' }, { partId: '3', type: 'text/html', name: 'invoice.html' }] }, sig] },
  attachments: [{ partId: '3', type: 'text/html', name: 'invoice.html' }, sig],
};
const invitationView = {
  bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [
    { partId: '1', type: 'multipart/alternative', subParts: [{ partId: '2', type: 'text/plain' }, { partId: '3', type: 'text/calendar' }] }, sig] },
  attachments: [{ partId: '3', type: 'text/calendar', name: '' }, sig],
};

async function open(raw, view) {
  const { api, hooks } = plugin(raw);
  const result = await hooks.onRenderEmailBody({ html: '', text: '' }, {
    id: 'mail-1', blobId: 'raw', from: [{ email: SIGNER }], contentType: ` ${SIGNED_CT}`, ...view,
  });
  const status = await api.storage.get('verify:mail-1');
  const rows = status ? bannerRows(status, { t: (k, v) => api.i18n.t(k, v) }) : [];
  return { result, status, rows: rows.map(({ icon, tone, text }) => ({ icon, tone, text })), success: rows.filter((r) => r.tone === 'success') };
}

describe('the server and the plugin split the body at the same delimiters', () => {
  it('a mail signed as a whole is verified (control)', async () => {
    const o = await open(`${head}${signedParts()}`, {
      bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [{ partId: '1', type: 'text/plain' }, { partId: '2', type: 'application/pkcs7-signature', name: 'smime.p7s' }] },
      attachments: [{ partId: '2', type: 'application/pkcs7-signature', name: 'smime.p7s' }],
    });
    expect(o.result?.text).toContain(SIGNED_TEXT);
    expect(o.success).toHaveLength(1);
  });

  it('1. not with the sender\'s structure in the preamble, delimiters in the middle of a line', async () => {
    const o = await open(`${head}${senderStructure('x', invoiceMixed)}${signedParts()}`, invoiceView);
    expect(o.result?.handledBy).toBeUndefined();
    expect(o.success).toEqual([]);
  });

  it('2. not with the same after lone CR line breaks', async () => {
    const o = await open(`${head}${senderStructure('pre\r', invoiceMixed)}${signedParts()}`, invoiceView);
    expect(o.result?.handledBy).toBeUndefined();
    expect(o.success).toEqual([]);
  });

  it('3. not with an invitation in the sender\'s first part (the webmail shows an invitation banner for it)', async () => {
    const o = await open(`${head}${senderStructure('x', invitation)}${signedParts()}`, invitationView);
    expect(o.result?.handledBy).toBeUndefined();
    expect(o.success).toEqual([]);
  });
});

const damaged = { icon: 'shield-exclamation', tone: 'destructive', text: en['banner.invalid'].replace('{error}', en['error.malformedSigned']) };
const signature = (partId) => ({ partId, type: 'application/pkcs7-signature', name: 'smime.p7s' });
// The server's reading when it splits where the plugin does: the signed text and the signature.
const plainView = {
  bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [{ partId: '1', type: 'text/plain', size: 50 }, signature('2')] },
  attachments: [signature('2')],
};

/** A multipart/signed body (boundary "B") over `entity`, signed by the signer. `bytes` turns text into the signed bytes. */
async function signedOver(entity, bytes = (s) => enc.encode(s)) {
  const signatureB64 = b64(await smimeSignDetached(bytes(entity), signer.key, signer.cert));
  return `--B\r\n${entity}\r\n--B\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Transfer-Encoding: base64\r\n\r\n${signatureB64}\r\n--B--\r\n`;
}

// A signed report with a PDF, in a multipart/mixed whose boundary "Bx" begins with the message's "B".
const PDF = 'JVBERi0xLjcKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nPj4KZW5kb2JqCg==';
const report = (nameParams = 'name="report.pdf"', disposition = '') => 'Content-Type: multipart/mixed; boundary="Bx"\r\n\r\n'
  + '--Bx\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThe report is attached.\r\n'
  + `--Bx\r\nContent-Type: application/pdf; ${nameParams}\r\nContent-Disposition: attachment${disposition}\r\nContent-Transfer-Encoding: base64\r\n\r\n${PDF}\r\n--Bx--`;
const reportView = (pdf = {}) => {
  const att = { partId: '3', type: 'application/pdf', name: 'report.pdf', size: 52, ...pdf };
  return {
    bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [
      { partId: '1', type: 'multipart/mixed', subParts: [{ partId: '2', type: 'text/plain', size: 23 }, att] }, signature('4')] },
    attachments: [att, signature('4')],
  };
};

describe('where the boundary may appear in a signed mail', () => {
  it('not with an inline calendar part as the sender\'s first part', async () => {
    const calendar = 'Content-Type: text/calendar; method=REQUEST; charset=utf-8\r\nContent-Disposition: inline\r\n\r\n'
      + 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:1@pay.example\r\nSUMMARY:Payment approval\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const o = await open(`${head}${senderStructure('x', calendar)}${signedParts()}`, {
      bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [{ partId: '1', type: 'text/calendar', size: 120 }, signature('2')] },
      attachments: [{ partId: '1', type: 'text/calendar', name: '' }, signature('2')],
    });
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  // mail-parser stops at the first closing delimiter, so it reads the signed parts here; a parser
  // that reads on would find the second structure. The plugin refuses either way.
  it.each([
    ['delimiters in the middle of a line', 'x'],
    ['delimiters on whole lines', ''],
  ])('not with a second structure after the closing delimiter, %s', async (_, lead) => {
    const o = await open(`${head}${signedParts()}${senderStructure(lead, invoiceMixed)}`, plainView);
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  it('not with delimiter lines that carry more characters, closed in the middle of a line', async () => {
    const body = `--B.x\r\n${invoiceMixed}--B.x\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\n\r\nMAA=\r\nx--B--\r\n${signedParts()}`;
    const o = await open(`${head}${body}`, invoiceView);
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  it('not when the sender\'s structure has the signed entity\'s tree of parts', async () => {
    // A signed invitation, and before it the same tree with another event. The server's first part
    // has the entity's media types, and text parts carry no name and no size that could differ:
    // only the boundary in the middle of a line tells the two apart.
    const invite = (summary) => 'Content-Type: multipart/alternative; boundary="M"\r\n\r\n'
      + '--M\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee the invitation.\r\n'
      + `--M\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:7@victim.example\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n--M--`;
    const raw = `${head}${senderStructure('x', `${invite('Payment approval')}\r\n`)}${await signedOver(invite('Quarterly planning'))}`;
    const o = await open(raw, {
      bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [
        { partId: '1', type: 'multipart/alternative', subParts: [{ partId: '2', type: 'text/plain', size: 19 }, { partId: '3', type: 'text/calendar', size: 120 }] }, signature('4')] },
      attachments: [{ partId: '3', type: 'text/calendar', name: '' }, signature('4')],
    });
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  it('still verifies a nested multipart whose boundary begins with the boundary of the message (control)', async () => {
    const o = await open(`${head}${await signedOver(report())}`, reportView());
    expect(o.result?.text).toContain('The report is attached.');
    expect(o.result?.attachments.map((a) => a.name)).toEqual(['report.pdf']);
    expect(o.success).toHaveLength(1);
  });

  // A client picks the boundary so that it occurs nowhere in the content (RFC 2046, 5.1.1). Where it
  // does occur in the signed text, mail-parser cuts a signed text part there (the server's text below
  // is 23 characters long, the rest of the line goes into the signature part's header) and reads the
  // rest of the message from that point. Inside a nested multipart it only looks for the nested
  // boundary, but the plugin doesn't make its rule depend on that.
  it.each([
    ['in a signed text part', 'Content-Type: text/plain; charset=utf-8\r\n\r\nThe parts are split at --B in this message.', {
      bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [{ partId: '1', type: 'text/plain', size: 23 }, signature('2')] },
      attachments: [signature('2')],
    }],
    ['in a text part of a nested multipart', 'Content-Type: multipart/mixed; boundary="M"\r\n\r\n--M\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThe parts are split at --B in this message.\r\n--M--', {
      bodyStructure: { partId: '0', type: 'multipart/signed', subParts: [
        { partId: '1', type: 'multipart/mixed', subParts: [{ partId: '2', type: 'text/plain', size: 43 }] }, signature('3')] },
      attachments: [signature('3')],
    }],
  ])('refuses a signed mail that holds its boundary in the middle of a line %s', async (_, entity, view) => {
    const o = await open(`${head}${await signedOver(entity)}`, view);
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });
});

describe('the server\'s signed part is the entity the plugin verified', () => {
  // The raw messages here are signed as a whole and hold the boundary only on delimiter lines; only
  // the server's view differs.
  it('not when the server reads another tree of parts', async () => {
    const o = await open(`${head}${signedParts()}`, invoiceView);
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  it.each([
    ['another name', { name: 'invoice.pdf' }],
    ['another size', { size: 53 }],
    ['another media type', { type: 'application/zip' }],
  ])('not when the server lists the attachment with %s', async (_, pdf) => {
    const o = await open(`${head}${await signedOver(report())}`, reportView(pdf));
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  it('not when the server lists an attachment the signed entity holds no part for', async () => {
    const view = reportView();
    view.bodyStructure.subParts[0].subParts.push({ partId: '5', type: 'text/html', name: 'invoice.html', size: 10 });
    view.attachments.push({ partId: '5', type: 'text/html', name: 'invoice.html', size: 10 });
    const o = await open(`${head}${await signedOver(report())}`, view);
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  // Names as mail-parser decodes them: it keeps the blank between two encoded words inside quotes,
  // reads each RFC 2231 section on its own, and raw bytes as UTF-8.
  it.each([
    ['in RFC 2231 form with its charset', 'name="=?UTF-8?Q?Bericht_M=C3=A4rz.pdf?="', "; filename*=UTF-8''Bericht%20M%C3%A4rz.pdf", 'Bericht März.pdf'],
    ['in two RFC 2047 words', 'name="=?utf-8?B?QmVyaWNodCBNw6RyeiAyMDI2LnBkZg==?="', '; filename="=?utf-8?B?QmVyaWNodCBNw6Ry?= =?utf-8?B?eiAyMDI2LnBkZg==?="', 'Bericht Mär z 2026.pdf'],
    ['in RFC 2231 sections that split a character', 'name="x.pdf"', "; filename*0*=UTF-8''Bericht%20M%C3; filename*1*=%A4rz%20lang.pdf", 'Bericht M��rz lang.pdf'],
    ['in an RFC 2047 word in ISO-2022-JP', 'name="=?ISO-2022-JP?B?GyRCSlM5cDJxGyhCLnBkZg==?="', '', '篇告会.pdf'],
    ['as raw UTF-8', `name="${Buffer.from('Bericht März.pdf', 'utf8').toString('latin1')}"`, '', 'Bericht März.pdf'],
    ['as raw Latin-1', 'name="Bericht M\xe4rz.pdf"', '', 'Bericht M�rz.pdf'],
  ])('still verifies a signed attachment named %s (control)', async (_, nameParams, disposition, serverName) => {
    const raw = `${head}${await signedOver(report(nameParams, disposition), latin1)}`;
    const o = await open(latin1(raw), reportView({ name: serverName }));
    expect(o.result?.text).toContain('The report is attached.');
    expect(o.success).toHaveLength(1);
  });
});

describe('the server reads an opaque signed or encrypted mail as the part the plugin unwraps', () => {
  const opaqueCt = 'application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"';
  const pemDer = (pem) => new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64'));
  async function openOpaque(raw, contentType, leaf) {
    const { api, hooks } = plugin(raw);
    const result = await hooks.onRenderEmailBody({ html: '', text: '' }, {
      id: 'mail-1', blobId: 'raw', from: [{ email: SIGNER }], contentType, bodyStructure: leaf, attachments: [leaf],
    });
    const status = await api.storage.get('verify:mail-1');
    return { result, status, rows: status ? bannerRows(status, { t: (k, v) => api.i18n.t(k, v) }).map(({ icon, tone, text }) => ({ icon, tone, text })) : [] };
  }
  async function opaqueSigned() {
    const cms = new Uint8Array(await (await smimeSign(enc.encode(ENTITY), signer.key, signer.cert)).arrayBuffer());
    const raw = `From: The CEO <${SIGNER}>\r\nMIME-Version: 1.0\r\nContent-Type: ${opaqueCt}\r\nContent-Disposition: attachment; filename="smime.p7m"\r\n`
      + `Content-Transfer-Encoding: base64\r\n\r\n${b64(cms)}\r\n`;
    return { cms, raw };
  }

  it('verifies one whose part the server sizes as its CMS (control)', async () => {
    const { cms, raw } = await opaqueSigned();
    const o = await openOpaque(raw, opaqueCt, { partId: '0', type: 'application/pkcs7-mime', name: 'smime.p7m', size: cms.length });
    expect(o.result?.text).toContain(SIGNED_TEXT);
  });

  it.each([
    ['another size', (cms) => ({ size: cms.length + 2 })],
    ['another name', () => ({ name: 'invoice.p7m' })],
  ])('does not verify one whose part the server lists with %s', async (_, change) => {
    const { cms, raw } = await opaqueSigned();
    const o = await openOpaque(raw, opaqueCt, { partId: '0', type: 'application/pkcs7-mime', name: 'smime.p7m', size: cms.length, ...change(cms) });
    expect(o.result).toBeUndefined();
    expect(o.rows).toEqual([damaged]);
  });

  it('decrypts an encrypted one only when the server sizes its part as the CMS', async () => {
    const raw = fixture('cbc.p7m').toString('latin1');
    const der = pemDer(raw.split(/\r?\n\r?\n/).slice(1).join(''));
    const ct = 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"';
    const leaf = { partId: '0', type: 'application/pkcs7-mime', name: 'smime.p7m', size: der.length };
    expect((await openOpaque(raw, ct, leaf)).result?.text).toContain('Hello from the S/MIME test fixture.');
    const other = await openOpaque(raw, ct, { ...leaf, size: der.length + 2 });
    expect(other.result).toBeUndefined();
    expect(other.status).toMatchObject({ isEncrypted: true, decryptionSuccess: false });
  });
});
