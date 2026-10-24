// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PickOne, TagPicker } from '../src/ui/common.jsx';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { setApi } from '../src/ui/host.js';
import manifest from '../manifest.json' with { type: 'json' };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(Component, props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Component, props)); });
  await settle();
  return {
    container,
    text: () => container.textContent,
    $: (sel) => container.querySelector(sel),
    $$: (sel) => [...container.querySelectorAll(sel)],
    rerender: async (next) => { await act(async () => { root.render(createElement(Component, next)); }); await settle(); },
    unmount: () => act(() => root.unmount()),
  };
}

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

const items = [
  { id: 1, name: 'ACME Hosting' },
  { id: 2, name: 'Stadtwerke Hildesheim' },
  { id: 4, name: 'Bob Example' },
];

describe('PickOne in searchable mode', () => {
  afterEach(() => {
    setApi(null);
    document.body.innerHTML = '';
  });

  const setup = () => {
    const api = fakeApi({ translations: manifest.locales, locale: 'en' });
    setApi(api);
    return api;
  };

  it('renders input with combobox role and placeholder when value is null', async () => {
    setup();
    const ui = await mount(PickOne, { items, value: null, noneLabel: 'None' });
    const input = ui.$('input[role="combobox"]');
    expect(input).toBeTruthy();
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('None');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    await ui.unmount();
  });

  it('displays the selected item name when value is provided', async () => {
    setup();
    const ui = await mount(PickOne, { items, value: 1 });
    const input = ui.$('input[role="combobox"]');
    expect(input.value).toBe('ACME Hosting');
    await ui.unmount();
  });

  it('opens dropdown list on focus or click', async () => {
    setup();
    const ui = await mount(PickOne, { items, value: null });
    const input = ui.$('input[role="combobox"]');
    expect(ui.$('[role="listbox"]')).toBeNull();

    await click(input);

    const listbox = ui.$('[role="listbox"]');
    expect(listbox).toBeTruthy();
    expect(input.getAttribute('aria-expanded')).toBe('true');

    // Shows None plus all items
    const options = ui.$$('[role="option"]');
    expect(options).toHaveLength(4);
    expect(options.map((o) => o.textContent.trim())).toEqual(['None', 'ACME Hosting', 'Stadtwerke Hildesheim', 'Bob Example']);
    await ui.unmount();
  });

  it('filters options as the user types', async () => {
    setup();
    const ui = await mount(PickOne, { items, value: null });
    const input = ui.$('input[role="combobox"]');

    await type(input, 'stadt');
    const options = ui.$$('[role="option"]');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('Stadtwerke Hildesheim');
    await ui.unmount();
  });

  it('selects an option on click and calls onChange with item ID', async () => {
    setup();
    const onChange = vi.fn();
    const ui = await mount(PickOne, { items, value: null, onChange });
    const input = ui.$('input[role="combobox"]');

    await click(input);
    const options = ui.$$('[role="option"]');
    const bobOption = options.find((o) => o.textContent.includes('Bob Example'));
    await click(bobOption);

    expect(onChange).toHaveBeenCalledWith(4);
    expect(input.value).toBe('Bob Example');
    expect(ui.$('[role="listbox"]')).toBeNull();
    await ui.unmount();
  });

  it('selects None and calls onChange with null', async () => {
    setup();
    const onChange = vi.fn();
    const ui = await mount(PickOne, { items, value: 4, onChange });
    const input = ui.$('input[role="combobox"]');

    await click(input);
    const options = ui.$$('[role="option"]');
    const noneOption = options[0];
    await click(noneOption);

    expect(onChange).toHaveBeenCalledWith(null);
    expect(input.value).toBe('');
    await ui.unmount();
  });

  it('navigates options with ArrowDown and selects with Enter', async () => {
    setup();
    const onChange = vi.fn();
    const ui = await mount(PickOne, { items, value: null, onChange });
    const input = ui.$('input[role="combobox"]');

    // ArrowDown to open
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await settle();
    expect(ui.$('[role="listbox"]')).toBeTruthy();

    // ArrowDown to move to first real item (ACME Hosting)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await settle();

    // Enter to select
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    expect(onChange).toHaveBeenCalledWith(1);
    expect(input.value).toBe('ACME Hosting');
    expect(ui.$('[role="listbox"]')).toBeNull();
    await ui.unmount();
  });

  it('clears selection when the clear button is clicked', async () => {
    setup();
    const onChange = vi.fn();
    const ui = await mount(PickOne, { items, value: 1, onChange });
    const input = ui.$('input[role="combobox"]');
    expect(input.value).toBe('ACME Hosting');

    const clearBtn = ui.$('button[aria-label="Clear"]');
    expect(clearBtn).toBeTruthy();
    await click(clearBtn);

    expect(onChange).toHaveBeenCalledWith(null);
    expect(input.value).toBe('');
    expect(ui.$('[role="listbox"]')).toBeNull();
    await ui.unmount();
  });

  it('closes dropdown and reverts input on Escape', async () => {
    setup();
    const ui = await mount(PickOne, { items, value: 1 });
    const input = ui.$('input[role="combobox"]');

    await click(input);
    await type(input, 'something unknown');
    expect(ui.$('[role="listbox"]')).toBeTruthy();

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();

    expect(ui.$('[role="listbox"]')).toBeNull();
    expect(input.value).toBe('ACME Hosting');
    await ui.unmount();
  });
});

