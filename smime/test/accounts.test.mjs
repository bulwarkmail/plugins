// Every account signed in to the browser has its own S/MIME data: keys, recipient
// certificates, trusted issuers, trusted certificates and certificate choices carry the
// account (the host's account id with the server, from api.user.getAccounts). A record
// an older version wrote without an account goes to the first account that reads it,
// and to no other after that.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';
import { fakeKeystore } from './helpers/fake-keystore.mjs';
import { sortedIndexedDB } from './helpers/sorted-indexeddb.mjs';
import { makeCa, makeLeaf, signedCms, opaqueMessage, OPAQUE_SIGNED } from './helpers/test-certificates.mjs';
import { computeFingerprint } from '../src/certificate-utils.js';
import { importPkcs12 } from '../src/pkcs12.js';
import {
  setAccountResolver, savePublicCert, listPublicCerts, deletePublicCert, listKeyRecords, getKeyRecord, deleteKeyRecord,
  saveTrusted, listTrusted, deleteTrusted, saveChoice, getChoice,
} from '../src/key-storage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(path.join(here, '../manifest.json'), 'utf8'));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name));

const FIRST = { id: 'smime-test@one.example', serverUrl: 'https://one.example', label: 'First' };
const SECOND = { id: 'smime-test@two.example', serverUrl: 'https://two.example', label: 'Second' };
const BOB = 'bob@example.org';
const MESSAGE = new TextEncoder().encode('Content-Type: text/plain\r\n\r\nFrom Bob.\r\n');

let code;
let ca;
let bobCert;
let signedByBob;
let active;
let idb;

// What the plugin keys the stores by, for this file's own calls into key-storage.js.
const keyOf = (account) => `${account.id} ${account.serverUrl}`;
setAccountResolver(async () => (active ? keyOf(active) : null));

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(here, '../src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    alias: { crypto: path.join(here, '../src/node-crypto-shim.js') },
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  });
  code = out.outputFiles[0].text;
  ca = await makeCa('Example Corp Mail CA');
  bobCert = await makeLeaf(ca, { cn: 'Bob', emails: [BOB] });
  signedByBob = await signedCms(MESSAGE, bobCert);
}, 120_000);

beforeEach(() => {
  idb = sortedIndexedDB();
  globalThis.indexedDB = idb;
  active = FIRST;
});

