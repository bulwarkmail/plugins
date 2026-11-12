/**
 * IndexedDB persistence for the S/MIME plugin.
 *
 * The privileged plugin runs in a same-origin iframe, so all of its iframes
 * (the hidden background instance that runs hooks + each visible slot) share
 * one IndexedDB. That's what lets the settings slot unlock a key and the
 * background send/receive hooks immediately use it.
 *
 * Three stores:
 *  - key-records:   encrypted-at-rest private keys + certs (durable)
 *  - public-certs:  recipient/contact public certificates (durable)
 *  - session-keys:  unlocked, NON-EXTRACTABLE CryptoKeys (session-scoped;
 *                   wiped on activate() at app boot and on logout)
 *
 * CryptoKey objects are structured-cloneable, so IndexedDB can persist the
 * unlocked handles without ever exposing the raw key material — a
 * non-extractable key stays non-extractable when read back. Only CryptoKeys
 * and bytes go in there: a webcrypto-liner key is a JS object and comes back
 * as a plain Object (see session-keys.js).
 *
 * What the user trusts (trust.js) lives in a database of its own,
 * smime-plugin-trust, so the stores above keep the version older releases
 * opened them with: a version change would wait for every tab that still
 * runs an older release to close.
 *  - trusted: { id, kind, fingerprint, certificate?, subject, issuer,
 *             notBefore, notAfter, emails?, addedAt }. kind 'issuer' is a
 *             trusted issuer (with its certificate), kind 'signer' a single
 *             trusted signer certificate, kept by fingerprint.
 *  - choices: the recipient certificate the user chose for an address.
 *
 * public-certs records carry `source`: 'manual' for one the user imported,
 * 'signed-email' for one taken from a signed message. The plugin stores the
 * latter only for a verified signer, with `chain` (the message's other
 * certificates). Every 'signed-email' record, including those versions 1.0
 * to 1.5 stored without any check, is used only when it verifies at send
 * time (index.js).
 */

import { classifyCapabilities, parseCertificateDer } from './certificate-utils.js';

