// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { makeUi, bannerRows } from '../src/ui.js';
import { composeActions, handleComposeAction } from '../src/compose-actions.js';
import { errorText } from '../src/i18n.js';

// jsdom gives import.meta.url an http scheme; tests run from the repo root.
const DIR = path.join(process.cwd(), 'smime');
const raw = readFileSync(path.join(DIR, 'manifest.json'), 'utf8');
const manifest = JSON.parse(raw);
const WEBMAIL_LOCALES = ['ar', 'ca', 'cs', 'da', 'de', 'en', 'es', 'fa', 'fr', 'he', 'hu', 'it', 'ja', 'ko', 'lv', 'mn', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'tr', 'uk', 'zh', 'zh-TW'];
const en = manifest.locales.en;
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
// Words that are the same as in English in some languages.
const MAY_MATCH_ENGLISH = ['field.format', 'field.algorithm', 'compose.sign', 'compose.encrypt', 'settings.notActive'];
// The same word in that language (French "Signature", Italian "Email", Romanian "Import").
const SAME_WORD = { fr: ['banner.signature', 'format.opaque', 'opaque'], it: ['field.email'], ro: ['import.confirm'] };

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory()
    ? sourceFiles(path.join(dir, d.name))
    : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));
}
const UI_SOURCES = ['index.js', 'ui.js', 'compose-actions.js'].map((f) => path.join(DIR, 'src', f));

afterEach(cleanup);

describe('translations', () => {
  it('cover every webmail language', () => {
    expect(Object.keys(manifest.locales).sort()).toEqual([...WEBMAIL_LOCALES].sort());
  });

  // The webmail's settings.tabs.addons in each language: the key import is a
  // page under Settings → Add-ons (it used to be Settings → Plugins).
  const ADDONS = {
    ar: 'الإضافات', ca: 'Complements', cs: 'Doplňky', da: 'Tilføjelser', de: 'Erweiterungen', en: 'Add-ons',
    es: 'Complementos', fa: 'افزونه‌ها', fr: 'Extensions', he: 'תוספים', hu: 'Bővítmények', it: 'Componenti aggiuntivi',
    ja: 'アドオン', ko: '추가 기능', lv: 'Papildinājumi', mn: 'Нэмэлтүүд', nb: 'Tillegg', nl: 'Add-ons', pl: 'Dodatki',
    pt: 'Extras', ro: 'Suplimente', ru: 'Дополнения', sk: 'Doplnky', tr: 'Eklentiler', uk: 'Додатки', zh: '附加组件', 'zh-TW': '附加元件',
  };
  it.each(WEBMAIL_LOCALES)('%s sends people to the S/MIME page under Add-ons', (locale) => {
    for (const key of ['compose.noKey', 'send.noKey']) {
      expect(manifest.locales[locale][key], `${locale} ${key}`).toContain(`→ ${ADDONS[locale]} → S/MIME`);
    }
  });

  it.each(WEBMAIL_LOCALES)('%s has every key with the same placeholders', (locale) => {
    const table = manifest.locales[locale];
    expect(Object.keys(table).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of Object.entries(table)) {
      expect(text.trim(), `${locale} ${key}`).not.toBe('');
      expect(placeholders(text), `${locale} ${key}`).toEqual(placeholders(en[key]));
    }
  });

  it.each(WEBMAIL_LOCALES.filter((l) => l !== 'en'))('%s is translated, not English copied over', (locale) => {
    const same = Object.keys(en).filter((k) => manifest.locales[locale][k] === en[k] && !MAY_MATCH_ENGLISH.includes(k) && !(SAME_WORD[locale] ?? []).includes(k));
    expect(same, locale).toEqual([]);
  });

  it('every key the code uses exists', () => {
    const used = new Set();
    for (const file of sourceFiles(path.join(DIR, 'src'))) {
      const code = readFileSync(file, 'utf8');
      for (const m of code.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1]);
      // Keys kept in lookup tables (known errors, certificate sources).
      for (const m of code.matchAll(/'((?:error|certificates)\.[a-zA-Z]+)'/g)) used.add(m[1]);
    }
    // The send toast's key is put together from the outcome.
    for (const when of ['sent', 'scheduled']) {
      for (const how of ['signedEncrypted', 'encrypted', 'signedDetached', 'signedOpaque']) used.add(`${when}.${how}`);
    }
    expect(used.size).toBeGreaterThan(100);
    expect([...used].filter((k) => !(k in en))).toEqual([]);
  });

  it('user setting labels and signature formats are translation keys, so Settings shows them translated', () => {
    for (const field of Object.values(manifest.settingsSchema)) {
      expect(en[field.label], field.label).toBeTruthy();
      if (field.description) expect(en[field.description], field.description).toBeTruthy();
    }
    for (const option of manifest.settingsSchema.signatureFormat.options) expect(en[option], option).toBeTruthy();
  });

  it('is written as real characters, not \\u escapes', () => {
    expect(raw).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });

  // index.js pulls in the crypto libraries, so its toasts and prompts are
  // checked in the source: no English text handed to the user directly.
  it.each(UI_SOURCES.map((f) => [path.basename(f), f]))('%s hands the user no hard-coded text', (_name, file) => {
    const code = readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');
    const literal = `['"\`]`;
    const offenders = [
      ...code.matchAll(new RegExp(`toast\\.\\w+\\(\\s*${literal}[^\\n]*`, 'g')),
      ...code.matchAll(new RegExp(`\\b(?:title|message|confirmLabel|label|placeholder|description|eyebrow|text):\\s*${literal}(?!S/MIME')(?=[A-Za-z])[^\\n]*`, 'g')),
      ...code.matchAll(new RegExp(`\\},\\s*${literal}[A-Z][a-z][^\\n]*`, 'g')),
      ...code.matchAll(new RegExp(`throw new Error\\(\\s*${literal}[^\\n]*`, 'g')),
    ].map((m) => m[0]);
    // isCapable's internal probe errors never reach the user.
    expect(offenders.filter((o) => !/missing apis|indexedDB open failed/.test(o))).toEqual([]);
  });
});

