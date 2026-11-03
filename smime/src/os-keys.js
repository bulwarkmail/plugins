/**
 * Keys in the operating system's store: Windows CurrentUser\My, the macOS keychain
 * and smart cards, through api.keystore in the desktop app. The private key stays
 * in the OS. All this plugin ever holds is the certificate and an id.
 *
 * An OS key becomes a virtual key record, shaped like an imported one so the sign
 * and decrypt paths can take either. It lives in memory, per frame, and never
 * reaches IndexedDB. Its "private key" is a handle that says how to ask the OS.
 *
 * Nothing here calls list() on its own: every list can bring up the shell's consent
 * dialog, so it waits until the settings page opens or a message needs a key.
 *
 * A list has the ordinary 30 s RPC timeout and holds no hook timer (key operations
 * do). If the consent dialog takes longer the call times out here, and the answer
 * still counts for the next call: asking again joins the dialog already on screen.
 */

import { parseCertificateDer, extractCertificateInfo } from './certificate-utils.js';

const CHANNEL = 'smime-os-keys';
// Windows of 30 s each. A send can wait this long for an answer to the consent dialog.
const LIST_TRIES = 10;

/** The code of an error from api.keystore ('cancelled', 'unsupported', ...), or null. */
export function keystoreCode(err) {
  return /keystore:([a-z-]+)/.exec(err && err.message ? err.message : String(err))?.[1] ?? null;
}

/** Nothing left to try on this code: the user said no, it's busy, or it's our own bug. */
export function keystoreStops(code) {
  return code === 'cancelled' || code === 'locked' || code === 'invalid';
}

function toBuffer(bytes) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** A key record from what api.keystore.list() says about a certificate. */
export async function osKeyRecord(entry) {
  const certificate = toBuffer(entry.certificate);
  const info = await extractCertificateInfo(parseCertificateDer(certificate), certificate);
  const emails = info.emailAddresses.map((email) => email.toLowerCase());
  const signSchemes = entry.signSchemes ?? [];
  const decryptSchemes = entry.decryptSchemes ?? [];
  const canAgree = entry.canAgree === true;
  return {
    id: `os:${entry.id}`,
    source: 'os',
    osKeyId: entry.id,
    osSource: entry.source,
    email: emails[0] ?? '',
    emails,
    certificate,
    certificateChain: (entry.chain ?? []).map(toBuffer),
    issuer: info.issuer,
    subject: info.subject,
    serialNumber: info.serialNumber,
    notBefore: info.notBefore,
    notAfter: info.notAfter,
    fingerprint: info.fingerprint,
    algorithm: info.algorithm,
    keyType: entry.keyType,
    signSchemes,
    decryptSchemes,
    // The helper knows the key's real uses; the certificate's only claim them. An EC
    // key without key agreement can't open mail: that's the "signing only" in the UI.
    capabilities: {
      canSign: signSchemes.length > 0,
      canEncrypt: entry.keyType === 'ec' ? canAgree : decryptSchemes.length > 0,
    },
  };
}

function isExpired(record) {
  return new Date(record.notAfter).getTime() < Date.now();
}

/**
 * The keys for a sender. `signing` is in the order to try them: OS keys first, then
 * imported ones. An OS key that's expired, or whose use the user just cancelled, comes
 * after the imported ones, so a retry doesn't run into the same dialog when there's
 * another way. `encrypting` gives the certificate for the sender's own copy: it has to
 * be one that can open mail, which on a smart card is often not the signing one.
 *
 * An imported record's capabilities aren't a reason to skip it: any certificate with
 * a keyUsage extension reads as false there (certificate-utils.js gets a BitString
 * where it expects flags), and that's stored in the record.
 */
export function senderKeys(email, imported, os, signCancelled = () => false) {
  const lower = (email || '').toLowerCase();
  const ownOs = os.filter((r) => r.emails.includes(lower));
  const ownImported = imported.filter((r) => r.email === lower);
  const osSigners = ownOs.filter((r) => r.capabilities.canSign);
  const first = osSigners.filter((r) => !isExpired(r) && !signCancelled(r.id));
  const signing = [
    ...first,
    ...ownImported.filter((r) => r.capabilities?.canSign !== false),
    ...ownImported.filter((r) => r.capabilities?.canSign === false),
    ...osSigners.filter((r) => !first.includes(r)),
  ];
  const encrypting = ownOs.find((r) => r.capabilities.canEncrypt) ?? ownImported[0] ?? ownOs[0];
  return { signing, encrypting };
}

/**
 * RSA signs PKCS#1 v1.5, which Outlook needs. PSS only when the key says it has
 * nothing else, which is what a certificate for id-RSASSA-PSS reports.
 */
function signAlgorithm(record) {
  if (record.keyType === 'ec') return { name: 'ECDSA', scheme: 'ecdsa' };
  return record.signSchemes.includes('rsa-pkcs1')
    ? { name: 'RSASSA-PKCS1-v1_5', scheme: 'rsa-pkcs1' }
    : { name: 'RSA-PSS', scheme: 'rsa-pss' };
}

