// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentBrowser } from '../src/ui/DocumentBrowser.jsx';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { setApi } from '../src/ui/host.js';
import manifest from '../manifest.json' with { type: 'json' };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function mountAt(phone) {
  window.matchMedia = vi.fn((query) => ({
    matches: phone && query.includes('max-width'),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  setApi(fakeApi({ manifest }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(DocumentBrowser, {})); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { container, unmount: () => act(() => root.unmount()) };
}

describe('Paperless page header', () => {
  let view;
  afterEach(() => { view?.unmount(); delete window.matchMedia; document.body.innerHTML = ''; });

  it('leaves naming the page to the app header on a phone', async () => {
    view = await mountAt(true);
    expect(view.container.querySelector('h1')).toBeNull();
  });

  it('names the page itself where the app has no such header', async () => {
    view = await mountAt(false);
    expect(view.container.querySelector('h1')?.textContent).toBe('page.title');
  });
});
