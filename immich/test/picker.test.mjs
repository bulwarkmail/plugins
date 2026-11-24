// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Picker } from '../src/ui/Picker.jsx';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { setApi } from '../src/ui/host.js';
import { createQueue } from '../src/lib/queue.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 'https://photos.example.com';
const ITEMS = [
  { id: 'a1', originalFileName: 'beach.jpg', type: 'IMAGE', originalMimeType: 'image/jpeg', exifInfo: { fileSizeInByte: 4 } },
  { id: 'a2', originalFileName: 'dog.mp4', type: 'VIDEO', originalMimeType: 'video/mp4', exifInfo: { fileSizeInByte: 4 } },
];

function immich({ connected = true } = {}) {
  return fakeApi({
    handlers: {
      'admin.getConfig': () => '',
      'proxy.accounts': () => (connected ? [{ credentialId: 'personal', scope: 'user', origin: BASE, connected: true }] : []),
      'proxy.fetch': (_cred, url) => {
        if (url.endsWith('/api/albums')) return proxyResponse('[]');
        if (url.endsWith('/api/search/metadata')) return proxyResponse(JSON.stringify({ assets: { items: ITEMS, nextPage: null } }));
        if (url.includes('/thumbnail')) return { status: 200, ok: true, headers: { 'content-type': 'image/webp' }, body: new Uint8Array([1]).buffer };
        if (url.endsWith('/original')) return { status: 200, ok: true, headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array([1, 2, 3, 4]).buffer };
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

async function mount(props) {
  URL.createObjectURL = vi.fn(() => 'blob:thumb');
  URL.revokeObjectURL = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Picker, props)); });
  await settle();
  return { container, unmount: () => act(() => root.unmount()) };
}

const button = (container, label) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);

describe('From Immich picker', () => {
  let view;
  afterEach(() => { view?.unmount(); document.body.innerHTML = ''; });

  it('shows the photos and attaches the picked one to that composer', async () => {
    const api = immich();
    setApi(api);
    const onClose = vi.fn();
    view = await mount({ composerId: 'c-3', onClose });
    const tiles = [...view.container.querySelectorAll('button[aria-pressed]')];
    expect(tiles.map((t) => t.getAttribute('aria-label').split(',')[0])).toEqual(['beach.jpg', 'dog.mp4']);
    await act(async () => { tiles[1].click(); });
    await settle();
    expect(tiles[1].getAttribute('aria-pressed')).toBe('true');
    await act(async () => { button(view.container, 'picker.attach_count').click(); });
    await settle();
    expect(api.calls('composer.attach').map((c) => c.args)).toEqual([
      ['c-3', { blobId: 'blob-dog.mp4', name: 'dog.mp4', type: 'image/jpeg', size: 4 }],
    ]);
    expect(onClose).toHaveBeenCalledWith(1);
  });

  it('offers to connect when Immich is not connected yet', async () => {
    setApi(immich({ connected: false }));
    view = await mount({ composerId: 'c-3', onClose: () => {} });
    expect(button(view.container, 'connect.button')).toBeTruthy();
    expect(view.container.querySelector('button[aria-pressed]')).toBeNull();
  });
});

describe('createQueue', () => {
  it('runs at most the limit at once', async () => {
    const q = createQueue(2);
    let running = 0;
    let most = 0;
    const task = () => new Promise((resolve) => { running++; most = Math.max(most, running); setTimeout(() => { running--; resolve(); }, 5); });
    await Promise.all([1, 2, 3, 4, 5].map(() => q.run(task)));
    expect(most).toBe(2);
  });
});