/** The plugin while `account` is the open one. */
function plugin(account, raw) {
  const ks = fakeKeystore([{ certificate: fixture('cert.pem').toString(), key: fixture('key.pem').toString() }]);
  const sent = [];
  const api = fakeApi({
    id: 'smime',
    translations: manifest.locales,
    hostFeatures: { keystore: true },
    handlers: {
      ...ks.handlers,
      'user.getAccounts': async () => [FIRST, SECOND].map((a) => ({ ...a, isActive: a === account })),
      'jmap.sendRaw': async (bytes) => { sent.push(new Uint8Array(bytes)); },
      'jmap.fetchBlob': async () => raw,
      'ui.confirm': async () => true,
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
  return { api, sent, ...mod.exports };
}

const encryptTo = (hooks, to) => hooks.onComposeSend({
  identityId: 'identity', fromEmail: 'smime-test@example.com', to: [to], subject: 'Hi', textBody: 'Hi', sign: false, encrypt: true,
});
const certDer = () => bobCert.der.buffer.slice(bobCert.der.byteOffset, bobCert.der.byteOffset + bobCert.der.byteLength);

describe('a recipient certificate imported under one account', () => {
  it('is not used, listed or removed under another', async () => {
    active = FIRST;
    await savePublicCert({ id: 'bob', email: BOB, certificate: certDer(), source: 'manual' });
    expect(idb.rows('smime-plugin-store', 'public-certs')[0].accountId).toBe(keyOf(FIRST));

    active = SECOND;
    expect(await listPublicCerts()).toEqual([]);
    await deletePublicCert('bob');
    const second = plugin(SECOND);
    await expect(encryptTo(second.hooks, BOB)).resolves.toEqual({ abort: true });
    expect(second.sent).toHaveLength(0);
    expect(second.api.calls('toast.error').at(-1).args[0]).toContain(BOB);

    active = FIRST;
    expect((await listPublicCerts()).map((c) => c.id)).toEqual(['bob']);
    const first = plugin(FIRST);
    await expect(encryptTo(first.hooks, BOB)).resolves.toBe(false);
    expect(first.sent).toHaveLength(1);
  });

  it('is kept under the account that opened the signed mail it came from', async () => {
    active = FIRST;
    await saveTrusted({ id: 'ca', kind: 'issuer', certificate: ca.der.buffer.slice(0), fingerprint: await computeFingerprint(ca.der) });
    const first = plugin(FIRST, opaqueMessage(signedByBob, BOB));
    await first.hooks.onRenderEmailBody({ html: '', text: '' }, { id: 'm1', contentType: OPAQUE_SIGNED, blobId: 'raw', from: [{ email: BOB }] });
    expect((await listPublicCerts()).map((c) => c.email)).toEqual([BOB]);
    active = SECOND;
    expect(await listPublicCerts()).toEqual([]);
  });
});

describe('trusted issuers, trusted certificates and choices', () => {
  it('count only for the account that added them', async () => {
    active = FIRST;
    await saveTrusted({ id: 'ca', kind: 'issuer', certificate: ca.der.buffer.slice(0), fingerprint: await computeFingerprint(ca.der) });
    const open = async (account) => {
      const p = plugin(account, opaqueMessage(signedByBob, BOB));
      await p.hooks.onRenderEmailBody({ html: '', text: '' }, { id: 'm1', contentType: OPAQUE_SIGNED, blobId: 'raw', from: [{ email: BOB }] });
      return (await p.api.storage.get('verify:m1')).signerVerified;
    };
    expect(await open(FIRST)).toBe(true);
    expect(await open(SECOND)).toBe(false);

    active = SECOND;
    expect(await listTrusted()).toEqual([]);
    await deleteTrusted('ca');
    active = FIRST;
    expect((await listTrusted()).map((r) => r.id)).toEqual(['ca']);
  });

  it('keep a choice per account and address', async () => {
    active = FIRST;
    await saveChoice(BOB, 'aa', ['aa', 'bb']);
    active = SECOND;
    expect(await getChoice(BOB)).toBeUndefined();
    await saveChoice(BOB, 'bb', ['aa', 'bb']);
    active = FIRST;
    expect((await getChoice(BOB)).fingerprint).toBe('aa');
  });
});

describe('what an older version stored without an account', () => {
  async function seed() {
    const p12 = Uint8Array.from(fixture('test.p12'));
    const { keyRecord } = await importPkcs12(p12.buffer.slice(p12.byteOffset, p12.byteOffset + p12.byteLength), 'fixture', 'storage passphrase');
    idb.put('smime-plugin-store', 'key-records', 'id', keyRecord);
    idb.put('smime-plugin-store', 'public-certs', 'id', { id: 'bob', email: BOB, certificate: certDer(), source: 'manual' });
    return keyRecord;
  }

  it('goes to the account that reads it first, and is invisible to the other after that', async () => {
    const keyRecord = await seed();
    active = SECOND;
    expect((await listKeyRecords()).map((r) => r.id)).toEqual([keyRecord.id]);
    expect((await listPublicCerts()).map((c) => c.id)).toEqual(['bob']);

    active = FIRST;
    expect(await listKeyRecords()).toEqual([]);
    expect(await getKeyRecord(keyRecord.id)).toBeUndefined();
    expect(await listPublicCerts()).toEqual([]);
    await deleteKeyRecord(keyRecord.id);

    active = SECOND;
    expect((await listKeyRecords()).map((r) => r.id)).toEqual([keyRecord.id]);
    // Claiming added the account and changed nothing else: the wrapped key is as it was.
    const [row] = idb.rows('smime-plugin-store', 'key-records');
    expect(row).toEqual({ ...structuredClone(keyRecord), accountId: keyOf(SECOND) });
  });

  it('goes to the account the plugin sees first, through the plugin too', async () => {
    await seed();
    const second = plugin(SECOND);
    await expect(encryptTo(second.hooks, BOB)).resolves.toBe(false);
    const first = plugin(FIRST);
    await expect(encryptTo(first.hooks, BOB)).resolves.toEqual({ abort: true });
  });

  it('stays shared while the host names no account', async () => {
    await seed();
    active = null;
    expect(await listPublicCerts()).toHaveLength(1);
    expect(idb.rows('smime-plugin-store', 'public-certs')[0].accountId).toBeUndefined();
    active = FIRST;
    expect(await listPublicCerts()).toHaveLength(1);
  });
});
