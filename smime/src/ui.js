// The plugin's own UI, drawn with the app's UI kit:
//   - EmailBanner: signature / encryption status as reader info bars
//   - SettingsSection: key import, unlock/lock, recipient certificates,
//     defaults for new messages
// Sign / Encrypt in the composer are Options menu items (compose-actions.js).
//
// Built from a factory so tests can hand in a fake host and fake key storage;
// src/index.js passes the real ones. Every visible string comes from the
// manifest's locales through `t` (api.i18n.t).

import * as React from 'react';
import {
  Alert, BarButton, Button, EmptyState, Icon, InfoBar, List, ListRow, Badge,
  Row, RowAction, Section, SettingRow, Stack, Switch, Text,
} from '@plugin-host/ui';
import { errorMessage, errorText, localeOf, translator } from './i18n.js';

const h = React.createElement;
const { useState, useEffect, useCallback, useRef } = React;

export function fmtDate(iso, locale) {
  try { return new Date(iso).toLocaleDateString(locale); } catch { return iso; }
}
export function fmtDateTime(iso, locale) {
  try { return new Date(iso).toLocaleString(locale); } catch { return iso; }
}
export function isExpired(iso) {
  try { return new Date(iso).getTime() < Date.now(); } catch { return false; }
}

// Checks behind the signature verdict. Older persisted statuses lack some fields; those are skipped.
export function signatureChecks(status, t, locale) {
  const checks = [];
  const cert = status.signerCert;
  if (!cert) {
    checks.push({ tone: 'bad', text: status.signatureError ? errorText(t, status.signatureError) : t('check.noSignerCertificate') });
    return checks;
  }
  if (status.cryptoValid === true) {
    checks.push({ tone: 'ok', text: t('check.unchanged') });
  } else if (status.cryptoValid === false) {
    checks.push({
      tone: 'bad',
      text: status.verifyError
        ? t('check.verifyFailed', { error: errorText(t, status.verifyError) })
        : t('check.changed'),
    });
  }
  // Older statuses lack certExpired/certNotYetValid; work them out from the dates
  // like verifyStatus does, rather than calling an expired certificate valid.
  const certExpired = status.certExpired ?? isExpired(cert.notAfter);
  const certNotYetValid = status.certNotYetValid ?? new Date(cert.notBefore).getTime() > Date.now();
  if (certExpired) checks.push({ tone: 'bad', text: t('check.expired', { date: fmtDateTime(cert.notAfter, locale) }) });
  else if (certNotYetValid) checks.push({ tone: 'bad', text: t('check.notYetValid', { date: fmtDateTime(cert.notBefore, locale) }) });
  else checks.push({ tone: 'ok', text: t('check.validUntil', { date: fmtDate(cert.notAfter, locale) }) });

  // Without a chain check anyone can mint a certificate for any address, so say
  // what the certificate claims, not who it belongs to.
  if (status.signerEmailMatch === true) {
    checks.push({ tone: 'ok', text: t('check.senderMatch', { email: cert.email }) });
  } else if (status.signerEmailMatch === false) {
    checks.push({
      tone: 'warn',
      text: cert.email && status.fromEmail
        ? t('check.senderMismatch', { signer: cert.email, from: status.fromEmail })
        : t('check.senderMismatchUnknown'),
    });
  }

  if (status.selfSigned) {
    checks.push({ tone: 'warn', text: t('check.selfSigned') });
  } else {
    checks.push({ tone: 'info', text: t('check.issuerUnchecked') });
  }
  return checks;
}

export function certificateFields(status, t, locale) {
  const cert = status.signerCert || {};
  const fields = [
    [t('field.subject'), cert.subject],
    [t('field.email'), cert.email],
    [t('field.issuer'), cert.issuer],
    [t('field.valid'), cert.notBefore && cert.notAfter ? `${fmtDateTime(cert.notBefore, locale)} – ${fmtDateTime(cert.notAfter, locale)}` : null],
    [t('field.algorithm'), cert.algorithm],
    [t('field.serial'), cert.serialNumber],
    ['SHA-256', cert.fingerprint],
    [t('field.format'), status.format === 'detached' ? t('format.detached')
      : status.format === 'opaque' ? t('format.opaque') : null],
  ];
  return fields.filter(([, v]) => v);
}

