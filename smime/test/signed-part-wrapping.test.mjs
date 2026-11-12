// A signature verdict belongs to a mail only when the signed entity is the whole mail.
// A mail that merely contains a signed part (an old signed mail of the claimed sender,
// put inside a new multipart/mixed next to unsigned parts) must not be taken over by the
// plugin: it does not replace the body with the signed part's text, and nothing in its
// bar has the look of a trusted signature. The webmail then shows the mail as it is,
// with whatever the plugin says about the signed part in a warning tone.
//
// These cases hold whoever issued the signer's certificate. Once the plugin knows trusted
// issuers, add the same two wrapped mails signed under a trusted one.
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
import { listPublicCerts, saveTrusted } from '../src/key-storage.js';
import { computeFingerprint } from '../src/certificate-utils.js';
import { makeCa, makeLeaf } from './helpers/test-certificates.mjs';
import { bannerRows } from '../src/ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));
const enc = new TextEncoder();
const SIGNER = 'ceo@victim.example';

let code;
let signedPart; // the multipart/signed entity: its Content-Type line and its body
let signer; // the signer's key and certificate, for the other shapes below
beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(here, '../src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    alias: { crypto: path.join(here, '../src/node-crypto-shim.js') },
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  });
  code = out.outputFiles[0].text;

  // A certificate for the signer. Whoever issued it is not the point of this test.
  const alg = { name: 'ECDSA', namedCurve: 'P-256' };
  const ca = await crypto.subtle.generateKey(alg, false, ['sign', 'verify']);
  const leaf = await crypto.subtle.generateKey(alg, false, ['sign', 'verify']);
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: 7 });
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
  const certDer = new Uint8Array(cert.toSchema(true).toBER(false));
  signer = { key: leaf.privateKey, cert: certDer };

  // What the CEO once really signed and sent.
  const entity = 'Content-Type: text/plain; charset=utf-8\r\n\r\nPlease see the attached document. Regards, the CEO';
  const signature = await smimeSignDetached(enc.encode(entity), leaf.privateKey, certDer);
  const b64 = Buffer.from(signature).toString('base64').match(/.{1,76}/g).join('\r\n');
  signedPart = {
    contentType: 'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="inner"',
    body: `--inner\r\n${entity}\r\n--inner\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--inner--\r\n`,
  };
}, 120_000);

beforeEach(() => { globalThis.indexedDB = fakeIndexedDB(); });

// `blobs` holds the parts' own blobs by id; any other id fetches the raw message.
function plugin(raw, blobs = {}) {
  const ks = fakeKeystore([{ certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() }]);
  const api = fakeApi({
    id: 'smime', translations: manifest.locales, hostFeatures: { keystore: true },
    handlers: { ...ks.handlers, 'jmap.fetchBlob': async (id) => blobs[id] ?? enc.encode(raw), 'ui.rerenderEmail': async () => {}, 'ui.setActions': async () => {} },
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === '@plugin-host') return api;
    if (id === '@plugin-host/ui') return kit;
    return require(id);
  });
  return { api, ...mod.exports };
}

const head = `From: The CEO <${SIGNER}>\r\nTo: me@victim.example\r\nSubject: Invoice\r\nMIME-Version: 1.0\r\n`;
const signedTree = { type: 'multipart/signed', subParts: [{ type: 'text/plain', partId: '1' }, { type: 'application/pkcs7-signature', partId: '2' }] };

async function open(raw, ctx, blobs) {
  const { api, hooks } = plugin(raw, blobs);
  const result = await hooks.onRenderEmailBody({ html: '', text: '' }, { id: 'mail-1', blobId: 'raw', from: [{ email: SIGNER }], ...ctx });
  const status = await api.storage.get('verify:mail-1');
  const rows = status ? bannerRows(status, { t: (k, v) => api.i18n.t(k, v) }) : [];
  return { result, rows: rows.map(({ icon, tone, text }) => ({ icon, tone, text })) };
}

