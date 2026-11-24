// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Picker } from '../src/ui/Picker.jsx';
import { SaveDialog } from '../src/ui/SaveDialog.jsx';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { setApi } from '../src/ui/host.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 'https://docs.example.com';
const DOCS = {
  o1: [{ id: 'd1', name: 'Lease.pdf', mimeType: 'application/pdf', originalSize: 4, tags: [{ id: 't1', name: 'Home', color: '#22c55e' }] }],
  o2: [{ id: 'd2', name: 'Invoice.pdf', mimeType: 'application/pdf', originalSize: 4, tags: [] }],
};

function papra({ organizations = [{ id: 'o1', name: 'Home' }, { id: 'o2', name: 'Work' }] } = {}) {
  return fakeApi({
    handlers: {
      'admin.getConfig': () => '',
      'proxy.accounts': () => [{ credentialId: 'personal', scope: 'user', origin: BASE, connected: true }],
      'proxy.fetch': (_cred, url) => {
        if (url === `${BASE}/api/organizations`) return proxyResponse(JSON.stringify({ organizations }));
        const list = /organizations\/([^/]+)\/documents\?/.exec(url);
        if (list) return proxyResponse(JSON.stringify({ documents: DOCS[list[1]], documentsCount: DOCS[list[1]].length }));
        if (url.endsWith('/file')) return { status: 200, ok: true, headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3, 4]).buffer };
        return proxyResponse('{}');
      },
      'jmap.uploadBlob': async (bytes, name, type) => ({ blobId: `blob-${name}`, size: bytes.byteLength, type }),
      'composer.attach': async () => true,
    },
  });
}

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(Component, props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Component, props)); });
  await settle();
  return { container, unmount: () => act(() => root.unmount()) };
}

const button = (container, label) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
const rows = (container) => [...container.querySelectorAll('[role="listitem"]')];

describe('From Papra picker', () => {
  let view;
  afterEach(() => { view?.unmount(); document.body.innerHTML = ''; });

  it('lists the documents of the remembered organization with their tags, and attaches the picked one', async () => {
    const api = papra();
    await api.storage.set('organization', 'o1');
    setApi(api);
    const onClose = vi.fn();
    view = await mount(Picker, { composerId: 'c-5', onClose });
    expect(rows(view.container).map((r) => r.textContent)).toEqual([expect.stringContaining('Lease.pdf')]);
    expect(view.container.querySelector('[data-color="#22c55e"]')).toBeTruthy();
    expect(rows(view.container)[0].textContent).toContain('Home');
    await act(async () => { rows(view.container)[0].click(); });
    await settle();
    await act(async () => { button(view.container, 'picker.attach_count').click(); });
    await settle();
    expect(api.calls('composer.attach').map((c) => c.args)).toEqual([
      ['c-5', { blobId: 'blob-Lease.pdf', name: 'Lease.pdf', type: 'application/pdf', size: 4 }],
    ]);
    expect(onClose).toHaveBeenCalledWith(1);
  });

  it('switches organization and remembers it', async () => {
    const api = papra();
    setApi(api);
    view = await mount(Picker, { composerId: 'c-5', onClose: () => {} });
    const select = view.container.querySelector('select');
    await act(async () => {
      select.value = 'o2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(rows(view.container).map((r) => r.textContent)).toEqual([expect.stringContaining('Invoice.pdf')]);
    expect(await api.storage.get('organization')).toBe('o2');
  });

  it('shows no organization choice with only one', async () => {
    setApi(papra({ organizations: [{ id: 'o1', name: 'Home' }] }));
    view = await mount(Picker, { composerId: 'c-5', onClose: () => {} });
    expect(view.container.querySelector('select')).toBeNull();
    expect(rows(view.container)).toHaveLength(1);
  });
});

describe('Save dialog', () => {
  let view;
  afterEach(() => { view?.unmount(); document.body.innerHTML = ''; });

  it('hands back the organization picked', async () => {
    setApi(papra());
    const onResult = vi.fn();
    view = await mount(SaveDialog, { kind: 'attachment', name: 'a.pdf', organizations: [{ id: 'o1', name: 'Home' }, { id: 'o2', name: 'Work' }], organizationId: 'o2', onResult });
    await act(async () => { button(view.container, 'save.button').click(); });
    expect(onResult).toHaveBeenCalledWith({ organizationId: 'o2' });
  });
});
