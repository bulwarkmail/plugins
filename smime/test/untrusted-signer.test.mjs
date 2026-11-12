// A certificate anyone can make (issued by a "CA" its maker invented, or by itself) says
// nothing about who signed a mail. Nothing in it chains to an issuer the user, the admin
// or the plugin trusts.
//
//  1. The banner never shows the trusted verdict (tone "success") for it, whatever the
//     certificate claims and whatever the settings are.
//  2. Opening the mail does not make that certificate the one later mail to the named
//     address gets encrypted with.
//
// The other direction (a signer whose chain ends at a trusted issuer, or whose
// certificate the user trusted by hand, does get the trusted verdict) is in
// trusted-signer.test.mjs.
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
import { smimeVerify } from '../src/smime-verify.js';
import { bannerRows } from '../src/ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));

const VICTIM = 'ceo@victim.example';
const OPAQUE_CT = 'application/pkcs7-mime; smime-type=signed-data; name=smime.p7m';
const MESSAGE = new TextEncoder().encode(
  'Content-Type: text/plain; charset=utf-8\r\n\r\nPlease pay the attached invoice today. Regards, the CEO\r\n',
);

const name = (cn) => [new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) })];

/** A leaf certificate for `email`, issued by a CA key that exists only here. */
async function mintedFor(email, { selfSigned = false } = {}) {
  const alg = { name: 'ECDSA', namedCurve: 'P-256' };
  const ca = await crypto.subtle.generateKey(alg, false, ['sign', 'verify']);
  const leaf = await crypto.subtle.generateKey(alg, false, ['sign', 'verify']);
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: 4711 });
  cert.issuer.typesAndValues.push(...name(selfSigned ? 'The CEO' : 'Victim Corp Mail CA'));
  cert.subject.typesAndValues.push(...name('The CEO'));
  cert.notBefore.value = new Date(Date.now() - 86_400_000);
  cert.notAfter.value = new Date(Date.now() + 86_400_000);
  // Without an address the certificate names nobody at all.
  cert.extensions = email ? [
    new pkijs.Extension({
      extnID: '2.5.29.17',
      extnValue: new pkijs.GeneralNames({ names: [new pkijs.GeneralName({ type: 1, value: email })] }).toSchema().toBER(false),
    }),
  ] : [];
  await cert.subjectPublicKeyInfo.importKey(leaf.publicKey);
  await cert.sign(selfSigned ? leaf.privateKey : ca.privateKey, 'SHA-256');
  return { privateKey: leaf.privateKey, der: new Uint8Array(cert.toSchema(true).toBER(false)) };
}

const signedCms = async (minted) => new Uint8Array(await (await smimeSign(MESSAGE, minted.privateKey, minted.der)).arrayBuffer());

/** The whole message as a mail server stores it: one application/pkcs7-mime part around the CMS. */
function opaqueMessage(cms) {
  const b64 = Buffer.from(cms).toString('base64').match(/.{1,76}/g).join('\r\n');
  return new TextEncoder().encode(`From: The CEO <${VICTIM}>\r\nMIME-Version: 1.0\r\nContent-Type: ${OPAQUE_CT}\r\n`
    + `Content-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`);
}

/** The tones of the signature rows the banner would show for a verify status. */
function tones(status, options = {}) {
  const api = fakeApi({ translations: manifest.locales });
  return bannerRows(status, { t: (key, vars) => api.i18n.t(key, vars), ...options }).map((row) => row.tone);
}

let minted;
let cms;
let code;

beforeAll(async () => {
  minted = await mintedFor(VICTIM);
  cms = await signedCms(minted);
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

// `jmap.fetchBlob` hands back the CMS; the plugin gets the raw message around it, as it
// reads an opaque signed mail from the raw message.
function plugin(handlers = {}) {
  const RSA = { certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() };
  const ks = fakeKeystore([RSA]);
  const sent = [];
  const { 'jmap.fetchBlob': fetchCms, ...rest } = handlers;
  const api = fakeApi({
    id: 'smime',
    translations: manifest.locales,
    hostFeatures: { keystore: true },
    handlers: {
      ...ks.handlers,
      'jmap.sendRaw': async (bytes) => { sent.push(new Uint8Array(bytes)); },
      'ui.rerenderEmail': async () => {},
      'ui.setActions': async () => {},
      ...(fetchCms ? { 'jmap.fetchBlob': async (...args) => opaqueMessage(await fetchCms(...args)) } : {}),
      ...rest,
    },
  });
  const mod = { exports: {} };
  const req = (id) => {
    if (id === '@plugin-host') return api;
    if (id === '@plugin-host/ui') return kit;
    if (id === 'react' || id === 'react/jsx-runtime' || id === 'react-dom') return require(id);
    throw new Error(`module ${id} is not available`);
  };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
  return { api, sent, ...mod.exports };
}

const signedMail = (from) => ({
  id: 'mail-1', contentType: OPAQUE_CT, blobId: 'blob-1', from: [from],
});

describe('a signature made with a certificate nobody vouches for', () => {
  it('does not get the trusted verdict in the banner, even when the certificate names the From address', async () => {
    const { status } = await smimeVerify(cms, VICTIM);
    // What the sender controls lines up: the maths is right and the address matches.
    expect(status.cryptoValid).toBe(true);
    expect(status.signerEmailMatch).toBe(true);

    // Green "Valid signature by ceo@victim.example" is the verdict for a signer the user
    // can rely on. This certificate chains to nothing.
    expect(tones(status)).not.toContain('success');
    expect(tones(status, { warnSelfSigned: false })).not.toContain('success');
  });

  it('does not get the trusted verdict when the certificate is self-signed, with the self-signed warning switched off', async () => {
    const self = await mintedFor(VICTIM, { selfSigned: true });
    const { status } = await smimeVerify(await signedCms(self), VICTIM);
    expect(status.cryptoValid).toBe(true);
    expect(tones(status, { warnSelfSigned: false })).not.toContain('success');
    expect(tones(status, { warnSelfSigned: true })).not.toContain('success');
  });

  it('does not get the trusted verdict when the certificate names no address at all', async () => {
    const anonymous = await mintedFor(null);
    const { status } = await smimeVerify(await signedCms(anonymous), VICTIM);
    expect(status.cryptoValid).toBe(true);
    expect(tones(status)).not.toContain('success');
  });

  it('still says that the content was not changed, in a tone of its own (not the one of a broken signature)', async () => {
    const { status } = await smimeVerify(cms, VICTIM);
    expect(tones(status)).not.toContain('destructive');
    const broken = cms.slice();
    broken[broken.length - 5] ^= 0xff;
    const bad = await smimeVerify(broken, VICTIM).then((r) => tones(r.status), () => ['destructive']);
    expect(bad).not.toContain('success');
  });

  it('gets the same answer through the plugin when the mail is opened', async () => {
    const { hooks, api } = plugin({ 'jmap.fetchBlob': async () => cms });
    const result = await hooks.onRenderEmailBody({ html: '', text: '' }, signedMail(VICTIM));
    const shown = bannerRows(result.verification, { t: (key, vars) => api.i18n.t(key, vars), warnSelfSigned: false });
    expect(shown.map((r) => r.tone)).not.toContain('success');
  });
});
