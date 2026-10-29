// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { setApi } from '../src/ui/host.js';
import { Banner } from '../src/ui/Banner.jsx';
import { InvoiceView } from '../src/ui/InvoiceView.jsx';
import { parseInvoice } from '../src/lib/parse.js';
import { fixture, makePdf, manifest } from './helpers.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted = [];
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(() => root.unmount());
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(Component, props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => { root.render(createElement(Component, props)); });
  await settle();
  return container;
}

const button = (container, label) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
async function click(el) {
  await act(async () => { el.click(); });
  await settle();
}

function apiWith(handlers = {}, settings = { accountingAddress: 'books@example.com' }) {
  const api = fakeApi({ translations: manifest.locales, settings: { forwardWhat: 'forward.all', tagMessages: true, ...settings }, handlers: { 'config.get': async () => ({}), ...handlers } });
  setApi(api);
  return api;
}

const invoice = parseInvoice(fixture('xrechnung-ubl.xml'));
const email = { id: 'm1', subject: 'Rechnung', keywords: [], attachments: [] };

describe('InvoiceView', () => {
  it('shows the invoice: parties, items with totals, payment and the documents in it', async () => {
    apiWith();
    const c = await mount(InvoiceView, { invoice, source: { kind: 'xml', name: 'RE-2026-117.xml' }, email });
    expect(c.textContent).toContain('Invoice RE-2026-117');
    expect(c.textContent).toContain('XRechnung 3.0 (UBL)');
    expect(c.textContent).toContain('Musterlieferant GmbH');
    expect(c.textContent).toContain('Beispielkunde AG');
    const items = c.querySelector('table[aria-label="Items"]');
    expect([...items.querySelectorAll('tbody tr')]).toHaveLength(2);
    const due = [...items.querySelectorAll('tfoot tr')].pop();
    expect(due.textContent.replace(/\s/g, ' ')).toBe('Amount due€846.00');
    expect(c.textContent).toContain('DE02 1203 0000 0000 2020 51');
    expect(c.textContent).toContain('The sums add up.');
    expect(c.textContent).toContain('stundennachweis.pdf');
    expect(c.textContent).toContain('"Forward to accounting" sends it to books@example.com.');
  });

  it('prints the invoice and downloads a document it carries', async () => {
    const api = apiWith();
    const c = await mount(InvoiceView, { invoice, source: { kind: 'xml', name: 'x.xml' }, email });
    await click(button(c, 'Print'));
    const [page] = api.calls('ui.print').map((call) => call.args[0]);
    expect(page.title).toBe('Invoice RE-2026-117');
    expect(page.html).toContain('<h1>Invoice RE-2026-117</h1>');
    await click(button(c, 'Download'));
    const [file] = api.calls('ui.downloadFile').map((call) => call.args[0]);
    expect(file.filename).toBe('stundennachweis.pdf');
    expect(new TextDecoder().decode(file.content)).toBe('%PDF-1.4\n%%EOF\n');
  });

  it('forwards to accounting and then says so', async () => {
    const forward = vi.fn(async () => ({ sent: true, emailId: 's1', to: ['books@example.com'] }));
    apiWith({ 'email.forward': forward });
    const c = await mount(InvoiceView, { invoice, source: { kind: 'xml', name: 'x.xml' }, email });
    await click(button(c, 'Forward to accounting'));
    expect(forward).toHaveBeenCalledWith('m1', expect.objectContaining({ to: ['books@example.com'] }));
    expect(c.textContent).toMatch(/Forwarded to books@example\.com on /);
    expect(button(c, 'Forward again')).toBeTruthy();
  });

  it('shows what the checks found', async () => {
    apiWith();
    const broken = { ...invoice, totals: { ...invoice.totals, due: 900 } };
    const c = await mount(InvoiceView, { invoice: broken, source: { kind: 'xml' }, email });
    expect(c.textContent).toContain('The amount due should be €846.00, but the invoice says €900.00.');
    expect(c.textContent).not.toContain('The sums add up.');
  });
});

describe('Banner', () => {
  const pdf = makePdf([{ name: 'factur-x.xml', content: fixture('zugferd-cii.xml') }]);
  const withPdf = { ...email, attachments: [{ blobId: 'p1', name: 'Rechnung.pdf', type: 'application/pdf', size: pdf.length, inline: false }] };

  it('sums up the invoice above the message, tags it and forwards in one click', async () => {
    const forward = vi.fn(async () => ({ sent: true, emailId: 's1', to: ['books@example.com'] }));
    const api = apiWith({
      'email.getAttachment': async () => ({ name: 'Rechnung.pdf', type: 'application/pdf', size: pdf.length, data: pdf.buffer }),
      'email.forward': forward,
    });
    const c = await mount(Banner, { email: withPdf });
    expect(c.textContent).toContain('ZUGFeRD / Factur-X · EN 16931');
    expect(c.textContent).toContain('Invoice RE-2026-117 from Musterlieferant GmbH, €846.00, due ');
    expect(api.calls('email.setKeyword').map((call) => call.args)).toEqual([['m1', '$einvoice', undefined]]);
    await click(button(c, 'Forward to accounting'));
    expect(forward).toHaveBeenCalledTimes(1);
    expect(c.textContent).toMatch(/Forwarded to books@example\.com on /);
  });

  it('opens the readable invoice', async () => {
    const api = apiWith({ 'email.getAttachment': async () => ({ data: pdf.buffer }) });
    const c = await mount(Banner, { email: withPdf });
    await click(button(c, 'Show invoice'));
    const [opts] = api.calls('ui.openDialog').map((call) => call.args[0]);
    expect(opts).toMatchObject({ slot: 'plugin-dialog', title: 'E-invoice', extraProps: { source: { kind: 'pdf', embeddedName: 'factur-x.xml' }, email: { id: 'm1' } } });
    expect(opts.extraProps.invoice.number).toBe('RE-2026-117');
  });

  it('stays empty for a PDF that is no e-invoice, and does not read it again next time', async () => {
    const getAttachment = vi.fn(async () => ({ data: new TextEncoder().encode('%PDF-1.4\n%%EOF').buffer }));
    const api = apiWith({ 'email.getAttachment': getAttachment });
    const c = await mount(Banner, { email: withPdf });
    expect(c.textContent).toBe('');
    expect(getAttachment).toHaveBeenCalledTimes(1);
    await mount(Banner, { email: withPdf });
    expect(getAttachment).toHaveBeenCalledTimes(1);
    expect(api.calls('email.setKeyword')).toEqual([]);
  });

  it('does not tag when the user turned that off', async () => {
    const api = apiWith({ 'email.getAttachment': async () => ({ data: pdf.buffer }) }, { tagMessages: false });
    await mount(Banner, { email: withPdf });
    expect(api.calls('email.setKeyword')).toEqual([]);
  });
});