// A made-up language whose every string is "‹key›" (plus the placeholders):
// any text still hard-coded in English shows up as a failed lookup here.
const pseudo = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, [`‹${k}›`, ...placeholders(v).map((p) => `{${p}}`)].join(' ')]));
const pseudoApi = (handlers = {}) => fakeApi({ locale: 'xx', translations: { en, xx: pseudo }, handlers });
const t = (key, vars) => pseudoApi().i18n.t(key, vars);

/** No English UI string left once the pseudo strings are taken out. */
function expectNoEnglish(text) {
  const rest = text.replace(/‹[^›]*›/g, ' ');
  for (const value of Object.values(en)) {
    const plain = value.replace(/\{\w+\}/g, '').trim();
    if (plain.length >= 5) expect(rest, value).not.toContain(plain);
  }
}

function deps(over = {}) {
  return {
    VERIFY_PREFIX: 'verify:',
    DEFAULT_PREFS: { defaultSign: false, defaultEncrypt: false },
    settings: () => ({}),
    isCapable: async () => true,
    getPrefs: async () => ({ defaultSign: false, defaultEncrypt: false }),
    setPrefs: async () => {},
    detectSmime: () => ({ type: null }),
    ensureKeyUnlocked: async () => null,
    listKeyRecords: async () => [],
    getSessionKeys: async () => null,
    listPublicCerts: async () => [],
    saveSessionKeys: async () => {},
    deleteSessionKeys: async () => {},
    deleteKeyRecord: async () => {},
    detached: () => true,
    ...over,
  };
}

const KEY = { id: 'k1', email: 'me@x.org', algorithm: 'RSA', notBefore: '2020-01-01', notAfter: '2000-01-01', capabilities: { canSign: true, canEncrypt: true } };

