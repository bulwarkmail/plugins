/**
 * S/MIME — privileged (same-origin) webmail plugin.
 *
 * Replaces the former native S/MIME pipeline with a sandboxed plugin that
 * runs all cryptography locally (bundled pkijs/asn1js/webcrypto-liner):
 *
 *   • onComposeSend   (intercept)  → build MIME, sign/encrypt, api.jmap.sendRaw
 *   • onRenderEmailBody (transform) → api.jmap.fetchBlob, decrypt/verify, replace body
 *   • composer Options menu         → per-message Sign / Encrypt check items
 *                                     (api.ui.setActions, src/compose-actions.js)
 *   • email-banner slot             → signature / encryption status
 *   • settings-section slot         → key import, unlock/lock, recipient certs
 *
 * Private keys are imported from PKCS#12, AES-GCM-wrapped under PBKDF2(600k),
 * and unlocked into NON-EXTRACTABLE WebCrypto keys held in a same-origin
 * IndexedDB session store shared between the background and slot iframes
 * (see session-keys.js for the RSA PKCS#1 v1.5 key).
 */

const host = require('@plugin-host');

import {
  buildMimeMessage, buildMimeEntity, wrapCmsAsSmimeMessage, wrapDetachedSignedMessage, base64Encode,
} from './mime-builder.js';
import { smimeSign, smimeSignDetached } from './smime-sign.js';
import { smimeEncrypt } from './smime-encrypt.js';
import { smimeVerify, smimeVerifyDetached } from './smime-verify.js';
import { smimeDecrypt, normalizeCmsBytes, SmimeKeyLockedError } from './smime-decrypt.js';
import { detectSmime } from './smime-detect.js';
import { parseMime, extractDetachedSigned } from './mime-parse.js';
import { importPkcs12, unlockPrivateKey } from './pkcs12.js';
import { parseCertificatePemOrDer, extractCertificateInfo } from './certificate-utils.js';
import { generateUUID } from './util.js';
import { makeUi } from './ui.js';
import { errorMessage, translator } from './i18n.js';
import {
  INTENT_KEY, publishComposeActions, resetComposeIntent, handleComposeAction,
} from './compose-actions.js';
import {
  saveKeyRecord, listKeyRecords, deleteKeyRecord,
  savePublicCert, listPublicCerts, deletePublicCert,
  saveSessionKeys, getSessionKeys, deleteSessionKeys, clearSessionKeys,
} from './key-storage.js';
import { unlockedDecryptMaps, forgetRebuiltKeys } from './session-keys.js';

const t = translator(host);

// ─── Shared preferences (api.storage; shared across iframes) ──────────

const PREFS_KEY = 'prefs.v1';
const VERIFY_PREFIX = 'verify:';

const DEFAULT_PREFS = { defaultSign: false, defaultEncrypt: false };

