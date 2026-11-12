// A signer is verified (the green "Valid signature by <address>") when a path leads from
// the signer certificate to a trusted issuer, each link signed, in its dates, a CA that
// may sign certificates, or when the certificate itself is one the user trusts; the
// certificate may sign mail; the digest is not SHA-1 or MD5; and the From address is one
// of the certificate's addresses. Everything else with an intact signature reads
// "Signature matches, signer not verified". untrusted-signer.test.mjs has the other side.
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
import {
  makeCa, makeLeaf, signedCms, signedCmsSha1, pem, opaqueMessage, OPAQUE_SIGNED,
} from './helpers/test-certificates.mjs';
import { smimeVerify } from '../src/smime-verify.js';
import { makeTrust } from '../src/trust.js';
import { computeFingerprint } from '../src/certificate-utils.js';
import { saveTrusted, listTrusted, deleteTrusted } from '../src/key-storage.js';
import { bannerRows } from '../src/ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));

const BOB = 'bob@example.org';
const DAY = 86_400_000;
const MESSAGE = new TextEncoder().encode('Content-Type: text/plain; charset=utf-8\r\n\r\nThe minutes are attached.\r\n');

const tones = (status) => {
  const api = fakeApi({ translations: manifest.locales });
  return bannerRows(status, { t: (key, vars) => api.i18n.t(key, vars) }).map((row) => row.tone);
};
const verify = async (cms, from, trust) => (await smimeVerify(cms, from, trust)).status;

let code;
let ca;
let leaf;
let cms;