describe('a signed part inside an unsigned mail', () => {
  const signedText = 'Please see the attached document';
  const attachment = { type: 'text/html', name: 'invoice.html', blobId: 'att', size: 60, partId: '4' };
  const attachmentPart = '--outer\r\nContent-Type: text/html; name="invoice.html"\r\nContent-Disposition: attachment; filename="invoice.html"\r\n\r\n'
    + '<form action="https://attacker.example/">Your password</form>\r\n';
  const takenOver = (result) => !!result && `${result.text ?? ''}${result.html ?? ''}`.includes(signedText);

  it('a mail signed as a whole is shown from its signed part, with a verdict (control)', async () => {
    const whole = await open(`${head}Content-Type: ${signedPart.contentType}\r\n\r\n${signedPart.body}`, {
      contentType: signedPart.contentType, bodyStructure: signedTree, attachments: [],
    });
    expect(whole.result.text).toContain(signedText);
    expect(whole.rows.length).toBeGreaterThan(0);
  });

  it('a signed part followed by an unsigned attachment is not shown as a signed mail', async () => {
    const wrapped = await open(
      `${head}Content-Type: multipart/mixed; boundary="outer"\r\n\r\n`
      + `--outer\r\nContent-Type: ${signedPart.contentType}\r\n\r\n${signedPart.body}`
      + `${attachmentPart}--outer--\r\n`,
      {
        contentType: 'multipart/mixed; boundary="outer"',
        bodyStructure: { type: 'multipart/mixed', subParts: [signedTree, attachment] },
        attachments: [attachment],
      },
    );
    expect(takenOver(wrapped.result)).toBe(false);
    expect(wrapped.rows.filter((r) => r.tone === 'success')).toEqual([]);
  });

  it('a signed part behind an unsigned text is not shown as a signed mail', async () => {
    const wrapped = await open(
      `${head}Content-Type: multipart/mixed; boundary="outer"\r\n\r\n`
      + '--outer\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nNew bank details below, please use them from now on.\r\n'
      + `--outer\r\nContent-Type: ${signedPart.contentType}\r\n\r\n${signedPart.body}`
      + '--outer--\r\n',
      {
        contentType: 'multipart/mixed; boundary="outer"',
        bodyStructure: { type: 'multipart/mixed', subParts: [{ type: 'text/plain', partId: '1' }, { ...signedTree, partId: '2' }] },
        attachments: [],
      },
    );
    expect(takenOver(wrapped.result)).toBe(false);
    expect(wrapped.rows.filter((r) => r.tone === 'success')).toEqual([]);
  });

  it('a signed part two levels down is not shown as a signed mail', async () => {
    const wrapped = await open(
      `${head}Content-Type: multipart/mixed; boundary="outer"\r\n\r\n`
      + '--outer\r\nContent-Type: multipart/related; boundary="mid"\r\n\r\n'
      + `--mid\r\nContent-Type: ${signedPart.contentType}\r\n\r\n${signedPart.body}--mid--\r\n`
      + `${attachmentPart}--outer--\r\n`,
      {
        contentType: 'multipart/mixed; boundary="outer"',
        bodyStructure: { type: 'multipart/mixed', subParts: [{ type: 'multipart/related', subParts: [signedTree] }, attachment] },
        attachments: [attachment],
      },
    );
    expect(takenOver(wrapped.result)).toBe(false);
    expect(wrapped.rows.filter((r) => r.tone === 'success')).toEqual([]);
  });

  describe('signed under an issuer the user trusts', () => {
    let ca;
    let trustedPart;
    beforeAll(async () => {
      ca = await makeCa('Example Corp Mail CA');
      const leaf = await makeLeaf(ca, { emails: [SIGNER] });
      const entity = 'Content-Type: text/plain; charset=utf-8\r\n\r\nPlease see the attached document. Regards, the CEO';
      const b64 = Buffer.from(await smimeSignDetached(enc.encode(entity), leaf.key.privateKey, leaf.der)).toString('base64').match(/.{1,76}/g).join('\r\n');
      trustedPart = {
        contentType: signedPart.contentType,
        body: `--inner\r\n${entity}\r\n--inner\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--inner--\r\n`,
      };
    });
    beforeEach(async () => {
      await saveTrusted({ id: 'issuer', kind: 'issuer', certificate: ca.der.buffer.slice(0), fingerprint: await computeFingerprint(ca.der) });
    });

    it('the mail signed as a whole gets the trusted verdict (control)', async () => {
      const whole = await open(`${head}Content-Type: ${trustedPart.contentType}\r\n\r\n${trustedPart.body}`, {
        contentType: trustedPart.contentType, bodyStructure: signedTree, attachments: [],
      });
      expect(whole.rows.map((r) => r.tone)).toEqual(['success']);
    });

    it('the signed part followed by an unsigned attachment still gets no trusted verdict', async () => {
      const wrapped = await open(
        `${head}Content-Type: multipart/mixed; boundary="outer"\r\n\r\n`
        + `--outer\r\nContent-Type: ${trustedPart.contentType}\r\n\r\n${trustedPart.body}`
        + `${attachmentPart}--outer--\r\n`,
        {
          contentType: 'multipart/mixed; boundary="outer"',
          bodyStructure: { type: 'multipart/mixed', subParts: [signedTree, attachment] },
          attachments: [attachment],
        },
      );
      expect(takenOver(wrapped.result)).toBe(false);
      expect(wrapped.rows.filter((r) => r.tone === 'success')).toEqual([]);
    });

    it('the signed part behind an unsigned text still gets no trusted verdict', async () => {
      const wrapped = await open(
        `${head}Content-Type: multipart/mixed; boundary="outer"\r\n\r\n`
        + '--outer\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nNew bank details below, please use them from now on.\r\n'
        + `--outer\r\nContent-Type: ${trustedPart.contentType}\r\n\r\n${trustedPart.body}`
        + '--outer--\r\n',
        {
          contentType: 'multipart/mixed; boundary="outer"',
          bodyStructure: { type: 'multipart/mixed', subParts: [{ type: 'text/plain', partId: '1' }, { ...signedTree, partId: '2' }] },
          attachments: [],
        },
      );
      expect(takenOver(wrapped.result)).toBe(false);
      expect(wrapped.rows.filter((r) => r.tone === 'success')).toEqual([]);
    });
  });
});

