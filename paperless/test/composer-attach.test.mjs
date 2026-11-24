// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentBrowser } from '../src/ui/DocumentBrowser.jsx';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { setApi } from '../src/ui/host.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 'https://dms.example.com';
const DOCS = [
  { id: 1, title: 'Invoice', original_file_name: 'invoice.pdf', tags: [] },
  { id: 2, title: 'Contract', original_file_name: 'contract.pdf', tags: [] },
];

function paperless() {
  return fakeApi({
    handlers: {
      'admin.getConfig': () => '',
      'proxy.accounts': () => [{ credentialId: 'personal', scope: 'user', origin: BASE, connected: true }],
      'proxy.fetch': (_cred, url) => {
        if (url.includes('/api/documents/?')) return proxyResponse(JSON.stringify({ count: DOCS.length, next: null, results: DOCS }));
        if (/\/api\/documents\/\d+\/download\//.test(url)) {
          return { status: 200, ok: true, headers: { 'content-type': 'application/pdf' }, body: new Uint8Array([37, 80, 68, 70]).buffer };
        }
        return proxyResponse(JSON.stringify({ results: [] }));
      },
      'jmap.uploadBlob': async (bytes, name, type) => ({ blobId: `blob-${name}`, size: bytes.byteLength, type }),
      'composer.attach': async () => true,
    },
  });
}

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(props) {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(DocumentBrowser, props)); });
  await settle();
  return { container, unmount: () => act(() => root.unmount()) };
}

/** Open one document from the list; its details have the Attach button. */
async function open(container, title) {
  const row = [...container.querySelectorAll('[role="listitem"]')].find((r) => r.textContent.includes(title));
  await act(async () => { row.click(); });
  await settle();
}

const button = (container, label) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);

describe('Paperless documents from the composer', () => {
  let view;
  afterEach(() => { view?.unmount(); delete window.matchMedia; document.body.innerHTML = ''; });

  it('attaches a document to that composer and closes with the count', async () => {
    const api = paperless();
    setApi(api);
    const onClose = vi.fn();
    view = await mount({ inDialog: true, composerId: 'c-9', onClose });
    await open(view.container, 'Contract');
    const attach = button(view.container, 'browse.attach_here');
    expect(attach).toBeTruthy();
    await act(async () => { attach.click(); });
    await settle();
    expect(api.calls('composer.attach').map((c) => c.args)).toEqual([
      ['c-9', { blobId: 'blob-contract.pdf', name: 'contract.pdf', type: 'application/pdf', size: 4 }],
    ]);
    expect(api.calls('compose.open')).toHaveLength(0);
    expect(onClose).toHaveBeenCalledWith(1);
  });

  it('still opens a new message from the plain browser', async () => {
    const api = paperless();
    setApi(api);
    view = await mount({ inDialog: true, onClose: () => {} });
    await open(view.container, 'Invoice');
    await act(async () => { button(view.container, 'browse.attach').click(); });
    await settle();
    expect(api.calls('composer.attach')).toHaveLength(0);
    expect(api.calls('compose.open')).toHaveLength(1);
  });
});