beforeAll(async () => {
  ca = await makeCa('Example Corp Mail CA');
  leaf = await makeLeaf(ca, { cn: 'Bob', emails: [BOB] });
  cms = await signedCms(MESSAGE, leaf);
  const out = await build({
    entryPoints: [path.join(here, '../src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    alias: { crypto: path.join(here, '../src/node-crypto-shim.js') },
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  });
  code = out.outputFiles[0].text;
}, 120_000);

beforeEach(() => { globalThis.indexedDB = fakeIndexedDB(); });

function plugin({ raw, config } = {}) {
  const ks = fakeKeystore([{ certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() }]);
  const api = fakeApi({
    id: 'smime',
    translations: manifest.locales,
    hostFeatures: { keystore: true },
    handlers: {
      ...ks.handlers,
      'jmap.fetchBlob': async () => raw,
      'config.get': async () => config ?? {},
      'ui.rerenderEmail': async () => {},
      'ui.setActions': async () => {},
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

/** Opens a signed mail from `from` and returns the stored verdict's rows. */
async function open(signed, from, options = {}) {
  const { api, hooks } = plugin({ raw: opaqueMessage(signed, from), ...options });
  const result = await hooks.onRenderEmailBody({ html: '', text: '' }, { id: 'mail-1', contentType: OPAQUE_SIGNED, blobId: 'raw', from: [{ email: from }] });
  const status = await api.storage.get('verify:mail-1');
  return { result, status, rows: bannerRows(status, { t: (k, v) => api.i18n.t(k, v) }) };
}

async function trustIssuer(issuer) {
  await saveTrusted({ id: `issuer-${issuer.der.length}-${Math.random()}`, kind: 'issuer', certificate: issuer.der.buffer.slice(0), fingerprint: await computeFingerprint(issuer.der) });
}

describe('a signer under a trusted issuer', () => {
  it('gets the trusted verdict when the user trusts the issuer', async () => {
    await trustIssuer(ca);
    const o = await open(cms, BOB);
    expect(o.result.text).toContain('The minutes are attached.');
    expect(o.rows).toEqual([expect.objectContaining({ tone: 'success', icon: 'shield-check', text: `Valid signature by ${BOB}` })]);
    expect(o.status).toMatchObject({ signerVerified: true, trustedVia: 'issuer', trustAnchor: 'CN=Example Corp Mail CA', trustReasons: [] });
  });

  it('gets the trusted verdict when the admin set the issuer, as PEM text in the plugin setting', async () => {
    const o = await open(cms, BOB, { config: { trustedIssuers: `${pem(ca.der)}` } });
    expect(o.rows.map((r) => r.tone)).toEqual(['success']);
  });

  it('reads the admin setting when the PEM text lost its line breaks in a one-line field', async () => {
    const oneLine = pem(ca.der).replace(/\n/g, '');
    const o = await open(cms, BOB, { config: { trustedIssuers: oneLine } });
    expect(o.rows.map((r) => r.tone)).toEqual(['success']);
  });

  it('loses the verdict on the next opening once the trusted issuer is removed', async () => {
    await trustIssuer(ca);
    expect((await open(cms, BOB)).rows.map((r) => r.tone)).toEqual(['success']);
    for (const r of await listTrusted()) await deleteTrusted(r.id);
    const again = await open(cms, BOB);
    expect(again.rows).toEqual([expect.objectContaining({ tone: 'warning', text: 'Signature matches, signer not verified' })]);
    expect(again.status.trustReasons).toEqual(['issuer']);
  });

  it('is not verified when the mail comes from another address than the certificate names', async () => {
    await trustIssuer(ca);
    const o = await open(cms, 'someone@example.org');
    expect(o.rows.map((r) => r.tone)).toEqual(['warning']);
    expect(o.status.trustReasons).toEqual(['from']);
  });

  it('is verified for any of the certificate\'s addresses, the subject\'s and the alternative names\'', async () => {
    const both = await makeLeaf(ca, { emails: ['first@example.org', 'second@example.org'], subjectEmail: 'third@example.org' });
    const signed = await signedCms(MESSAGE, both);
    const trust = makeTrust({ issuers: [ca.der] });
    for (const from of ['first@example.org', 'Second@Example.org', 'third@example.org']) {
      expect(tones(await verify(signed, from, trust)), from).toEqual(['success']);
    }
    expect(tones(await verify(signed, 'fourth@example.org', trust))).toEqual(['warning']);
  });

  it('is verified through an intermediate the message carries', async () => {
    const intermediate = await makeCa('Example Corp Issuing CA', { issuer: ca });
    const deep = await makeLeaf(intermediate, { emails: [BOB] });
    const trust = makeTrust({ issuers: [ca.der] });
    expect(tones(await verify(await signedCms(MESSAGE, deep, [intermediate.der]), BOB, trust))).toEqual(['success']);
    // Without the intermediate there is no path.
    expect(tones(await verify(await signedCms(MESSAGE, deep), BOB, trust))).toEqual(['warning']);
  });

  it('is not verified past a CA whose path length allows no intermediate below it', async () => {
    const strict = await makeCa('Strict Root', { pathLen: 0 });
    const intermediate = await makeCa('Below Strict', { issuer: strict });
    const deep = await makeLeaf(intermediate, { emails: [BOB] });
    const status = await verify(await signedCms(MESSAGE, deep, [intermediate.der]), BOB, makeTrust({ issuers: [strict.der] }));
    expect(tones(status)).toEqual(['warning']);
  });
});

describe('a signer the user trusts by certificate', () => {
  it('is verified without any issuer once the user trusts the certificate itself', async () => {
    const self = await makeLeaf(null, { emails: [BOB] });
    const signed = await signedCms(MESSAGE, self);
    expect((await open(signed, BOB)).rows.map((r) => r.tone)).toEqual(['warning']);
    await saveTrusted({ id: 's1', kind: 'signer', fingerprint: await computeFingerprint(self.der) });
    const o = await open(signed, BOB);
    expect(o.rows.map((r) => r.tone)).toEqual(['success']);
    expect(o.status.trustedVia).toBe('signer');
  });

  it('is verified when the user imported it by hand as a recipient certificate', async () => {
    const self = await makeLeaf(null, { emails: [BOB] });
    const { savePublicCert } = await import('../src/key-storage.js');
    await savePublicCert({ id: 'c1', email: BOB, certificate: self.der.buffer.slice(0), source: 'manual' });
    expect((await open(await signedCms(MESSAGE, self), BOB)).rows.map((r) => r.tone)).toEqual(['success']);
  });

  it('is not verified by a certificate that came from a signed mail', async () => {
    const self = await makeLeaf(null, { emails: [BOB] });
    const { savePublicCert } = await import('../src/key-storage.js');
    await savePublicCert({ id: 'c1', email: BOB, certificate: self.der.buffer.slice(0), source: 'signed-email' });
    expect((await open(await signedCms(MESSAGE, self), BOB)).rows.map((r) => r.tone)).toEqual(['warning']);
  });

  it('still needs the From address to be one of its addresses', async () => {
    const self = await makeLeaf(null, { emails: [BOB] });
    const trust = makeTrust({ pinned: [await computeFingerprint(self.der)] });
    const status = await verify(await signedCms(MESSAGE, self), 'someone@example.org', trust);
    expect(tones(status)).toEqual(['warning']);
    expect(status.trustReasons).toEqual(['from']);
  });
});

describe('a signer that is not verified even under a trusted issuer', () => {
  const trusted = () => makeTrust({ issuers: [ca.der] });

  it('an expired signer certificate (an invalid signature, not a verified one)', async () => {
    const old = await makeLeaf(ca, { emails: [BOB], notBefore: new Date(Date.now() - 60 * DAY), notAfter: new Date(Date.now() - DAY) });
    expect(tones(await verify(await signedCms(MESSAGE, old), BOB, trusted()))).toEqual(['destructive']);
  });

  it('an expired issuer', async () => {
    const lapsed = await makeCa('Lapsed CA', { notBefore: new Date(Date.now() - 60 * DAY), notAfter: new Date(Date.now() - DAY) });
    const under = await makeLeaf(lapsed, { emails: [BOB] });
    const status = await verify(await signedCms(MESSAGE, under), BOB, makeTrust({ issuers: [lapsed.der] }));
    expect(tones(status)).toEqual(['warning']);
    expect(status.trustReasons).toEqual(['issuer']);
  });

  it('an issuer certificate without the CA flag', async () => {
    const notCa = await makeCa('Not a CA', { ca: false });
    const under = await makeLeaf(notCa, { emails: [BOB] });
    expect(tones(await verify(await signedCms(MESSAGE, under), BOB, makeTrust({ issuers: [notCa.der] })))).toEqual(['warning']);
  });

  it('an issuer certificate whose key usage does not allow signing certificates', async () => {
    const noSign = await makeCa('No certificate signing', { keyUsage: ['digitalSignature', 'cRLSign'] });
    const under = await makeLeaf(noSign, { emails: [BOB] });
    expect(tones(await verify(await signedCms(MESSAGE, under), BOB, makeTrust({ issuers: [noSign.der] })))).toEqual(['warning']);
  });

  it('a signer certificate limited to server authentication', async () => {
    const server = await makeLeaf(ca, { emails: [BOB], eku: ['1.3.6.1.5.5.7.3.1'] });
    const status = await verify(await signedCms(MESSAGE, server), BOB, trusted());
    expect(tones(status)).toEqual(['warning']);
    expect(status.trustReasons).toEqual(['usage']);
  });

  it('a signer certificate whose key usage does not allow signing', async () => {
    const encryptOnly = await makeLeaf(ca, { emails: [BOB], keyUsage: ['keyAgreement'] });
    expect((await verify(await signedCms(MESSAGE, encryptOnly), BOB, trusted())).trustReasons).toEqual(['usage']);
  });

  it('a SHA-1 signature', async () => {
    const status = await verify(await signedCmsSha1(MESSAGE, leaf), BOB, trusted());
    expect(status.cryptoValid).toBe(true);
    expect(tones(status)).toEqual(['warning']);
    expect(status.trustReasons).toEqual(['digest']);
  });

  it('a signer certificate its issuer signed with SHA-1', async () => {
    const weak = await makeLeaf(ca, { emails: [BOB], hash: 'SHA-1' });
    const status = await verify(await signedCms(MESSAGE, weak), BOB, trusted());
    expect(tones(status)).toEqual(['warning']);
    expect(status.trustReasons).toEqual(['issuer', 'digest']);
  });

  it('a self-signed certificate the user put among the trusted issuers', async () => {
    const self = await makeLeaf(null, { emails: [BOB] });
    const status = await verify(await signedCms(MESSAGE, self), BOB, makeTrust({ issuers: [self.der] }));
    expect(tones(status)).toEqual(['warning']);
    expect(status.trustReasons).toEqual(['self']);
  });

  it('a certificate from a CA with the same name as the trusted one, but another key', async () => {
    const twin = await makeCa('Example Corp Mail CA');
    const under = await makeLeaf(twin, { emails: [BOB] });
    expect(tones(await verify(await signedCms(MESSAGE, under), BOB, trusted()))).toEqual(['warning']);
  });
});

describe('the details', () => {
  it('say what is not checked: revocation', async () => {
    const { signatureChecks } = await import('../src/ui.js');
    const t = (key) => key;
    const status = await verify(cms, BOB, makeTrust({ issuers: [ca.der] }));
    const texts = signatureChecks(status, t).map((c) => c.text);
    expect(texts).toContain('check.revocation');
    expect(texts).toContain('check.issuerTrusted');
  });
});