/** The OS keys for one frame. `host` is the plugin api. */
export function createOsKeys(host) {
  let records = null; // null: not known yet
  let state = 'idle';
  let loading = null;
  let lateHooked = false;
  const signCancelled = new Set();

  const keystore = () => (host.host?.features?.keystore === true && host.keystore ? host.keystore : null);

  function forget() {
    records = null;
    state = 'idle';
    signCancelled.clear();
  }

  // Each frame has its own list. The settings page's "check again" counts for the
  // hidden frame that signs and decrypts too.
  let channel = null;
  function ensureChannel() {
    if (channel || typeof BroadcastChannel === 'undefined') return;
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = forget;
    channel.unref?.();
  }

  const answer = () => ({ records: records ?? [], state });

  async function ask(ks) {
    let entries;
    try {
      entries = await ks.list();
    } catch (err) {
      const code = keystoreCode(err);
      if (code === 'cancelled') {
        // A Deny lasts until the app quits: no point in asking the shell again.
        records = [];
        state = 'denied';
      } else if (code === 'unsupported') {
        records = [];
        state = 'unsupported';
      } else if (code === 'locked') {
        state = 'busy';
      } else {
        // The RPC timeout has no code. The dialog may well still be up.
        state = code === null && /timed out/i.test(err?.message ?? '') ? 'pending' : 'failed';
        if (state === 'failed') host.log?.warn?.('S/MIME: reading the system store failed', err);
      }
      return answer();
    }
    const built = [];
    for (const entry of entries) {
      // One certificate we can't read shouldn't hide the others.
      try { built.push(await osKeyRecord(entry)); } catch (err) { host.log?.warn?.('S/MIME: skipping a system certificate', err); }
    }
    records = built;
    state = 'ready';
    return answer();
  }

  /** The list, asking the shell once. Never rejects: see `state`. */
  function load() {
    if (loading) return loading;
    if (records) return Promise.resolve(answer());
    const ks = keystore();
    if (!ks) return Promise.resolve({ records: [], state: 'off' });
    ensureChannel();
    loading = ask(ks).finally(() => { loading = null; });
    return loading;
  }

  /** The list, waiting for a slow answer to the consent dialog. For a send or the settings page. */
  async function loadPatiently() {
    let result = await load();
    for (let i = 1; i < LIST_TRIES && result.state === 'pending'; i++) result = await load();
    return result;
  }

  /**
   * The list, or state 'pending' after `ms`. A render hook has a 5 s budget and a list
   * holds no timer, so it can't wait for the user. `onLate` runs once when the answer
   * arrives after all.
   */
  async function loadWithin(ms, onLate) {
    const running = load();
    let timer;
    const first = await Promise.race([running, new Promise((resolve) => { timer = setTimeout(resolve, ms, null); })]);
    clearTimeout(timer);
    if (first) return first;
    if (!lateHooked) {
      lateHooked = true;
      void running.then(() => { lateHooked = false; onLate(); });
    }
    return { records: [], state: 'pending' };
  }

  /** Asks again, and tells this plugin's other frames to do so when they next need it. */
  function refresh() {
    forget();
    ensureChannel();
    channel?.postMessage('changed');
    return loadPatiently();
  }

  // A card pulled out makes the list stale. A PIN cancelled on a signature is remembered for senderKeys.
  async function tracked(call, onCancel) {
    try {
      return await call();
    } catch (err) {
      const code = keystoreCode(err);
      if (code === 'not-found') records = null;
      if (code === 'cancelled') onCancel?.();
      throw err;
    }
  }

  /** What smime-sign.js signs with. pkijs reads only `algorithm`, and the engine asks `keystore.sign`. */
  function signingHandle(record) {
    const { name, scheme } = signAlgorithm(record);
    return {
      type: 'private',
      extractable: false,
      usages: ['sign'],
      algorithm: { name, hash: { name: 'SHA-256' } },
      keystore: {
        sign: (digest, hash) => tracked(
          () => keystore().sign(record.osKeyId, digest, { scheme, hash }),
          () => signCancelled.add(record.id),
        ),
      },
    };
  }

  function decryptionHandle(record) {
    return {
      type: 'private',
      extractable: false,
      usages: ['decrypt'],
      algorithm: { name: record.keyType === 'ec' ? 'ECDH' : 'RSA-OAEP' },
      keystore: {
        decrypt: (data, scheme) => tracked(() => keystore().decrypt(record.osKeyId, data, scheme)),
        agree: (peerSpki) => tracked(() => keystore().agree(record.osKeyId, peerSpki)),
      },
    };
  }

  /** session-keys.js' decrypt maps with the OS keys that can open mail added. */
  function addDecryptKeys(maps, list) {
    const usable = list.filter((r) => r.capabilities.canEncrypt);
    return {
      ...maps,
      keyRecords: [...maps.keyRecords, ...usable],
      keystoreKeys: new Map(usable.map((r) => [r.id, decryptionHandle(r)])),
    };
  }

  return {
    available: () => keystore() !== null,
    /** What's known so far, without asking. */
    known: () => (keystore() ? records ?? [] : []),
    /** There could be OS keys, but nobody has looked yet. */
    unasked: () => keystore() !== null && records === null,
    load,
    loadPatiently,
    loadWithin,
    refresh,
    forget,
    signCancelled: (id) => signCancelled.has(id),
    signingHandle,
    addDecryptKeys,
  };
}