const CHECK_ICON = { ok: 'circle-check', bad: 'circle-x', warn: 'alert-triangle', info: 'info-circle' };
const CHECK_TONE = { ok: 'success', bad: 'danger', warn: 'default', info: 'muted' };

function SignatureDetails({ status, t, locale }) {
  return h(Stack, { gap: 3 },
    h(Stack, { gap: 1 },
      signatureChecks(status, t, locale).map((c, i) => h(Row, { key: i, gap: 2, wrap: false, align: 'start' },
        h(Icon, { name: CHECK_ICON[c.tone], size: 'sm' }),
        h(Text, { tone: CHECK_TONE[c.tone] }, c.text),
      )),
    ),
    h(Stack, { gap: 1 },
      certificateFields(status, t, locale).map(([k, v]) => h(Row, { key: k, gap: 2, wrap: false, align: 'baseline' },
        h(Text, { size: 'xs', tone: 'muted' }, k),
        h(Text, { size: 'xs' }, v),
      )),
    ),
  );
}

const BANNER_TONE = { success: 'success', warning: 'warning', destructive: 'danger', info: 'info' };

// Stored by the render hook when the OS's store had no answer for it. Each comes with a way to retry.
const OS_DECRYPT_BANNERS = {
  'os-cancelled': 'banner.osCancelled',
  'os-busy': 'banner.osBusy',
  'os-pending': 'banner.osPending',
};
// The hook is at work, or renders again by itself once the dialog is answered.
const stillWaiting = (status) => status?.inProgress === true || status?.decryptionError === 'os-pending';
// A verdict from this opening, so nothing newer can be on its way.
const settled = (status, since) => !!status && !stillWaiting(status) && (status.at ?? 0) >= since;

// How long the banner waits between looks for the render hook's result: often at
// first, then less often. It doesn't give up: a PIN can take as long as it takes.
const VERIFY_WAIT_MS = [100, 150, 250, 400, 600, 1000, 1500, 2000];
const VERIFY_WAIT_LATER_MS = 3000;

const PKCS7_PART = /^application\/(x-)?pkcs7-(signature|mime)$/;
const hasPkcs7Attachment = (email) => (email.attachments || [])
  .some((att) => PKCS7_PART.test(String(att.type || '').split(';')[0].trim().toLowerCase()));

