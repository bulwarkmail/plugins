// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import * as plugin from '../src/index.js';
import { fixture, makePdf, manifest } from './helpers.mjs';

const enc = (s) => new TextEncoder().encode(s);
const xml = enc(fixture('xrechnung-ubl.xml'));
const message = {
  id: 'm1', subject: 'Rechnung RE-2026-117', keywords: [],
  attachments: [{ blobId: 'x1', name: 'RE-2026-117.xml', type: 'application/xml', size: xml.length, inline: false }],
};

async function start({ settings = {}, handlers = {} } = {}) {
  const api = fakeApi({
    translations: manifest.locales,
    settings: { forwardWhat: 'forward.all', tagMessages: true, autoForward: false, accountingAddress: 'books@example.com', ...settings },
    handlers: {
      'config.get': async () => ({}),
      'email.get': async (id) => (id === 'm1' ? message : null),
      'email.getAttachment': async () => ({ name: 'RE-2026-117.xml', type: 'application/xml', size: xml.length, data: xml.buffer }),
      'email.forward': async () => ({ sent: true, emailId: 's1', to: ['books@example.com'] }),
      ...handlers,
    },
  });
  await plugin.activate(api);
  return api;
}

describe('background', () => {
  it('offers "Show as invoice" on XML and PDF attachments and an E-invoices filter', async () => {
    const api = await start();
    expect(api.calls('ui.setActions').map((c) => c.args)).toEqual([[
      'attachment-menu',
      [expect.objectContaining({ id: 'show-invoice', label: 'Show as invoice', mimeTypes: ['application/pdf', 'application/xml', 'text/xml'] })],
    ]]);
    expect(api.calls('ui.setListFilters')[0].args[0]).toEqual([expect.objectContaining({ label: 'E-invoices', hasKeyword: '$einvoice' })]);
  });

  it('opens the invoice from an attachment menu, and says so when a file holds none', async () => {
    const api = await start();
    await plugin.hooks.onAction({ surface: 'attachment-menu', actionId: 'show-invoice', context: { emailId: 'm1', blobId: 'x1', name: 'RE-2026-117.xml', type: 'application/xml' } });
    await vi.waitFor(() => expect(api.calls('ui.openDialog')).toHaveLength(1));
    expect(api.calls('ui.openDialog')[0].args[0].extraProps).toMatchObject({ source: { blobId: 'x1', kind: 'xml' }, email: { id: 'm1' } });

    const other = await start({ handlers: { 'email.getAttachment': async () => ({ name: 'scan.pdf', type: 'application/pdf', data: enc('%PDF-1.4').buffer }) } });
    await plugin.hooks.onAction({ surface: 'attachment-menu', actionId: 'show-invoice', context: { emailId: 'm1', blobId: 'p', name: 'scan.pdf', type: 'application/pdf' } });
    await vi.waitFor(() => expect(other.calls('toast.info')).toHaveLength(1));
    expect(other.calls('toast.info')[0].args[0]).toBe('scan.pdf is not an e-invoice');
  });

  it('tags new e-invoices, and forwards them only when the user turned that on', async () => {
    const api = await start();
    await plugin.hooks.onNewEmailReceived({ id: 'm1', hasAttachment: true });
    await vi.waitFor(() => expect(api.calls('email.setKeyword')).toHaveLength(1));
    expect(api.calls('email.forward')).toEqual([]);

    const auto = await start({ settings: { autoForward: true } });
    await plugin.hooks.onNewEmailReceived({ id: 'm1', hasAttachment: true });
    await vi.waitFor(() => expect(auto.calls('email.forward')).toHaveLength(1));
    expect(auto.calls('toast.info')[0].args[0]).toBe('Forwarded the e-invoice "Rechnung RE-2026-117" to accounting');
    // Not twice.
    await plugin.hooks.onNewEmailReceived({ id: 'm1', hasAttachment: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(auto.calls('email.forward')).toHaveLength(1);
  });

  it('leaves mail without attachments alone', async () => {
    const api = await start({ settings: { autoForward: true } });
    await plugin.hooks.onNewEmailReceived({ id: 'm1', hasAttachment: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.calls('email.get')).toEqual([]);
  });

  it('badges tagged messages in the list', async () => {
    await start();
    expect(plugin.hooks.onEmailListItemRender([], { email: { keywords: ['$einvoice'] } })).toEqual([expect.objectContaining({ key: 'einvoice', label: 'E-invoice' })]);
    expect(plugin.hooks.onEmailListItemRender([], { email: { keywords: [] } })).toBeUndefined();
  });

  it('reads a PDF attachment from the menu too', async () => {
    const pdf = makePdf([{ name: 'factur-x.xml', content: fixture('zugferd-cii.xml') }]);
    const api = await start({ handlers: { 'email.getAttachment': async () => ({ name: 'R.pdf', type: 'application/pdf', data: pdf.buffer }) } });
    await plugin.hooks.onAction({ surface: 'attachment-menu', actionId: 'show-invoice', context: { emailId: 'm1', blobId: 'p', name: 'R.pdf', type: 'application/pdf' } });
    await vi.waitFor(() => expect(api.calls('ui.openDialog')).toHaveLength(1));
    expect(api.calls('ui.openDialog')[0].args[0].extraProps.source).toMatchObject({ kind: 'pdf', embeddedName: 'factur-x.xml' });
  });
});