describe('what counts as a mail signed as a whole', () => {
  const en = manifest.locales.en;
  const entity = 'Content-Type: text/plain; charset=utf-8\r\n\r\nPlease see the attached document. Regards, the CEO';
  const signedCt = 'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="inner"';
  const warning = { icon: 'alert-triangle', tone: 'warning', text: en['banner.partlySigned'] };
  const attachment = { type: 'text/html', name: 'invoice.html', blobId: 'att', size: 60, partId: '4' };
  const attachmentPart = (boundary) => `--${boundary}\r\nContent-Type: text/html; name="invoice.html"\r\n`
    + 'Content-Disposition: attachment; filename="invoice.html"\r\n\r\n<p>Invoice</p>\r\n';
  const mixed = { contentType: 'multipart/mixed; boundary="outer"' };
  const keptFor = async (email) => (await listPublicCerts()).filter((c) => c.email === email);
  const base64 = (bytes) => Buffer.from(bytes).toString('base64').match(/.{1,76}/g).join('\r\n');

  /** A multipart/signed body over `signed`, with `extra` (whole parts) between the entity and the signature. */
  async function signedBody(signed, extra = '') {
    const signature = await smimeSignDetached(enc.encode(signed), signer.key, signer.cert);
    return `--inner\r\n${signed}\r\n${extra}--inner\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\n`
      + `Content-Transfer-Encoding: base64\r\n\r\n${base64(signature)}\r\n--inner--\r\n`;
  }

  it('says in a warning that only a part is signed, and keeps no certificate from it', async () => {
    const wrapped = await open(
      `${head}Content-Type: multipart/mixed; boundary="outer"\r\n\r\n`
      + `--outer\r\nContent-Type: ${signedPart.contentType}\r\n\r\n${signedPart.body}${attachmentPart('outer')}--outer--\r\n`,
      { ...mixed, bodyStructure: { type: 'multipart/mixed', subParts: [signedTree, attachment] }, attachments: [attachment] },
    );
    expect(wrapped.result).toBeUndefined();
    expect(wrapped.rows).toEqual([warning]);
    expect(await keptFor(SIGNER)).toEqual([]);
  });

  it.each([
    ['as a server describes it', 'application/pkcs7-mime', []],
    ['with its smime-type in the body structure', 'application/pkcs7-mime; smime-type=signed-data', [warning]],
  ])('leaves an opaque signed part inside a multipart/mixed alone, %s', async (_, partType, rows) => {
    const cms = new Uint8Array(await (await smimeSign(enc.encode(entity), signer.key, signer.cert)).arrayBuffer());
    const part = { type: partType, name: 'smime.p7m', blobId: 'p7m', partId: '2' };
    const opened = await open(
      `${head}Content-Type: multipart/mixed; boundary="outer"\r\n\r\n`
      + '--outer\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nNew bank details below, please use them from now on.\r\n'
      + '--outer\r\nContent-Type: application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"\r\n'
      + `Content-Disposition: attachment; filename="smime.p7m"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(cms)}\r\n--outer--\r\n`,
      { ...mixed, bodyStructure: { type: 'multipart/mixed', subParts: [{ type: 'text/plain', partId: '1' }, part] }, attachments: [part] },
      { p7m: cms },
    );
    expect(opened.result).toBeUndefined();
    expect(opened.rows).toEqual(rows);
    expect(await keptFor(SIGNER)).toEqual([]);
  });

  it('shows a mail signed as a whole from its signed entity, attachments inside it included (control)', async () => {
    const content = 'Content-Type: multipart/mixed; boundary="content"\r\n\r\n'
      + '--content\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThe report is attached.\r\n'
      + '--content\r\nContent-Type: text/plain; name="report.txt"\r\nContent-Disposition: attachment; filename="report.txt"\r\n\r\nQ3 figures\r\n'
      + '--content--';
    const report = { type: 'text/plain', name: 'report.txt', blobId: 'att', partId: '1.2' };
    const whole = await open(`${head}Content-Type: ${signedCt}\r\n\r\n${await signedBody(content)}`, {
      contentType: signedCt,
      bodyStructure: {
        type: 'multipart/signed',
        subParts: [{ type: 'multipart/mixed', subParts: [{ type: 'text/plain', partId: '1.1' }, report] }, { type: 'application/pkcs7-signature', partId: '2' }],
      },
      attachments: [report],
    });
    expect(whole.result.text).toContain('The report is attached.');
    expect(whole.result.attachments.map((a) => a.name)).toEqual(['report.txt']);
    expect(whole.rows.length).toBeGreaterThan(0);
    expect(whole.rows).not.toContainEqual(warning);
  });

  it('leaves a mail alone when the body structure from the server disagrees with the raw message', async () => {
    const opened = await open(`${head}Content-Type: ${signedPart.contentType}\r\n\r\n${signedPart.body}`, {
      contentType: signedPart.contentType,
      bodyStructure: { type: 'multipart/mixed', subParts: [{ type: 'text/plain', partId: '1' }, attachment] },
      attachments: [attachment],
    });
    // The webmail would list the server's attachment under the plugin's verdict.
    expect(opened.result).toBeUndefined();
    expect(opened.rows).toEqual([{ icon: 'shield-exclamation', tone: 'destructive', text: en['banner.invalid'].replace('{error}', en['error.malformedSigned']) }]);
    expect(await keptFor(SIGNER)).toEqual([]);
  });

  it('does not show a mail as signed whose header says multipart/signed when the raw message is not', async () => {
    const opened = await open(
      `${head}Content-Type: multipart/mixed; boundary="outer"\r\n\r\n`
      + `--outer\r\nContent-Type: ${signedPart.contentType}\r\n\r\n${signedPart.body}${attachmentPart('outer')}--outer--\r\n`,
      { contentType: signedPart.contentType, bodyStructure: signedTree, attachments: [] },
    );
    expect(opened.result).toBeUndefined();
    expect(opened.rows.filter((r) => r.tone === 'success')).toEqual([]);
    expect(await keptFor(SIGNER)).toEqual([]);
  });

  it('does not show a multipart/signed as signed when it holds a part besides the signed entity and the signature', async () => {
    const opened = await open(`${head}Content-Type: ${signedCt}\r\n\r\n${await signedBody(entity, attachmentPart('inner'))}`, {
      contentType: signedCt,
      bodyStructure: { type: 'multipart/signed', subParts: [{ type: 'text/plain', partId: '1' }, attachment, { type: 'application/pkcs7-signature', partId: '3' }] },
      attachments: [attachment],
    });
    expect(opened.result).toBeUndefined();
    expect(opened.rows.filter((r) => r.tone === 'success')).toEqual([]);
    expect(await keptFor(SIGNER)).toEqual([]);
  });

  it('leaves no verdict stored earlier above a mail it does not take over', async () => {
    const { api, hooks } = plugin(`${head}Content-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: text/plain\r\n\r\nHello\r\n${attachmentPart('outer')}--outer--\r\n`);
    await api.storage.set('verify:mail-1', {
      isSigned: true, signatureValid: true, signerEmailMatch: true, at: 1,
      signerCert: { email: SIGNER, notBefore: '2000-01-01', notAfter: '2999-01-01' },
    });
    const ctx = {
      id: 'mail-1', blobId: 'raw', from: [{ email: SIGNER }], ...mixed,
      bodyStructure: { type: 'multipart/mixed', subParts: [{ type: 'text/plain', partId: '1' }, attachment] }, attachments: [attachment],
    };
    expect(await hooks.onRenderEmailBody({ html: '', text: '' }, ctx)).toBeUndefined();
    expect(bannerRows(await api.storage.get('verify:mail-1'), { t: (k, v) => api.i18n.t(k, v) })).toEqual([]);
    // Gone altogether the next time.
    await hooks.onRenderEmailBody({ html: '', text: '' }, ctx);
    expect(await api.storage.get('verify:mail-1')).toBeNull();
  });
});