/** The info bars for a stored verify status. Exported for tests. */
export function bannerRows(status, { warnSelfSigned = true, t } = {}) {
  const rows = [];
  if (status.isEncrypted) {
    const eyebrow = t('banner.encryption');
    if (status.decryptionSuccess) rows.push({ icon: 'lock-open', eyebrow, text: t('banner.decrypted'), tone: 'success' });
    else if (status.decryptionError === 'locked') rows.push({ icon: 'lock', eyebrow, text: t('banner.locked'), tone: 'warning', action: 'unlock' });
    else if (status.decryptionError === 'os-ask') rows.push({ icon: 'lock', eyebrow, text: t('banner.osAsk'), tone: 'info', action: 'retry', actionLabel: 'banner.openWithSystem' });
    else if (OS_DECRYPT_BANNERS[status.decryptionError]) rows.push({ icon: 'lock', eyebrow, text: t(OS_DECRYPT_BANNERS[status.decryptionError]), tone: 'warning', action: 'retry' });
    else if (status.decryptionError === 'os-list-denied') rows.push({ icon: 'lock', eyebrow, text: t('banner.osListDenied'), tone: 'warning' });
    else if (status.decryptionError) {
      // As smime-decrypt.js UnsupportedAlgorithmError words it.
      const algorithm = String(status.decryptionError).match(/^Unsupported encryption algorithm (.+)$/)?.[1];
      const text = algorithm ? t('banner.unsupportedAlgorithm', { algorithm }) : t('banner.undecryptable');
      rows.push({ icon: 'lock', eyebrow, text, tone: 'destructive' });
    }
    else rows.push({ icon: 'lock', eyebrow, text: t('banner.encrypted'), tone: 'info' });
    if (status.noIntegrity) rows.push({ icon: 'alert-triangle', eyebrow, text: t('banner.noIntegrity'), tone: 'warning' });
  }
  if (status.isSigned || status.signerCert) {
    const eyebrow = t('banner.signature');
    if (status.signatureValid) {
      const selfSigned = warnSelfSigned && status.selfSigned;
      const text = [
        status.signerCert && status.signerCert.email ? t('banner.validBy', { email: status.signerCert.email }) : t('banner.valid'),
        selfSigned ? t('banner.selfSigned') : null,
        status.signerEmailMatch === false ? t('banner.signerMismatch') : null,
      ].filter(Boolean).join(' · ');
      // A valid signature only reads as trusted-green when it also chains to a
      // CA and the signer matches the From. A self-signed cert or a signer≠From
      // mismatch downgrades to an amber warning (still "valid", just untrusted).
      const untrusted = status.signerEmailMatch === false || selfSigned;
      rows.push({
        icon: untrusted ? 'shield-exclamation' : 'shield-check',
        eyebrow,
        text,
        tone: untrusted ? 'warning' : 'success',
        details: true,
      });
    } else if (status.signatureError) {
      rows.push({ icon: 'shield-exclamation', eyebrow, text: t('banner.invalid', { error: errorText(t, status.signatureError) }), tone: 'destructive', details: !!status.signerCert });
    } else {
      rows.push({ icon: 'shield-check', eyebrow, text: t('banner.signed'), tone: 'info' });
    }
  }
  // Only a part below the top level is signed: unverified, and the rest of the message is outside it.
  if (status.partlySigned) rows.push({ icon: 'alert-triangle', eyebrow: t('banner.signature'), text: t('banner.partlySigned'), tone: 'warning' });
  if (status.unsupportedReason) rows.push({ icon: 'info-circle', eyebrow: 'S/MIME', text: errorText(t, status.unsupportedReason), tone: 'info' });
  return rows;
}