describe('S/MIME in another language', () => {
  it('names the composer Options entries and their hints from the locale', async () => {
    const ready = composeActions({ intent: { sign: true, encrypt: false }, ready: true, detached: true, t });
    expect(ready.map((a) => [a.label, a.description])).toEqual([
      ['‹compose.sign›', '‹compose.signDetached›'], ['‹compose.encrypt›', '‹compose.encryptHint›'],
    ]);
    expect(composeActions({ intent: { sign: false, encrypt: true }, ready: true, detached: false, t })[0].description).toBe('‹compose.signInside›');
    expect(composeActions({ intent: {}, ready: true, detached: false, t })[0].description).toBe('‹compose.signOpaque›');
    expect(composeActions({ intent: {}, ready: false, detached: true, t })[1].description).toBe('‹compose.noKey›');

    const api = pseudoApi();
    await handleComposeAction(api, deps(), { surface: 'composer-options-menu', actionId: 'sign' });
    expect(api.calls('toast.info')[0].args[0]).toBe('‹compose.noKey›');
    expect(api.calls('ui.setActions')[0].args[1][0].label).toBe('‹compose.sign›');
  });

  it.each([
    [{ isEncrypted: true, decryptionSuccess: true }, '‹banner.encryption›', '‹banner.decrypted›'],
    [{ isEncrypted: true, decryptionError: 'locked' }, '‹banner.encryption›', '‹banner.locked›'],
    [{ isEncrypted: true, decryptionError: 'no key' }, '‹banner.encryption›', '‹banner.undecryptable›'],
    [{ isEncrypted: true }, '‹banner.encryption›', '‹banner.encrypted›'],
    [{ isSigned: true }, '‹banner.signature›', '‹banner.signed›'],
    [{ isSigned: true, signatureValid: true }, '‹banner.signature›', '‹banner.valid›'],
    [{ isSigned: true, signatureValid: true, selfSigned: true, signerEmailMatch: false, signerCert: { email: 'a@x.org' } }, '‹banner.signature›', '‹banner.validBy› a@x.org · ‹banner.selfSigned› · ‹banner.signerMismatch›'],
    [{ isSigned: true, signatureError: 'Signer certificate has expired' }, '‹banner.signature›', '‹banner.invalid› ‹error.signerExpired›'],
    [{ isSigned: true, signatureError: 'ASN.1 garbage' }, '‹banner.signature›', '‹banner.invalid› ASN.1 garbage'],
    [{ unsupportedReason: 'Unsupported S/MIME type (compressed)' }, 'S/MIME', '‹banner.unsupported› compressed'],
  ])('words the reader bar for %j from the locale', (status, eyebrow, text) => {
    expect(bannerRows(status, { t })).toEqual([expect.objectContaining({ eyebrow, text })]);
  });

  it('draws the signature details from the locale', async () => {
    const api = pseudoApi();
    await api.storage.set('verify:m1', {
      isSigned: true, signatureValid: true, cryptoValid: true, signerEmailMatch: true, format: 'detached',
      signerCert: { email: 'a@x.org', subject: 'CN=A', issuer: 'CN=CA', algorithm: 'RSA', serialNumber: '01', fingerprint: 'ab', notAfter: '2999-01-01', notBefore: '2000-01-01' },
    });
    const { EmailBanner } = makeUi(api, deps());
    await act(async () => { render(React.createElement(EmailBanner, { email: { id: 'm1' } })); });
    fireEvent.click(screen.getByRole('button', { name: '‹banner.showDetails›' }));
    const text = document.body.textContent;
    for (const key of ['check.unchanged', 'check.validUntil', 'check.senderMatch', 'check.issuerUnchecked', 'field.subject', 'field.email', 'field.issuer', 'field.valid', 'field.serial', 'field.format', 'format.detached']) {
      expect(text, key).toContain(`‹${key}›`);
    }
    expect(screen.getByRole('button', { name: '‹banner.hideDetails›' })).toBeTruthy();
    expectNoEnglish(text);
  });

  it('draws the settings page from the locale', async () => {
    const api = pseudoApi();
    const { SettingsSection } = makeUi(api, deps({
      listKeyRecords: async () => [KEY],
      getSessionKeys: async () => ({ signingKey: {} }),
      listPublicCerts: async () => [
        { id: 'c1', email: 'bob@x.org', source: 'manual', notAfter: '2999-01-01' },
        { id: 'c2', email: 'eve@x.org', source: 'signed-email', notAfter: '2000-01-01' },
      ],
    }));
    await act(async () => { render(React.createElement(SettingsSection)); });
    const text = document.body.textContent;
    for (const key of ['keys.title', 'keys.description', 'keys.import', 'keys.valid', 'keys.canSign', 'keys.canEncrypt', 'badge.expired', 'badge.unlocked', 'keys.lock',
      'certificates.title', 'certificates.description', 'certificates.import', 'certificates.sourceManual', 'certificates.sourceSignedEmail', 'certificates.expires',
      'defaults.title', 'defaults.sign', 'defaults.signHelp', 'defaults.encrypt', 'defaults.encryptHelp']) {
      expect(text, key).toContain(`‹${key}›`);
    }
    expect(screen.getByRole('button', { name: '‹keys.delete›' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '‹certificates.remove›' }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('‹keys.file›').getAttribute('type')).toBe('file');
    expectNoEnglish(text);
  });

  it('draws the empty lists and the not-privileged notice from the locale', async () => {
    const { SettingsSection } = makeUi(pseudoApi(), deps());
    await act(async () => { render(React.createElement(SettingsSection)); });
    expect(document.body.textContent).toContain('‹keys.empty›');
    expect(document.body.textContent).toContain('‹certificates.empty›');
    cleanup();
    const { SettingsSection: Off } = makeUi(pseudoApi(), deps({ isCapable: async () => false }));
    await act(async () => { render(React.createElement(Off)); });
    expect(screen.getByRole('alert').textContent).toBe('‹settings.notActive›‹settings.notPrivileged›');
  });

  it('asks for passphrases and reports an import in the locale', async () => {
    const prompts = [];
    const api = pseudoApi({ 'ui.prompt': async (p) => { prompts.push(p); return { p12pass: '', storagePass: 'secret' }; } });
    const { SettingsSection } = makeUi(api, deps({ importPkcs12: async () => { throw new Error('Incorrect passphrase'); } }));
    await act(async () => { render(React.createElement(SettingsSection)); });
    const input = screen.getByLabelText('‹keys.file›');
    Object.defineProperty(input, 'files', { value: [{ name: 'me.p12', arrayBuffer: async () => new ArrayBuffer(1) }] });
    await act(async () => { fireEvent.change(input); });
    expect(prompts[0]).toMatchObject({ title: '‹import.title›', message: '‹import.message› me.p12', confirmLabel: '‹import.confirm›' });
    expect(prompts[0].fields.map((f) => [f.label, f.placeholder])).toEqual([
      ['‹import.filePassphrase›', '‹import.filePassphraseHint›'], ['‹import.storagePassphrase›', undefined],
    ]);
    expect(api.calls('toast.error')[0].args[0]).toBe('‹import.failed› ‹error.wrongPassphrase›');
  });

  it('unlocks, locks and deletes a key in the locale', async () => {
    let unlocked = false;
    const prompts = [];
    const api = pseudoApi({
      'ui.prompt': async (p) => { prompts.push(p); return { pass: 'secret' }; },
      'ui.confirm': async () => true,
    });
    const { SettingsSection } = makeUi(api, deps({
      listKeyRecords: async () => [KEY],
      getSessionKeys: async () => (unlocked ? { signingKey: {} } : null),
      unlockPrivateKey: async () => { unlocked = true; return {}; },
      deleteSessionKeys: async () => { unlocked = false; },
    }));
    await act(async () => { render(React.createElement(SettingsSection)); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '‹unlock.confirm›' })); });
    expect(prompts[0]).toMatchObject({ title: '‹unlock.keyTitle› me@x.org', confirmLabel: '‹unlock.confirm›' });
    expect(prompts[0].fields[0].label).toBe('‹unlock.keyPassphrase›');
    expect(api.calls('toast.success')[0].args[0]).toBe('‹unlock.done› me@x.org');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '‹keys.lock›' })); });
    expect(api.calls('toast.info')[0].args[0]).toBe('‹lock.done› me@x.org');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '‹keys.delete›' })); });
    expect(api.calls('ui.confirm')[0].args[0]).toMatchObject({ title: '‹delete.title›', message: '‹delete.message› me@x.org', confirmLabel: '‹delete.confirm›' });
    expect(api.calls('toast.success').at(-1).args[0]).toBe('‹delete.done›');
  });

  it('passes errors it has no translation for through as they are', () => {
    expect(errorText(t, 'Incorrect passphrase')).toBe('‹error.wrongPassphrase›');
    expect(errorText(t, 'Invalid DER data: ASN.1 parsing failed')).toBe('Invalid DER data: ASN.1 parsing failed');
  });
});