describe('PickOne suggested badge', () => {
  afterEach(() => {
    setApi(null);
    document.body.innerHTML = '';
  });

  it('renders Combobox and includes label & suggested badge', async () => {
    fakeApi({ translations: manifest.locales, locale: 'en' });
    setApi(fakeApi({ translations: manifest.locales, locale: 'en' }));
    const ui = await mount(PickOne, {
      label: 'Correspondent',
      items,
      value: 1,
      onChange: () => {},
      suggested: true,
    });
    const input = ui.$('input[role="combobox"]');
    expect(input).toBeTruthy();
    expect(input.value).toBe('ACME Hosting');
    expect(ui.text().toLowerCase()).toContain('suggested');
    await ui.unmount();
  });
});

describe('SendDialog with Searchable Correspondent', () => {
  afterEach(() => {
    setApi(null);
    document.body.innerHTML = '';
  });

  it('renders Correspondent and Document type with searchable comboboxes', async () => {
    const api = fakeApi({
      translations: manifest.locales,
      locale: 'en',
      handlers: {
        'proxy.fetch': async (_cred, url) => {
          if (url.includes('/api/correspondents/')) {
            return {
              status: 200, ok: true, headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ results: items, next: null }),
            };
          }
          if (url.includes('/api/document_types/')) {
            return {
              status: 200, ok: true, headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ results: [{ id: 10, name: 'Invoice' }], next: null }),
            };
          }
          if (url.includes('/api/tags/')) {
            return {
              status: 200, ok: true, headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ results: [], next: null }),
            };
          }
          if (url.includes('/api/storage_paths/')) {
            return {
              status: 200, ok: true, headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ results: [{ id: 99, name: 'Path 1' }], next: null }),
            };
          }
          return {
            status: 200, ok: true, headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ count: 0, results: [] }),
          };
        },
      },
    });
    setApi(api);

    const { SendDialog } = await import('../src/ui/SendDialog.jsx');

    const groups = [{
      emailId: 'm1',
      subject: 'Invoice 10',
      sender: { name: 'ACME', email: 'billing@acme-hosting.example' },
      items: [{
        key: 'item-1',
        name: 'invoice.pdf',
        size: 1024,
        selected: true,
        sha256: 'abc',
        md5: 'def',
      }],
    }];

    const connection = { state: 'connected', base: 'https://paperless.example', credentialId: 'c1' };
    const ui = await mount(SendDialog, { groups, connection });

    // Wait for taxonomies to load
    for (let i = 0; i < 10; i++) await settle();

    // Correspondent, Document type, and Storage path are inputs with combobox role
    const comboboxes = ui.$$('input[role="combobox"]');
    expect(comboboxes).toHaveLength(3);
    expect(ui.$('select')).toBeNull();

    await ui.unmount();
  });
});

describe('TagPicker', () => {
  afterEach(() => {
    setApi(null);
    document.body.innerHTML = '';
  });

  const tags = [
    { id: 101, name: 'Important' },
    { id: 102, name: 'Tax 2026' },
    { id: 103, name: 'Warranty' },
  ];

  it('renders nothing when tags list is empty or undefined', async () => {
    fakeApi({ translations: manifest.locales, locale: 'en' });
    setApi(fakeApi({ translations: manifest.locales, locale: 'en' }));
    const ui = await mount(TagPicker, { tags: [] });
    expect(ui.container.innerHTML).toBe('');
    await ui.unmount();
  });

  it('renders multiselect combobox with tags as options and selected tags as chips', async () => {
    fakeApi({ translations: manifest.locales, locale: 'en' });
    setApi(fakeApi({ translations: manifest.locales, locale: 'en' }));
    const onChange = vi.fn();
    const ui = await mount(TagPicker, { tags, value: [101], onChange });

    // Renders selected chip
    const chip = ui.$('[role="checkbox"][aria-label="Important"]');
    expect(chip).toBeTruthy();
    expect(chip.getAttribute('aria-checked')).toBe('true');

    // Remove chip
    const removeBtn = ui.$('button[aria-label="Remove Important"]');
    expect(removeBtn).toBeTruthy();
    await click(removeBtn);
    expect(onChange).toHaveBeenCalledWith([]);
    expect(ui.$('[role="listbox"]')).toBeNull();

    await ui.unmount();
  });

  it('allows selecting new tags from dropdown', async () => {
    fakeApi({ translations: manifest.locales, locale: 'en' });
    setApi(fakeApi({ translations: manifest.locales, locale: 'en' }));
    const onChange = vi.fn();
    const ui = await mount(TagPicker, { tags, value: [101], onChange });

    const input = ui.$('input[role="combobox"]');
    await click(input);

    const options = ui.$$('[role="option"]');
    const warrantyOpt = options.find((o) => o.textContent.includes('Warranty'));
    expect(warrantyOpt).toBeTruthy();
    await click(warrantyOpt);

    expect(onChange).toHaveBeenCalledWith([101, 103]);
    await ui.unmount();
  });
});