const DB_NAME = 'smime-plugin-store';
const DB_VERSION = 1;
const KEY_RECORDS_STORE = 'key-records';
const PUBLIC_CERTS_STORE = 'public-certs';
const SESSION_KEYS_STORE = 'session-keys';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_RECORDS_STORE)) {
        const keyStore = db.createObjectStore(KEY_RECORDS_STORE, { keyPath: 'id' });
        keyStore.createIndex('email', 'email', { unique: false });
        keyStore.createIndex('accountId', 'accountId', { unique: false });
      }
      if (!db.objectStoreNames.contains(PUBLIC_CERTS_STORE)) {
        const certStore = db.createObjectStore(PUBLIC_CERTS_STORE, { keyPath: 'id' });
        certStore.createIndex('email', 'email', { unique: false });
        certStore.createIndex('accountId', 'accountId', { unique: false });
      }
      if (!db.objectStoreNames.contains(SESSION_KEYS_STORE)) {
        db.createObjectStore(SESSION_KEYS_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txPromise(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Accounts ────────────────────────────────────────────────────────
// The stores belong to the webmail's origin, not to an account, so every record
// except the session keys carries the account it belongs to (`accountId`).
// index.js says which account is open (setAccountResolver). With an account
// known, reads return that account's records only, writes set it, and a delete
// leaves another account's record alone. A record without an account (written
// by a version that kept none) goes to the first account that reads it, once,
// and is that account's from then on. Without an account (the host doesn't
// say), everything is shared as before and nothing is claimed.

let resolveAccount = async () => null;

export function setAccountResolver(fn) {
  resolveAccount = fn;
}

async function currentAccount() {
  try { return (await resolveAccount()) || null; } catch { return null; }
}

// The records of `all` that belong to `account`; unowned ones are claimed for it.
async function owned(db, storeName, all, account) {
  if (!account) return all.filter(Boolean);
  const mine = [];
  for (const record of all) {
    if (!record) continue;
    if (record.accountId === account) {
      mine.push(record);
    } else if (!record.accountId) {
      const claimed = { ...record, accountId: account };
      await txPromise(db, storeName, 'readwrite', (s) => s.put(claimed));
      mine.push(claimed);
    }
  }
  return mine;
}

async function putOwned(db, storeName, record) {
  const account = await currentAccount();
  const stored = account && !record.accountId ? { ...record, accountId: account } : record;
  await txPromise(db, storeName, 'readwrite', (s) => s.put(stored));
}

async function getOwned(db, storeName, id) {
  const record = await txPromise(db, storeName, 'readonly', (s) => s.get(id));
  return (await owned(db, storeName, [record], await currentAccount()))[0];
}

async function listOwned(db, storeName) {
  return owned(db, storeName, await txPromise(db, storeName, 'readonly', (s) => s.getAll()), await currentAccount());
}

async function deleteOwned(db, storeName, id) {
  if (!(await getOwned(db, storeName, id))) return;
  await txPromise(db, storeName, 'readwrite', (s) => s.delete(id));
}

// ── Key record CRUD ─────────────────────────────────────────────────

// What a key can do comes from its certificate on every load. Records saved
// before version 1.5 hold false for any certificate with a keyUsage extension.
function withCapabilities(record) {
  if (!record) return record;
  try {
    return { ...record, capabilities: classifyCapabilities(parseCertificateDer(record.certificate)) };
  } catch {
    return record;
  }
}

// A claimed key record is written back with the account added and nothing else
// changed: the wrapped private key stays as it is.
export async function saveKeyRecord(record) {
  const db = await openDB();
  await putOwned(db, KEY_RECORDS_STORE, record);
}

export async function getKeyRecord(id) {
  const db = await openDB();
  return withCapabilities(await getOwned(db, KEY_RECORDS_STORE, id));
}

export async function listKeyRecords() {
  const db = await openDB();
  return (await listOwned(db, KEY_RECORDS_STORE)).map(withCapabilities);
}

export async function deleteKeyRecord(id) {
  const db = await openDB();
  await deleteOwned(db, KEY_RECORDS_STORE, id);
}

// ── Public cert CRUD ────────────────────────────────────────────────

export async function savePublicCert(cert) {
  const db = await openDB();
  await putOwned(db, PUBLIC_CERTS_STORE, cert);
}

export async function listPublicCerts() {
  const db = await openDB();
  return listOwned(db, PUBLIC_CERTS_STORE);
}

export async function deletePublicCert(id) {
  const db = await openDB();
  await deleteOwned(db, PUBLIC_CERTS_STORE, id);
}

// ── Trusted issuers and trusted signer certificates ────────────────

const TRUST_DB_NAME = 'smime-plugin-trust';
const TRUST_DB_VERSION = 1;
const TRUSTED_STORE = 'trusted';
const CHOICES_STORE = 'choices';

function openTrustDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(TRUST_DB_NAME, TRUST_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TRUSTED_STORE)) db.createObjectStore(TRUSTED_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHOICES_STORE)) db.createObjectStore(CHOICES_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveTrusted(record) {
  const db = await openTrustDB();
  await putOwned(db, TRUSTED_STORE, record);
}

export async function listTrusted() {
  const db = await openTrustDB();
  return listOwned(db, TRUSTED_STORE);
}

export async function deleteTrusted(id) {
  const db = await openTrustDB();
  await deleteOwned(db, TRUSTED_STORE, id);
}

// ── Recipient certificate choices ───────────────────────────────────
// { id, accountId, email, fingerprint, among, at }: which certificate the user chose
// for an address at send time, and the candidates it was chosen among (fingerprints).
// The id holds the account, so each account keeps its own choice per address.

async function choiceId(email) {
  const account = await currentAccount();
  const address = String(email).toLowerCase();
  return account ? `${account}\n${address}` : address;
}

export async function getChoice(email) {
  const db = await openTrustDB();
  return getOwned(db, CHOICES_STORE, await choiceId(email));
}

export async function saveChoice(email, fingerprint, among) {
  const db = await openTrustDB();
  const id = await choiceId(email);
  await putOwned(db, CHOICES_STORE, { id, email: String(email).toLowerCase(), fingerprint, among, at: Date.now() });
}

// { id, accountId, email, fingerprint, accepted, at }: the user's answer, for one address
// and one certificate, on using a certificate that doesn't name that address.

export async function getAddressAnswer(email, fingerprint) {
  const db = await openTrustDB();
  return getOwned(db, CHOICES_STORE, `${await choiceId(email)}\n${String(fingerprint).toLowerCase()}`);
}

export async function saveAddressAnswer(email, fingerprint, accepted) {
  const db = await openTrustDB();
  const id = `${await choiceId(email)}\n${String(fingerprint).toLowerCase()}`;
  await putOwned(db, CHOICES_STORE, { id, email: String(email).toLowerCase(), fingerprint, accepted, at: Date.now() });
}

// ── Session (unlocked) key CRUD ─────────────────────────────────────
// Each entry: { id, format, usedAt, signingKey, decryptionKey?, sealedPkcs8? }
// sealedPkcs8 is { key, iv, data }, set for RSA keys (session-keys.js).
//
// The store is on disk with the browser profile, and for an RSA key it holds
// what rebuilds the key, so an unlocked key is protected by the device, not by
// its passphrase. It is kept short: an entry not used for SESSION_IDLE_MS is
// locked (deleted) when it is next read or swept, and index.js wipes the store
// when the page goes away, at sign-out, account switch and start.

// Older versions wrote entries without a format, holding a webcrypto-liner
// key that doesn't survive the store. Those count as locked, so the user gets
// the unlock prompt instead of a decrypt error. An entry without `usedAt`
// counts as idle.
const SESSION_FORMAT = 2;
export const SESSION_IDLE_MS = 30 * 60_000;

const idle = (entry) => typeof entry.usedAt !== 'number' || Date.now() - entry.usedAt > SESSION_IDLE_MS;

export async function saveSessionKeys(entry) {
  const db = await openDB();
  await txPromise(db, SESSION_KEYS_STORE, 'readwrite', (s) => s.put({ ...entry, format: SESSION_FORMAT, usedAt: Date.now() }));
}

export async function getSessionKeys(id) {
  const db = await openDB();
  const entry = await txPromise(db, SESSION_KEYS_STORE, 'readonly', (s) => s.get(id));
  if (!entry || entry.format !== SESSION_FORMAT) return undefined;
  if (idle(entry)) {
    await txPromise(db, SESSION_KEYS_STORE, 'readwrite', (s) => s.delete(id));
    return undefined;
  }
  return entry;
}

/** A sign or decrypt used the key: the idle time starts again. */
export async function markSessionKeysUsed(id) {
  const entry = await getSessionKeys(id);
  if (!entry) return;
  const db = await openDB();
  await txPromise(db, SESSION_KEYS_STORE, 'readwrite', (s) => s.put({ ...entry, usedAt: Date.now() }));
}

/** Deletes every entry that is idle too long (or locked anyway). Returns how many. */
export async function lockIdleSessionKeys() {
  const db = await openDB();
  let locked = 0;
  for (const entry of await txPromise(db, SESSION_KEYS_STORE, 'readonly', (s) => s.getAll())) {
    if (entry && (entry.format !== SESSION_FORMAT || idle(entry))) {
      await txPromise(db, SESSION_KEYS_STORE, 'readwrite', (s) => s.delete(entry.id));
      locked++;
    }
  }
  return locked;
}

export async function listSessionKeyIds() {
  const db = await openDB();
  const all = await txPromise(db, SESSION_KEYS_STORE, 'readonly', (s) => s.getAllKeys());
  return all;
}

export async function deleteSessionKeys(id) {
  const db = await openDB();
  await txPromise(db, SESSION_KEYS_STORE, 'readwrite', (s) => s.delete(id));
}

export async function clearSessionKeys() {
  const db = await openDB();
  await txPromise(db, SESSION_KEYS_STORE, 'readwrite', (s) => s.clear());
}