export function makeUi(host, deps) {
  const t = translator(host);

  function EmailBanner(props) {
    const email = props && props.email;
    const [status, setStatus] = useState(null);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    // Bumped to watch again. The ref holds the time a verdict has to be newer than.
    const [watch, setWatch] = useState(0);
    const watchSince = useRef(null);

    // Past the plugin's sharing of a recent result, then the render hook again, then
    // the watch below until it has the answer.
    const renderAfresh = useCallback(async () => {
      if (!email || !email.id) return;
      await host.storage.set(deps.FRESH_PREFIX + email.id, true);
      watchSince.current = Date.now();
      setWatch((n) => n + 1);
      await host.ui.rerenderEmail();
    }, [email]);

    // "Unlock now" for the locked-encryption bar: unlock any locked key
    // (prompting for the storage passphrase), then ask the host to re-run the
    // render hook so the body decrypts in place — no reload (which would wipe
    // the just-unlocked in-memory keys).
    const unlockNow = useCallback(async () => {
      setBusy(true);
      try {
        const recs = await deps.listKeyRecords();
        const locked = [];
        for (const r of recs) {
          const s = await deps.getSessionKeys(r.id);
          if (!(s && s.decryptionKey)) locked.push(r);
        }
        let unlockedAny = false;
        for (const rec of locked) {
          const s = await deps.ensureKeyUnlocked(rec);
          if (s && s.decryptionKey) unlockedAny = true;
          else break; // cancelled or wrong passphrase — stop prompting
        }
        if (!unlockedAny) return;

        await renderAfresh();
      } finally {
        setBusy(false);
      }
    }, [email, renderAfresh]);

    // "Try again" after a No or a busy store. Stays busy until the watch has the new verdict.
    const retryNow = useCallback(async () => {
      setBusy(true);
      try {
        await renderAfresh();
      } catch {
        setBusy(false);
      }
    }, [renderAfresh]);

    useEffect(() => {
      let alive = true;
      (async () => {
        if (!email || !email.id) { setLoaded(true); return; }
        const key = deps.VERIFY_PREFIX + email.id;
        const since = watchSince.current ?? Date.now();
        watchSince.current = null;
        const stored = await host.storage.get(key);
        if (!alive) return;
        // No render-hook result yet: best-effort detect from headers.
        const ct = email.headers && (email.headers['Content-Type'] || email.headers['content-type']);
        const det = deps.detectSmime(Array.isArray(ct) ? ct[0] : ct);
        const guess = det.type === 'enveloped-data' ? { isEncrypted: true }
          : det.type === 'signed-data' || det.type === 'detached-sig' ? { isSigned: true }
          : null;
        setStatus(stored ?? guess);
        setLoaded(true);
        // Nothing to guess from the header, but a pkcs7 attachment: the hook may still report
        // on the message (a signed part inside it, a damaged signed message). Look for its
        // verdict for a while, not for good, as most such mail gets none.
        const briefly = !stored && !guess && hasPkcs7Attachment(email);
        if (!stored && !guess && !briefly) return;
        // The render hook is often still at work in the background instance when this
        // banner mounts, and what's stored may be from the last time the message was
        // open. Keep looking until it has this opening's verdict, so the banner never
        // sits on an old one.
        let current = stored;
        for (let i = 0; !settled(current, since); i++) {
          if (briefly && !current && i >= VERIFY_WAIT_MS.length) break;
          await new Promise((resolve) => setTimeout(resolve, VERIFY_WAIT_MS[i] ?? VERIFY_WAIT_LATER_MS));
          if (!alive) return;
          let next = null;
          try { next = await host.storage.get(key); } catch { /* try again */ }
          if (!alive) return;
          if (next && JSON.stringify(next) !== JSON.stringify(current)) {
            setStatus(next);
            current = next;
          }
        }
        setBusy(false);
      })();
      return () => { alive = false; };
    }, [email && email.id, watch]);

    if (!loaded || !status) return null;
    const rows = bannerRows(status, { warnSelfSigned: deps.settings().warnOnSelfSigned !== false, t });
    if (rows.length === 0) return null;

    return h(React.Fragment, null, rows.map((r, i) => h(InfoBar, {
      key: i,
      tone: BANNER_TONE[r.tone] || 'info',
      icon: r.icon,
      eyebrow: r.eyebrow,
      title: r.text,
    },
    (r.details || r.action) && h(Row, { gap: 2 },
      r.details && h(BarButton, {
        icon: detailsOpen ? 'chevron-up' : 'chevron-down',
        active: detailsOpen,
        onClick: () => setDetailsOpen(!detailsOpen),
      }, detailsOpen ? t('banner.hideDetails') : t('banner.showDetails')),
      r.action === 'unlock' && h(BarButton, { icon: 'lock-open', busy, onClick: unlockNow }, t('banner.unlockNow')),
      r.action === 'retry' && h(BarButton, { icon: r.actionLabel ? 'lock-open' : 'refresh', busy, onClick: retryNow }, t(r.actionLabel ?? 'banner.tryAgain')),
    ),
    r.details && detailsOpen && h(SignatureDetails, { status, t, locale: localeOf(host) }),
    )));
  }

  function SettingsSection() {
    const [keys, setKeys] = useState([]);
    const [certs, setCerts] = useState([]);
    const [prefs, setPrefsState] = useState(deps.DEFAULT_PREFS);
    const [unlocked, setUnlocked] = useState({}); // id -> bool
    const [osRecords, setOsRecords] = useState([]);
    const [osState, setOsState] = useState('idle');
    const [busy, setBusy] = useState(false);
    const [capable, setCapable] = useState(true);
    const fileRef = useRef(null);
    const certFileRef = useRef(null);

    const refresh = useCallback(async () => {
      if (!(await deps.isCapable())) { setCapable(false); return; }
      const [k, c, p] = await Promise.all([deps.listKeyRecords(), deps.listPublicCerts(), deps.getPrefs()]);
      setKeys(k); setCerts(c); setPrefsState(p);
      const u = {};
      for (const rec of k) u[rec.id] = !!(await deps.getSessionKeys(rec.id));
      setUnlocked(u);
    }, []);

    // Keys changed: reload the list and let the composer's Options menu know.
    const changed = useCallback(async () => {
      await refresh();
      try { await deps.onKeysChanged?.(); } catch { /* the menu catches up on the next composer */ }
    }, [refresh]);

    // OS keys are listed here, when the page opens: the list can bring up the shell's
    // consent dialog, so it isn't done at plugin start. Waits out a slow answer.
    const loadOsKeys = useCallback(async (again) => {
      if (!deps.osKeys?.available()) return;
      setOsState('loading');
      const { records, state } = await (again ? deps.osKeys.refresh() : deps.osKeys.loadPatiently());
      setOsRecords(records);
      setOsState(state);
      try { await deps.onKeysChanged?.(); } catch { /* the menu catches up on the next composer */ }
    }, []);

    useEffect(() => { void refresh(); void loadOsKeys(false); }, [refresh, loadOsKeys]);

    if (!capable) {
      return h(Alert, { tone: 'danger', icon: 'alert-triangle' },
        h(Text, { weight: 'medium', tone: 'danger' }, t('settings.notActive')),
        h(Text, { tone: 'danger' }, t('settings.notPrivileged')));
    }

    async function importKeyFile() {
      const file = fileRef.current && fileRef.current.files && fileRef.current.files[0];
      if (!file) return;
      const answers = await host.ui.prompt({
        title: t('import.title'),
        message: t('import.message', { file: file.name }),
        confirmLabel: t('import.confirm'),
        fields: [
          { name: 'p12pass', label: t('import.filePassphrase'), type: 'password', placeholder: t('import.filePassphraseHint') },
          { name: 'storagePass', label: t('import.storagePassphrase'), type: 'password', required: true },
        ],
      });
      if (fileRef.current) fileRef.current.value = '';
      if (!answers) return; // cancelled
      const p12pass = answers.p12pass || '';
      const storagePass = answers.storagePass || '';
      if (!storagePass) { host.toast.error(t('import.storagePassphraseRequired')); return; }
      setBusy(true);
      try {
        const buf = await file.arrayBuffer();
        const { keyRecord } = await deps.importPkcs12(buf, p12pass, storagePass);
        await deps.saveKeyRecord(keyRecord);
        host.toast.success(keyRecord.email ? t('import.done', { email: keyRecord.email }) : t('import.doneNoEmail'));
        await changed();
      } catch (err) {
        host.toast.error(t('import.failed', { error: errorMessage(t, err) }));
      } finally {
        setBusy(false);
      }
    }

    async function unlock(rec) {
      const answers = await host.ui.prompt({
        title: rec.email ? t('unlock.keyTitle', { email: rec.email }) : t('unlock.title'),
        confirmLabel: t('unlock.confirm'),
        fields: [
          { name: 'pass', label: t('unlock.keyPassphrase'), type: 'password', required: true },
        ],
      });
      if (!answers) return; // cancelled
      const pass = answers.pass || '';
      if (!pass) return;
      setBusy(true);
      try {
        const { signingKey, decryptionKey, sealedPkcs8 } = await deps.unlockPrivateKey(rec, pass);
        await deps.saveSessionKeys({ id: rec.id, signingKey, decryptionKey, sealedPkcs8 });
        host.toast.success(rec.email ? t('unlock.done', { email: rec.email }) : t('unlock.doneNoEmail'));
        await refresh();
      } catch (err) {
        host.toast.error(err && err.message ? errorMessage(t, err) : t('unlock.failed'));
      } finally {
        setBusy(false);
      }
    }

    async function lock(rec) {
      await deps.deleteSessionKeys(rec.id);
      host.toast.info(rec.email ? t('lock.done', { email: rec.email }) : t('lock.doneNoEmail'));
      await refresh();
    }

    async function removeKey(rec) {
      const ok = await host.ui.confirm({
        title: t('delete.title'),
        message: rec.email ? t('delete.message', { email: rec.email }) : t('delete.messageNoEmail'),
        danger: true,
        confirmLabel: t('delete.confirm'),
      });
      if (!ok) return;
      await deps.deleteSessionKeys(rec.id);
      await deps.deleteKeyRecord(rec.id);
      host.toast.success(t('delete.done'));
      await changed();
    }

    async function importCertFile() {
      const file = certFileRef.current && certFileRef.current.files && certFileRef.current.files[0];
      if (!file) return;
      setBusy(true);
      try {
        const buf = await file.arrayBuffer();
        const cert = deps.parseCertificatePemOrDer(buf);
        const der = cert.toSchema(true).toBER(false);
        const info = await deps.extractCertificateInfo(cert, der);
        const email = (info.emailAddresses[0] || '').toLowerCase();
        if (!email) throw new Error(t('certificates.noEmail'));
        await deps.savePublicCert({
          id: deps.generateUUID(),
          email,
          certificate: der,
          issuer: info.issuer,
          subject: info.subject,
          notBefore: info.notBefore,
          notAfter: info.notAfter,
          fingerprint: info.fingerprint,
          source: 'manual',
        });
        host.toast.success(t('certificates.imported', { email }));
        await refresh();
      } catch (err) {
        host.toast.error(t('certificates.importFailed', { error: errorMessage(t, err) }));
      } finally {
        if (certFileRef.current) certFileRef.current.value = '';
        setBusy(false);
      }
    }

    async function removeCert(c) {
      await deps.deletePublicCert(c.id);
      await refresh();
    }

    async function setPref(key, value) {
      const next = { ...prefs, [key]: value };
      setPrefsState(next);
      await deps.setPrefs(next);
      try { await deps.onKeysChanged?.(); } catch { /* ignore */ }
    }

    const locale = localeOf(host);
    const keyDetails = (rec) => [
      rec.algorithm,
      t('keys.valid', { from: fmtDate(rec.notBefore, locale), until: fmtDate(rec.notAfter, locale) }),
      rec.capabilities && rec.capabilities.canSign ? t('keys.canSign') : '',
      rec.capabilities && rec.capabilities.canEncrypt ? t('keys.canEncrypt') : '',
    ].filter(Boolean).join(' · ');
    const osKeyDetails = (rec) => [
      rec.osSource === 'smartcard' ? t('keys.smartcard') : '',
      rec.algorithm,
      t('keys.valid', { from: fmtDate(rec.notBefore, locale), until: fmtDate(rec.notAfter, locale) }),
      rec.capabilities.canSign ? t('keys.canSign') : '',
      rec.capabilities.canEncrypt ? t('keys.canEncrypt') : '',
      rec.capabilities.canSign && !rec.capabilities.canEncrypt ? t('keys.signOnly') : '',
    ].filter(Boolean).join(' · ');
    const SOURCE_KEYS = { manual: 'certificates.sourceManual', 'signed-email': 'certificates.sourceSignedEmail' };
    const source = (c) => (SOURCE_KEYS[c.source] ? t(SOURCE_KEYS[c.source]) : c.source);

    // The browser's file picker stays hidden; the kit button opens it.
    const picker = (ref, accept, onChange, label) => h('input', {
      ref, type: 'file', accept, onChange, hidden: true, 'aria-label': label,
    });

    return h(Stack, { gap: 6 },
      h(Section, {
        title: t('keys.title'),
        description: t('keys.description'),
      },
      picker(fileRef, '.p12,.pfx', importKeyFile, t('keys.file')),
      deps.osKeys?.available() && h(Text, { tone: 'muted' }, t('keys.systemHint')),
      h(Row, null,
        h(Button, { icon: 'upload', busy, onClick: () => fileRef.current && fileRef.current.click() }, t('keys.import')),
        deps.osKeys?.available() && h(Button, {
          variant: 'secondary', icon: 'refresh', busy: osState === 'loading', onClick: () => loadOsKeys(true),
        }, t('keys.systemRefresh'))),
      osState === 'denied' && h(Alert, { tone: 'warning', icon: 'alert-triangle' }, h(Text, null, t('keys.systemDenied'))),
      (osState === 'failed' || osState === 'pending' || osState === 'busy') && h(Alert, { tone: 'warning', icon: 'alert-triangle' }, h(Text, null, t('keys.systemFailed'))),
      keys.length === 0 && osRecords.length === 0
        ? h(EmptyState, { compact: true, icon: 'key', title: t('keys.empty') })
        : h(List, { label: t('keys.title') },
          // No unlock and no delete: the key isn't ours, and the OS asks for itself.
          osRecords.map((rec) => h(ListRow, {
            key: rec.id,
            icon: h(Icon, { name: 'certificate' }),
            title: h(Row, { gap: 2, wrap: false },
              h('span', null, rec.email || rec.subject || t('keys.unnamed')),
              isExpired(rec.notAfter) && h(Badge, { tone: 'danger' }, t('badge.expired')),
              h(Badge, { tone: 'info' }, t('keys.fromSystem'))),
            subtitle: osKeyDetails(rec),
          })),
          keys.map((rec) => h(ListRow, {
            key: rec.id,
            icon: h(Icon, { name: unlocked[rec.id] ? 'lock-open' : 'lock' }),
            title: h(Row, { gap: 2, wrap: false },
              h('span', null, rec.email || rec.subject || t('keys.unnamed')),
              isExpired(rec.notAfter) && h(Badge, { tone: 'danger' }, t('badge.expired')),
              unlocked[rec.id] && h(Badge, { tone: 'success' }, t('badge.unlocked'))),
            subtitle: keyDetails(rec),
            actions: h(React.Fragment, null,
              unlocked[rec.id]
                ? h(Button, { size: 'sm', variant: 'secondary', disabled: busy, onClick: () => lock(rec) }, t('keys.lock'))
                : h(Button, { size: 'sm', variant: 'secondary', disabled: busy, onClick: () => unlock(rec) }, t('unlock.confirm')),
              h(RowAction, { icon: 'trash', label: t('keys.delete'), danger: true, onClick: () => removeKey(rec) })),
          })),
        ),
      ),

      h(Section, {
        title: t('certificates.title'),
        description: t('certificates.description'),
      },
      picker(certFileRef, '.pem,.crt,.cer,.der', importCertFile, t('certificates.file')),
      h(Row, null,
        h(Button, { variant: 'secondary', icon: 'upload', busy, onClick: () => certFileRef.current && certFileRef.current.click() }, t('certificates.import'))),
      certs.length === 0
        ? h(EmptyState, { compact: true, icon: 'certificate', title: t('certificates.empty') })
        : h(List, { label: t('certificates.title') },
          certs.map((c) => h(ListRow, {
            key: c.id,
            icon: h(Icon, { name: 'certificate' }),
            title: h(Row, { gap: 2, wrap: false },
              h('span', null, c.email || c.subject),
              isExpired(c.notAfter) && h(Badge, { tone: 'danger' }, t('badge.expired'))),
            subtitle: [source(c), t('certificates.expires', { date: fmtDate(c.notAfter, locale) })].filter(Boolean).join(' · '),
            actions: h(RowAction, { icon: 'trash', label: t('certificates.remove'), danger: true, onClick: () => removeCert(c) }),
          })),
        ),
      ),

      h(Section, { title: t('defaults.title') },
        h(SettingRow, { label: t('defaults.sign'), description: t('defaults.signHelp') },
          h(Switch, { label: t('defaults.sign'), checked: !!prefs.defaultSign, onChange: (v) => setPref('defaultSign', v) })),
        h(SettingRow, { label: t('defaults.encrypt'), description: t('defaults.encryptHelp') },
          h(Switch, { label: t('defaults.encrypt'), checked: !!prefs.defaultEncrypt, onChange: (v) => setPref('defaultEncrypt', v) })),
      ),
    );
  }

  return { EmailBanner, SettingsSection };
}