async function getPrefs() {
  try {
    const p = await host.storage.get(PREFS_KEY);
    return { ...DEFAULT_PREFS, ...(p || {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
async function setPrefs(next) {
  await host.storage.set(PREFS_KEY, next);
}

function settings() {
  return host.plugin?.settings || {};
}
function useAes128() {
  return settings().encryptionStrength === 'aes-128';
}
function useDetachedSignature() {
  // Also detached for installs that predate the setting.
  return settings().signatureFormat !== 'opaque';
}

// ─── Privileged-tier capability probe ─────────────────────────────────
// S/MIME needs in-frame `crypto.subtle` + IndexedDB, which exist only in the
// privileged (same-origin) tier. In the untrusted (null-origin) sandbox,
// `indexedDB.open` throws "The operation is insecure" and `crypto.subtle` is
// absent. We probe once and degrade with a clear message instead of letting a
// raw IndexedDB error crash activate() (which would trip the circuit breaker).
// This English text goes to the plugin log; users see settings.notPrivileged.

const NOT_PRIVILEGED_MSG =
  'S/MIME could not start: it is running in the restricted (untrusted) plugin ' +
  'sandbox, where in-browser cryptography and key storage are unavailable. ' +
  'This plugin must be delivered as a signed, admin-approved bundle with ' +
  '"tier": "privileged" so it loads in the same-origin tier. Contact your ' +
  'administrator.';

let _capable = null;
async function isCapable() {
  if (_capable !== null) return _capable;
  try {
    if (typeof indexedDB === 'undefined' || !(crypto && crypto.subtle)) throw new Error('missing apis');
    await new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open('smime-capability-probe'); }
      catch (e) { reject(e); return; }
      req.onsuccess = () => { try { req.result.close(); } catch { /* ignore */ } resolve(); };
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
      req.onblocked = () => resolve();
    });
    _capable = true;
  } catch {
    _capable = false;
  }
  return _capable;
}

// ─── Address helpers ──────────────────────────────────────────────────

function parseAddr(value) {
  if (value && typeof value === 'object' && value.email) {
    return { name: value.name || undefined, email: String(value.email) };
  }
  const s = String(value || '');
  // A leading segment is only a display name when it is actually followed by an
  // angle-bracketed address. Making the `<` optional (the old `<?`) let the name
  // group steal the first character of a BARE address — e.g. "root@rbm.systems"
  // parsed as name "r" + email "oot@rbm.systems", which then failed the S/MIME
  // key lookup for every normal send.
  const m = s.match(/^\s*(?:"?([^"<]*?)"?\s*<\s*)?([^<>\s]+@[^<>\s]+)\s*>?\s*$/);
  if (m) return { name: (m[1] || '').trim() || undefined, email: m[2] };
  return { email: s.trim() };
}
function addrList(arr) {
  if (!arr) return [];
  return (Array.isArray(arr) ? arr : [arr]).map(parseAddr).filter((a) => a.email);
}
function emailsOf(arr) {
  return addrList(arr).map((a) => a.email.toLowerCase());
}

// ─── Blob/bytes helpers ────────────────────────────────────────────────

async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
function bytesArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/** Wrap a CMS blob as a nested MIME entity (for sign-then-encrypt). */
function cmsInnerEntity(cmsBytes, smimeType) {
  const header = [
    `Content-Type: application/pkcs7-mime; smime-type=${smimeType}; name="smime.p7m"`,
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="smime.p7m"',
    '',
  ].join('\r\n');
  const b64 = base64Encode(bytesArrayBuffer(cmsBytes));
  return new TextEncoder().encode(header + '\r\n' + b64 + '\r\n');
}

// ─── Key resolution ────────────────────────────────────────────────────

async function signingKeyRecordForEmail(fromEmail) {
  const recs = await listKeyRecords();
  const lower = (fromEmail || '').toLowerCase();
  return (
    recs.find((r) => r.email === lower && r.capabilities?.canSign !== false) ||
    recs.find((r) => r.email === lower) ||
    undefined
  );
}

// Ensure a key's private material is unlocked in the session store. If it's
// locked, ask for the storage passphrase via a host popup and unlock it in
// place. Returns the unlocked session keys, or null if the user cancels or the
// passphrase is wrong (a wrong-passphrase toast is shown in the latter case).
async function ensureKeyUnlocked(keyRecord) {
  const existing = await getSessionKeys(keyRecord.id);
  if (existing && existing.signingKey) return existing;

  const answers = await host.ui.prompt({
    title: t('unlock.title'),
    message: keyRecord.email ? t('unlock.sendMessage', { email: keyRecord.email }) : t('unlock.sendMessageNoEmail'),
    confirmLabel: t('unlock.confirmSend'),
    fields: [
      { name: 'pass', label: t('unlock.passphrase'), type: 'password', required: true },
    ],
  });
  if (!answers) return null; // cancelled
  const pass = answers.pass || '';
  if (!pass) return null;

  try {
    const { signingKey, decryptionKey, sealedPkcs8 } = await unlockPrivateKey(keyRecord, pass);
    await saveSessionKeys({ id: keyRecord.id, signingKey, decryptionKey, sealedPkcs8 });
    return await getSessionKeys(keyRecord.id);
  } catch (err) {
    host.toast.error(err && err.message ? errorMessage(t, err) : t('unlock.failedWrongPassphrase'));
    return null;
  }
}

async function recipientCertsFor(emails) {
  const certs = await listPublicCerts();
  const found = [];
  const missing = [];
  for (const email of emails) {
    const c = certs.find((pc) => pc.email.toLowerCase() === email.toLowerCase());
    if (c) found.push(c.certificate);
    else missing.push(email);
  }
  return { found, missing };
}

// ─── Compose-send takeover ─────────────────────────────────────────────

async function resolveIntent(req) {
  const pick = (...vals) => {
    for (const v of vals) if (typeof v === 'boolean') return v;
    return undefined;
  };
  let sign = pick(req.sign, req.smimeSign, req.intent && req.intent.sign, req.smime && req.smime.sign);
  let encrypt = pick(req.encrypt, req.smimeEncrypt, req.intent && req.intent.encrypt, req.smime && req.smime.encrypt);

  if (sign === undefined && encrypt === undefined) {
    // Fall back to the Options menu's stored intent, then prefs.
    const stored = (await host.storage.get(INTENT_KEY)) || {};
    const prefs = await getPrefs();
    sign = typeof stored.sign === 'boolean' ? stored.sign : prefs.defaultSign;
    encrypt = typeof stored.encrypt === 'boolean' ? stored.encrypt : prefs.defaultEncrypt;
  }
  return { sign: !!sign, encrypt: !!encrypt };
}

async function fetchAttachments(req) {
  const list = req.attachments || [];
  const out = [];
  for (const att of list) {
    if (!att || !att.blobId) continue;
    try {
      const bytes = await host.jmap.fetchBlob(att.blobId, { name: att.name, type: att.type });
      out.push({
        filename: att.name || 'attachment',
        contentType: att.type || 'application/octet-stream',
        content: bytesArrayBuffer(bytes),
      });
    } catch (err) {
      host.log.warn('attachment fetch failed', att.name, err);
      throw new Error(t('send.attachmentFailed', { name: att.name || '' }));
    }
  }
  return out;
}

// onComposeSend outcomes: `false` tells the host "I sent it" (it deletes the
// draft and closes the composer); ABORT tells it nothing was sent, so it
// keeps the message open with its draft. Every refusal below shows the user
// why before returning ABORT.
const ABORT = { abort: true };

async function onComposeSend(req) {
  if (!req || typeof req !== 'object') return undefined;

  const { sign, encrypt } = await resolveIntent(req);
  if (!sign && !encrypt) return undefined; // not our job — host sends normally

  if (!(await isCapable())) {
    host.toast.error(t('send.notPrivileged'));
    return ABORT; // refuse rather than send plaintext when sign/encrypt was requested
  }

  try {
    const identityId = req.identityId || req.identity || '';
    if (!identityId) throw new Error(t('send.noIdentity'));

    const from = parseAddr(req.fromEmail || req.from || (addrList(req.from)[0] || {}).email || '');
    if (!from.email) throw new Error(t('send.noSender'));
    // The host passes the identity's display name separately (fromName). Without
    // it the From header is the bare address and recipients see only the local part.
    if (!from.name && typeof req.fromName === 'string' && req.fromName.trim()) from.name = req.fromName.trim();

    const to = addrList(req.to);
    const cc = addrList(req.cc);
    const bcc = addrList(req.bcc);
    const allRecipientEmails = [...emailsOf(req.to), ...emailsOf(req.cc), ...emailsOf(req.bcc)];

    const keyRecord = (sign || encrypt) ? await signingKeyRecordForEmail(from.email) : undefined;
    if ((sign || encrypt) && !keyRecord) {
      host.toast.error(t('send.noKey', { email: from.email }));
      return ABORT;
    }

    // Build the inner MIME message from the draft.
    const attachments = await fetchAttachments(req);
    const mimeInput = {
      from,
      to,
      cc,
      subject: req.subject || '',
      textBody: req.textBody || req.text || '',
      htmlBody: req.htmlBody || req.html || '',
      inReplyTo: req.inReplyTo,
      references: req.references,
      attachments,
    };

    let rfc822;
    if (sign && !encrypt && useDetachedSignature()) {
      // multipart/signed stays readable in clients without S/MIME.
      const session = await ensureKeyUnlocked(keyRecord);
      if (!session || !session.signingKey) {
        host.toast.error(t('send.keyLocked'));
        return ABORT; // refuse rather than send unsigned
      }
      const entityBytes = buildMimeEntity(mimeInput);
      const signatureDer = await smimeSignDetached(
        entityBytes,
        session.signingKey,
        keyRecord.certificate,
        keyRecord.certificateChain || [],
      );
      rfc822 = wrapDetachedSignedMessage(entityBytes, signatureDer, mimeInput);
    } else {
      rfc822 = await buildOpaqueMessage(mimeInput, { sign, encrypt, keyRecord, allRecipientEmails });
      if (!rfc822) return ABORT; // buildOpaqueMessage already told the user why
    }
    const rawBytes = await blobToBytes(rfc822);

    const envelopeRecipients = [...new Set([...allRecipientEmails])];
    // Pass a scheduled send's time through, so it is not sent right away.
    const sendOpts = { envelopeRecipients };
    if (req.delayedUntil) sendOpts.delayedUntil = req.delayedUntil;
    await host.jmap.sendRaw(bytesArrayBuffer(rawBytes), identityId, sendOpts);

    const how = encrypt && sign ? 'signedEncrypted'
      : encrypt ? 'encrypted'
        : useDetachedSignature() ? 'signedDetached' : 'signedOpaque';
    host.toast.success(t(`${req.delayedUntil ? 'scheduled' : 'sent'}.${how}`));
    // Clear the per-message intent so the next compose starts from defaults.
    // The mail is already out, so a storage error must not turn into an abort.
    await host.storage.set(INTENT_KEY, {}).catch((err) => host.log.warn('clearing send intent failed', err));
    void publishComposeActions(host, composeDeps).catch(() => {});
    return false; // we handled the send
  } catch (err) {
    host.log.error('onComposeSend failed', err);
    host.toast.error(t('send.failed', { error: errorMessage(t, err) }));
    return ABORT; // nothing was sent: keep the draft, and never fall back to plaintext
  }
}

/** Opaque sign and/or encrypt. Returns the message Blob, or null to refuse the send. */
async function buildOpaqueMessage(mimeInput, { sign, encrypt, keyRecord, allRecipientEmails }) {
  let payloadBytes = buildMimeMessage(mimeInput);

  // 1. Sign (opaque). If we'll also encrypt, nest the signed CMS as a MIME entity.
  if (sign) {
    // Locked keys are normally unlocked in onBeforeEmailSend. This is a
    // fallback for that path not having run; cancelling here keeps the draft.
    const session = await ensureKeyUnlocked(keyRecord);
    if (!session || !session.signingKey) {
      host.toast.error(t('send.keyLocked'));
      return null; // refuse rather than send unsigned
    }
    const signedBlob = await smimeSign(
      payloadBytes,
      session.signingKey,
      keyRecord.certificate,
      keyRecord.certificateChain || [],
    );
    const signedBytes = await blobToBytes(signedBlob);
    payloadBytes = encrypt ? cmsInnerEntity(signedBytes, 'signed-data') : signedBytes;
  }

  // 2. Encrypt (envelope). Always includes the sender cert so Sent is readable.
  let smimeType = sign ? 'signed-data' : null;
  if (encrypt) {
    const { found, missing } = await recipientCertsFor(allRecipientEmails);
    if (missing.length > 0) {
      host.toast.error(t('send.missingCertificates', { emails: missing.join(', ') }));
      return null;
    }
    const envBlob = await smimeEncrypt(payloadBytes, found, keyRecord.certificate, useAes128());
    payloadBytes = await blobToBytes(envBlob);
    smimeType = 'enveloped-data';
  }

  // 3. Wrap as RFC822.
  return wrapCmsAsSmimeMessage(payloadBytes, { ...mimeInput, smimeType });
}

// ─── Render-body takeover (verify / decrypt) ───────────────────────────

async function maybeAutoImportSigner(status) {
  if (settings().autoImportSignerCerts === false) return;
  const cert = status && status.signerCert;
  if (!cert || !status.signatureValid || !cert.email) return;
  try {
    const existing = (await listPublicCerts()).some((c) => c.fingerprint === cert.fingerprint);
    if (!existing) {
      await savePublicCert({
        id: generateUUID(),
        email: cert.email,
        certificate: cert.certificate,
        issuer: cert.issuer,
        subject: cert.subject,
        notBefore: cert.notBefore,
        notAfter: cert.notAfter,
        fingerprint: cert.fingerprint,
        source: 'signed-email',
      });
    }
  } catch (err) {
    host.log.warn('auto-import signer cert failed', err);
  }
}

async function persistVerifyStatus(emailId, status) {
  if (!emailId) return;
  try { await host.storage.set(VERIFY_PREFIX + emailId, status); } catch { /* ignore */ }
}

async function onRenderEmailBody(body, ctx) {
  if (!ctx) return undefined;
  if (!(await isCapable())) return undefined; // can't decrypt/verify without the privileged tier

  const detection = detectSmime(ctx.contentType, ctx.bodyStructure, ctx.attachments);
  if (!detection.type) return undefined;

  if (!detection.supported) {
    const status = {
      isSigned: detection.type === 'detached-sig',
      isEncrypted: false,
      unsupportedReason: `Unsupported S/MIME type (${detection.type})`,
    };
    await persistVerifyStatus(ctx.id, status);
    return undefined; // let the host render the original body
  }

  const fromEmail = (addrList(ctx.from)[0] || {}).email;

  if (detection.type === 'detached-sig') {
    // Verify against the raw message — the host's decoded parts are not byte-exact.
    if (!ctx.blobId) return undefined;
    let raw;
    try {
      raw = await host.jmap.fetchBlob(ctx.blobId);
    } catch (err) {
      host.log.error('failed to fetch the signed message', err);
      return undefined; // transient; don't record a verdict
    }
    // A broken signature must read as invalid, not as a neutral "Signed message".
    const invalid = (signatureError) => persistVerifyStatus(ctx.id, {
      isSigned: true,
      isEncrypted: false,
      signatureValid: false,
      signatureError,
    });
    try {
      const signed = extractDetachedSigned(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
      if (!signed) {
        await invalid('Malformed multipart/signed message');
        return undefined;
      }
      const v = await smimeVerifyDetached(signed.signatureDer, signed.entityBytes, fromEmail);
      v.status.format = 'detached';
      await maybeAutoImportSigner(v.status);
      const parsed = parseMime(v.mimeBytes);
      await persistVerifyStatus(ctx.id, v.status);
      return {
        ...body,
        handledBy: 'smime',
        html: parsed.html || '',
        text: parsed.text || '',
        attachments: parsed.attachments,
        verification: v.status,
      };
    } catch (err) {
      host.log.error('detached signature verification failed', err);
      await invalid(err && err.message ? err.message : String(err));
      return undefined; // the body is readable without us
    }
  }

  const blobId = detection.blobId || ctx.blobId;
  if (!blobId) return undefined;

  try {
    const raw = await host.jmap.fetchBlob(blobId);
    const der = normalizeCmsBytes(bytesArrayBuffer(raw instanceof Uint8Array ? raw : new Uint8Array(raw)));

    if (detection.type === 'enveloped-data') {
      const keys = await unlockedDecryptMaps();
      let result;
      try {
        result = await smimeDecrypt({ cmsBytes: der, ...keys });
      } catch (err) {
        // Single-banner UX: on failure we surface the status ONLY through the
        // email-banner slot (which reads the persisted verification), and leave
        // the body empty rather than stacking a second in-body notice box.
        if (err instanceof SmimeKeyLockedError) {
          const status = { isEncrypted: true, decryptionSuccess: false, decryptionError: 'locked' };
          await persistVerifyStatus(ctx.id, status);
          return { ...body, handledBy: 'smime', html: '', text: '', attachments: [], verification: status };
        }
        host.log.warn('S/MIME decrypt failed', err);
        const status = { isEncrypted: true, decryptionSuccess: false, decryptionError: err && err.message ? err.message : String(err) };
        await persistVerifyStatus(ctx.id, status);
        return { ...body, handledBy: 'smime', html: '', text: '', attachments: [], verification: status };
      }

      // Decrypted inner content may itself be a signed CMS — either nested as a
      // MIME entity (RFC 8551 sign-then-encrypt, the Outlook/Thunderbird form)
      // or, more rarely, raw CMS DER. Detect both.
      let innerBytes = result.mimeBytes;
      const verification = { isEncrypted: true, decryptionSuccess: true };
      const innerCt = innerContentType(innerBytes);
      const innerDet = detectSmime(innerCt, null, null);
      const looksSigned = innerDet.type === 'signed-data' || innerBytes[0] === 0x30;
      if (looksSigned) {
        try {
          const signedDer = normalizeCmsBytes(bytesArrayBuffer(innerBytes));
          const v = await smimeVerify(signedDer, fromEmail);
          v.status.format = 'opaque';
          innerBytes = v.mimeBytes;
          Object.assign(verification, v.status, { isEncrypted: true, decryptionSuccess: true });
          await maybeAutoImportSigner(v.status);
        } catch { /* not actually signed; keep decrypted content as-is */ }
      }

      const parsed = parseMime(innerBytes);
      await persistVerifyStatus(ctx.id, verification);
      return {
        ...body,
        handledBy: 'smime',
        html: parsed.html || '',
        text: parsed.text || '',
        attachments: parsed.attachments,
        verification,
      };
    }

    if (detection.type === 'signed-data') {
      const v = await smimeVerify(der, fromEmail);
      v.status.format = 'opaque';
      await maybeAutoImportSigner(v.status);
      const parsed = parseMime(v.mimeBytes);
      await persistVerifyStatus(ctx.id, v.status);
      return {
        ...body,
        handledBy: 'smime',
        html: parsed.html || '',
        text: parsed.text || '',
        attachments: parsed.attachments,
        verification: v.status,
      };
    }
  } catch (err) {
    host.log.error('onRenderEmailBody failed', err);
    return undefined; // fall back to host rendering on unexpected failure
  }

  return undefined;
}

// Sniff the Content-Type of an inner MIME entity (first headers only).
function innerContentType(bytes) {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048));
  const m = head.match(/content-type:\s*([^\r\n]+)/i);
  return m ? m[1].trim() : '';
}

// ─── UI ────────────────────────────────────────────────────────────────

const composeDeps = { getPrefs, listKeyRecords, detached: useDetachedSignature };

const { EmailBanner, SettingsSection } = makeUi(host, {
  VERIFY_PREFIX, DEFAULT_PREFS, NOT_PRIVILEGED_MSG,
  settings, isCapable, getPrefs, setPrefs, detectSmime, ensureKeyUnlocked,
  listKeyRecords, saveKeyRecord, deleteKeyRecord, getSessionKeys, saveSessionKeys, deleteSessionKeys,
  listPublicCerts, savePublicCert, deletePublicCert,
  importPkcs12, unlockPrivateKey, parseCertificatePemOrDer, extractCertificateInfo, generateUUID,
  // The settings page runs in its own iframe; it republishes the composer's
  // Options entries so a newly imported key makes Sign / Encrypt usable.
  onKeysChanged: () => publishComposeActions(host, composeDeps),
});

// ─── Exports ───────────────────────────────────────────────────────────

// Before a send commits: if the user is signing but their key is locked,
// prompt to unlock it here rather than failing mid-send in onComposeSend.
// Returning false aborts the send cleanly — the draft and open composer are
// preserved — so a cancelled unlock never loses the message.
async function onBeforeEmailSend(email) {
  try {
    if (!email || typeof email !== 'object') return true;
    if (!(await isCapable())) return true;
    // Resolve the sign intent the way onComposeSend does: the Options menu's
    // stored intent, falling back to prefs. (Encrypt needs no private key.)
    const stored = (await host.storage.get(INTENT_KEY)) || {};
    const prefs = await getPrefs();
    const sign = typeof stored.sign === 'boolean' ? stored.sign : prefs.defaultSign;
    if (!sign) return true;

    const from = parseAddr(email.fromEmail || email.from || '');
    if (!from.email) return true;
    const keyRecord = await signingKeyRecordForEmail(from.email);
    if (!keyRecord) return true; // onComposeSend surfaces the "no key" message

    const session = await getSessionKeys(keyRecord.id);
    if (session && session.signingKey) return true; // already unlocked

    const unlocked = await ensureKeyUnlocked(keyRecord);
    return !!(unlocked && unlocked.signingKey); // false → cancelled/failed → abort send
  } catch (err) {
    host.log.warn('onBeforeEmailSend unlock check failed', err);
    return true; // never block a send on an unexpected error here
  }
}

export const hooks = {
  onBeforeEmailSend,
  onComposeSend,
  onRenderEmailBody,
  // Wipe unlocked keys from the shared session store on sign-out / account switch.
  async onAfterLogout() {
    if (settings().lockOnLogout === false) return;
    forgetRebuiltKeys();
    try { await clearSessionKeys(); } catch (err) { host.log.warn('clearSessionKeys failed', err); }
  },
  async onAccountSwitch() {
    if (settings().lockOnLogout === false) return;
    forgetRebuiltKeys();
    try { await clearSessionKeys(); } catch (err) { host.log.warn('clearSessionKeys failed', err); }
  },
  // Each new message starts with Sign / Encrypt as set under "Defaults for
  // new messages".
  async onComposerOpen() {
    if (!(await isCapable())) return;
    await resetComposeIntent(host, composeDeps);
  },
  async onAction(click) {
    if (!(await isCapable())) return;
    await handleComposeAction(host, composeDeps, click || {});
  },
};

export const slots = {
  'email-banner': { component: EmailBanner, order: 20 },
  'settings-section': { component: SettingsSection, order: 100 },
};

export async function activate(api) {
  // Bail out gracefully if we're not in the privileged (same-origin) tier — do
  // NOT throw, or the circuit breaker disables the plugin after a raw IDB error.
  if (!(await isCapable())) {
    api.log.error(NOT_PRIVILEGED_MSG);
    try { api.toast.error(api.i18n.t('activate.notPrivileged')); } catch { /* ignore */ }
    return;
  }
  // Enforce session scope for unlocked keys: wipe any left over from a prior
  // app session at boot (mirrors the native "in-memory, cleared on reload").
  forgetRebuiltKeys();
  try { await clearSessionKeys(); } catch (err) { api.log.warn('S/MIME: clearSessionKeys failed', err); }
  let keyCount = 0;
  try { keyCount = (await listKeyRecords()).length; } catch (err) { api.log.warn('S/MIME: listKeyRecords failed', err); }
  try { await publishComposeActions(api, composeDeps); } catch (err) { api.log.warn('S/MIME: setActions failed', err); }
  // The Options entries carry translated labels: redraw them in the new language.
  api.i18n.onLocaleChange?.(() => { void publishComposeActions(api, composeDeps).catch(() => {}); });
  api.log.info(`S/MIME plugin activated (${keyCount} key${keyCount === 1 ? '' : 's'} imported)`);
}
