// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fakeApi as bareFakeApi } from '../../test-utils/fake-api.mjs';
import { makeUi, bannerRows } from '../src/ui.js';
import { composeActions, handleComposeAction, publishComposeActions, resetComposeIntent, INTENT_KEY } from '../src/compose-actions.js';
import { parseCertificatePemOrDer, extractCertificateInfo, issuerCapabilities, pemCertificates } from '../src/certificate-utils.js';
import { makeCa, makeLeaf, pem } from './helpers/test-certificates.mjs';

const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'smime', 'manifest.json'), 'utf8'));
const fakeApi = (opts = {}) => bareFakeApi({ translations: manifest.locales, ...opts });
const t = (key, vars) => fakeApi().i18n.t(key, vars);

afterEach(cleanup);

function deps(over = {}) {
  return {
    VERIFY_PREFIX: 'verify:',
    DEFAULT_PREFS: { defaultSign: false, defaultEncrypt: false },
    NOT_PRIVILEGED_MSG: 'not privileged',
    settings: () => ({}),
    isCapable: async () => true,
    getPrefs: async () => ({ defaultSign: false, defaultEncrypt: false }),
    setPrefs: async () => {},
    detectSmime: () => ({ type: null }),
    ensureKeyUnlocked: async () => null,
    listKeyRecords: async () => [],
    getSessionKeys: async () => null,
    listPublicCerts: async () => [],
    detached: () => true,
    ...over,
  };
}

describe('composer Options entries', () => {
  it('are check items carrying the stored intent', () => {
    const actions = composeActions({ intent: { sign: true, encrypt: false }, ready: true, detached: true, t });
    expect(actions.map((a) => [a.id, a.checked])).toEqual([['sign', true], ['encrypt', false]]);
    expect(actions[0].description).toMatch(/Detached/);
    for (const a of actions) expect(a.description.length).toBeLessThanOrEqual(120);
  });

  it('stay unchecked and say why without a key', () => {
    const actions = composeActions({ intent: { sign: true, encrypt: true }, ready: false, detached: true, t });
    expect(actions.every((a) => a.checked === false)).toBe(true);
    expect(actions[0].description).toMatch(/Import your S\/MIME key/);
  });

  it('a click flips that entry, stores it for the send, and republishes the menu', async () => {
    const api = fakeApi();
    const d = deps({ listKeyRecords: async () => [{ id: 'k' }] });
    await publishComposeActions(api, d);
    await handleComposeAction(api, d, { surface: 'composer-options-menu', actionId: 'encrypt', context: { composerId: 'c1' } });
    expect(await api.storage.get(INTENT_KEY)).toEqual({ sign: false, encrypt: true });
    const last = api.calls('ui.setActions').at(-1).args;
    expect(last[0]).toBe('composer-options-menu');
    expect(last[1].find((a) => a.id === 'encrypt').checked).toBe(true);
  });

  it('a click without a key changes nothing and explains', async () => {
    const api = fakeApi();
    await handleComposeAction(api, deps(), { surface: 'composer-options-menu', actionId: 'sign' });
    expect(await api.storage.get(INTENT_KEY)).toBeNull();
    expect(api.calls('toast.info')).toHaveLength(1);
  });

  it('a new composer starts from the defaults in Settings', async () => {
    const api = fakeApi();
    await api.storage.set(INTENT_KEY, { sign: false, encrypt: true });
    const d = deps({ listKeyRecords: async () => [{ id: 'k' }], getPrefs: async () => ({ defaultSign: true, defaultEncrypt: false }) });
    await resetComposeIntent(api, d);
    const last = api.calls('ui.setActions').at(-1).args[1];
    expect(last.map((a) => [a.id, a.checked])).toEqual([['sign', true], ['encrypt', false]]);
  });
});

describe('reader banner', () => {
  it('shows one info bar per status, in the status tone', async () => {
    const api = fakeApi();
    await api.storage.set('verify:m1', { isEncrypted: true, decryptionSuccess: true, isSigned: true, signatureValid: true, signerVerified: true, fromEmail: 'a@x.org', signerCert: { email: 'a@x.org', notAfter: '2999-01-01', notBefore: '2000-01-01' }, signerEmailMatch: true });
    const { EmailBanner } = makeUi(api, deps());
    await act(async () => { render(React.createElement(EmailBanner, { email: { id: 'm1' } })); });
    const bars = document.querySelectorAll('.bk-infobar');
    expect([...bars].map((b) => b.getAttribute('data-tone'))).toEqual(['success', 'success']);
    expect(bars[1].textContent).toMatch(/Valid signature by a@x.org/);
    fireEvent.click(screen.getByRole('button', { name: /Show certificate details/ }));
    expect(screen.getByText(/Certificate is for the sender's address/)).toBeTruthy();
    expect(document.querySelector('[style]')).toBeNull();
  });

  it('turns into the verdict when verification finishes after the banner opened', async () => {
    const api = fakeApi();
    const { EmailBanner } = makeUi(api, deps({ detectSmime: () => ({ type: 'detached-sig' }) }));
    const email = { id: 'm2', headers: { 'Content-Type': 'multipart/signed; protocol="application/pkcs7-signature"' } };
    await act(async () => { render(React.createElement(EmailBanner, { email })); });
    expect(document.querySelector('.bk-infobar').textContent).toMatch(/Signed message/);
    // The render hook in the background instance stores its result later.
    await api.storage.set('verify:m2', { isSigned: true, signatureValid: true, signerVerified: true, fromEmail: 'a@x.org', signerCert: { email: 'a@x.org', notAfter: '2999-01-01', notBefore: '2000-01-01' }, signerEmailMatch: true });
    await waitFor(() => expect(document.querySelector('.bk-infobar').textContent).toMatch(/Valid signature by a@x.org/));
    expect(document.querySelector('.bk-infobar').getAttribute('data-tone')).toBe('success');
  });

  it('offers Unlock now on a locked message', () => {
    const rows = bannerRows({ isEncrypted: true, decryptionError: 'locked' }, { t });
    expect(rows).toEqual([expect.objectContaining({ tone: 'warning', action: 'unlock' })]);
  });

  it('waits for the verdict on a mail whose only hint is a pkcs7 attachment', async () => {
    const api = fakeApi();
    const { EmailBanner } = makeUi(api, deps());
    const email = {
      id: 'm3', headers: { 'Content-Type': 'multipart/mixed; boundary="b"' },
      attachments: [{ blobId: 'b1', name: 'smime.p7s', type: 'application/pkcs7-signature', size: 2 }],
    };
    await act(async () => { render(React.createElement(EmailBanner, { email })); });
    expect(document.querySelector('.bk-infobar')).toBeNull();
    // The render hook stores its verdict after the banner looked the first time.
    await api.storage.set('verify:m3', { partlySigned: true, at: Date.now() });
    await waitFor(() => expect(document.querySelector('.bk-infobar')?.textContent).toMatch(/Part of this message is signed/));
    expect(document.querySelector('.bk-infobar').getAttribute('data-tone')).toBe('warning');
  });

  it('looks once for a mail without a hint (control)', async () => {
    const api = fakeApi();
    const read = api.storage.get;
    let reads = 0;
    api.storage.get = async (key) => { reads++; return read(key); };
    const { EmailBanner } = makeUi(api, deps());
    const email = { id: 'm4', headers: { 'Content-Type': 'text/plain' }, attachments: [{ blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 2 }] };
    await act(async () => { render(React.createElement(EmailBanner, { email })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(reads).toBe(1);
    expect(document.querySelector('.bk-infobar')).toBeNull();
  });
});

describe('settings section', () => {
  it('lists keys as rows with Unlock and Delete, and defaults as switches', async () => {
    const api = fakeApi();
    const d = deps({
      listKeyRecords: async () => [{ id: 'k1', email: 'me@x.org', algorithm: 'RSA', notBefore: '2020-01-01', notAfter: '2000-01-01', capabilities: { canSign: true } }],
    });
    const { SettingsSection } = makeUi(api, d);
    await act(async () => { render(React.createElement(SettingsSection)); });
    const row = screen.getAllByRole('listitem')[0];
    expect(row.textContent).toMatch(/me@x.org/);
    expect(row.textContent).toMatch(/Expired/);
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete key' })).toBeTruthy();
    expect(screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toEqual(['Sign new messages', 'Encrypt new messages']);
    expect(document.querySelector('input[type=checkbox]')).toBeNull();
  });

  it('tells the composer when a default changes', async () => {
    const api = fakeApi();
    let told = 0;
    const saved = [];
    const { SettingsSection } = makeUi(api, deps({ setPrefs: async (p) => { saved.push(p); }, onKeysChanged: async () => { told++; } }));
    await act(async () => { render(React.createElement(SettingsSection)); });
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Sign new messages' })); });
    expect(saved).toEqual([{ defaultSign: true, defaultEncrypt: false }]);
    expect(told).toBe(1);
  });

  it('marks certificates from signed mail nobody vouches for, and removes all of them in one go', async () => {
    let certs = [
      { id: 'c1', email: 'bob@x.org', source: 'manual', notAfter: '2999-01-01' },
      { id: 'c2', email: 'carol@x.org', source: 'signed-email', notAfter: '2999-01-01' },
      { id: 'c3', email: 'dan@x.org', source: 'signed-email', notAfter: '2999-01-01' },
      { id: 'c4', email: 'erin@x.org', source: 'signed-email', notAfter: '2999-01-01' },
    ];
    const { SettingsSection } = makeUi(fakeApi(), deps({
      listPublicCerts: async () => certs,
      unverifiedFromMail: async (list) => new Set(list.filter((c) => c.id === 'c3' || c.id === 'c4').map((c) => c.id)),
      deletePublicCert: async (id) => { certs = certs.filter((c) => c.id !== id); },
    }));
    await act(async () => { render(React.createElement(SettingsSection)); });
    const rowOf = (email) => screen.getByText(email).closest('[role=listitem]');
    expect(rowOf('carol@x.org').textContent).toMatch(/from a signed message ·/);
    expect(rowOf('dan@x.org').textContent).toMatch(/from a signed message, not verified/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove unverified certificates from signed mail' })); });
    expect(certs.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(screen.queryByRole('button', { name: 'Remove unverified certificates from signed mail' })).toBeNull();
  });
});

describe('trusted issuers and certificates', () => {
  const certDeps = (over = {}) => {
    const saved = [];
    return {
      saved,
      d: deps({
        listTrusted: async () => saved,
        saveTrusted: async (r) => { saved.push(r); },
        deleteTrusted: async () => {},
        generateUUID: () => `id-${saved.length}`,
        parseCertificatePemOrDer, extractCertificateInfo, issuerCapabilities, pemCertificates,
        ...over,
      }),
    };
  };
  const pickFile = async (label, text) => {
    const input = screen.getByLabelText(label);
    Object.defineProperty(input, 'files', { value: [{ name: 'ca.pem', arrayBuffer: async () => new TextEncoder().encode(text).buffer }], configurable: true });
    await act(async () => { fireEvent.change(input); });
  };

  it('imports a certificate authority from a PEM file as a trusted issuer', async () => {
    const ca = await makeCa('Example Corp Mail CA');
    const api = fakeApi();
    const { d, saved } = certDeps();
    const { SettingsSection } = makeUi(api, d);
    await act(async () => { render(React.createElement(SettingsSection)); });
    await pickFile('Issuer certificate file', pem(ca.der));
    expect(saved).toEqual([expect.objectContaining({ kind: 'issuer', subject: 'CN=Example Corp Mail CA' })]);
    expect(new Uint8Array(saved[0].certificate)).toEqual(ca.der);
    expect(api.calls('toast.success')[0].args[0]).toBe('Trusted issuer added: Example Corp Mail CA');
    expect(screen.getByText('Example Corp Mail CA')).toBeTruthy();
  });

  it('refuses a certificate that may not issue certificates', async () => {
    const leaf = await makeLeaf(null, { emails: ['bob@example.org'] });
    const api = fakeApi();
    const { d, saved } = certDeps();
    const { SettingsSection } = makeUi(api, d);
    await act(async () => { render(React.createElement(SettingsSection)); });
    await pickFile('Issuer certificate file', pem(leaf.der));
    expect(saved).toEqual([]);
    expect(api.calls('toast.error')[0].args[0]).toMatch(/^Couldn’t add the issuer: This certificate can’t issue certificates/);
  });

  it('lists the issuers the admin set, without a way to remove them', async () => {
    const ca = await makeCa('Admin Root');
    const { d } = certDeps({ adminIssuers: async () => [ca.der.buffer.slice(0)] });
    const { SettingsSection } = makeUi(fakeApi(), d);
    await act(async () => { render(React.createElement(SettingsSection)); });
    const row = (await screen.findByText('Admin Root')).closest('[role=listitem]');
    expect(row.textContent).toMatch(/From your administrator/);
    expect(row.querySelector('button')).toBeNull();
  });

  it('keeps the certificate of a signature as trusted after the user confirms, and verifies again', async () => {
    const api = fakeApi({ handlers: { 'ui.confirm': async () => true, 'ui.rerenderEmail': async () => {} } });
    await api.storage.set('verify:m5', {
      isSigned: true, signatureValid: true, cryptoValid: true, signerEmailMatch: true, fromEmail: 'bob@example.org',
      signerVerified: false, trustReasons: ['issuer'],
      signerCert: { email: 'bob@example.org', emails: ['bob@example.org'], subject: 'CN=Bob', issuer: 'CN=Somebody', fingerprint: 'ab:cd', notAfter: '2999-01-01', notBefore: '2000-01-01' },
    });
    const { d, saved } = certDeps();
    const { EmailBanner } = makeUi(api, d);
    await act(async () => { render(React.createElement(EmailBanner, { email: { id: 'm5' } })); });
    expect(document.querySelector('.bk-infobar').getAttribute('data-tone')).toBe('warning');
    fireEvent.click(screen.getByRole('button', { name: /Show certificate details/ }));
    expect(screen.getByText('Revocation is not checked')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Trust this certificate' })); });
    expect(api.calls('ui.confirm')[0].args[0].message).toContain('ab:cd');
    expect(saved).toEqual([expect.objectContaining({ kind: 'signer', fingerprint: 'ab:cd', emails: ['bob@example.org'] })]);
    expect(api.calls('ui.rerenderEmail')).toHaveLength(1);
  });

  it('keeps nothing when the user says no', async () => {
    const api = fakeApi({ handlers: { 'ui.confirm': async () => false } });
    await api.storage.set('verify:m6', {
      isSigned: true, signatureValid: true, signerVerified: false, trustReasons: ['self'], fromEmail: 'bob@example.org', signerEmailMatch: true,
      signerCert: { email: 'bob@example.org', fingerprint: 'ab:cd', notAfter: '2999-01-01', notBefore: '2000-01-01' },
    });
    const { d, saved } = certDeps();
    const { EmailBanner } = makeUi(api, d);
    await act(async () => { render(React.createElement(EmailBanner, { email: { id: 'm6' } })); });
    fireEvent.click(screen.getByRole('button', { name: /Show certificate details/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Trust this certificate' })); });
    expect(saved).toEqual([]);
  });
});
