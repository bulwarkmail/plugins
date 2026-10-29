// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseInvoice } from '../src/lib/parse.js';
import { formatName, groupIban, oneLine, present } from '../src/lib/present.js';
import { printHtml } from '../src/lib/print.js';
import { fixture, i18nFor } from './helpers.mjs';

const ubl = () => parseInvoice(fixture('xrechnung-ubl.xml'));
// Intl puts a narrow no-break space before € in German.
const norm = (s) => s.replace(/[  ]/g, ' ');

describe('present', () => {
  it('shows the invoice in German with German amounts, dates and units', () => {
    const p = present(ubl(), { ...i18nFor('de'), source: { kind: 'xml', name: 'rechnung.xml' } });
    expect(p.title).toBe('Rechnung');
    expect(norm(p.due)).toBe('846,00 €');
    expect(p.facts).toEqual(expect.arrayContaining([
      { label: 'Rechnungsdatum', value: '29.10.2026' },
      { label: 'Fällig am', value: '28.11.2026' },
      { label: 'Leistungszeitraum', value: '01.10.2026 – 31.10.2026' },
      { label: 'Käuferreferenz', value: '04011000-12345-34' },
      { label: 'Format', value: 'XRechnung 3.0 (UBL)' },
    ]));
    expect(p.lines[0]).toMatchObject({ position: '1', name: 'Beratung', quantity: '8 Std.', vat: '19 %' });
    expect(norm(p.lines[0].net)).toBe('800,00 €');
    expect(p.lines[0].details).toEqual(['Vor-Ort-Termin am 27.10.', 'Art.-Nr. B-100']);
    expect(p.seller.lines).toEqual(['Musterlieferant', 'Hauptstraße 1', '31134 Hildesheim', 'Deutschland']);
    expect(p.seller.details).toEqual(expect.arrayContaining([{ label: 'USt-IdNr.', value: 'DE123456789' }]));
  });

  it('lists the totals from items to the amount due', () => {
    const p = present(ubl(), { ...i18nFor('en'), source: { kind: 'xml' } });
    expect(p.summary.map((s) => [s.label, norm(s.value), !!s.strong])).toEqual([
      ['Items', '€850.00', false],
      ['Discount: Treuerabatt', '-€50.00', false],
      ['Net total', '€800.00', false],
      ['VAT 19 %', '€142.50', false],
      ['VAT 7 %', '€3.50', false],
      ['Total', '€946.00', false],
      ['Already paid', '-€100.00', false],
      ['Amount due', '€846.00', true],
    ]);
  });

  it('shows the payment with a readable IBAN', () => {
    const p = present(ubl(), { ...i18nFor('en'), source: { kind: 'xml' } });
    expect(p.payment).toEqual([
      { label: 'Payment', value: 'SEPA credit transfer' },
      { label: 'Account holder', value: 'Musterlieferant GmbH' },
      { label: 'IBAN', value: 'DE02 1203 0000 0000 2020 51' },
      { label: 'BIC', value: 'BYLADEM1001' },
      { label: 'Reference', value: 'RE-2026-117' },
      { label: 'Terms', value: 'Zahlbar innerhalb von 30 Tagen ohne Abzug.' },
    ]);
    expect(groupIban('not an iban')).toBe('not an iban');
  });

  it('names the format by where the XML came from', () => {
    const cii = parseInvoice(fixture('zugferd-cii.xml'));
    expect(formatName(cii, { kind: 'pdf' })).toBe('ZUGFeRD / Factur-X · EN 16931');
    expect(formatName(cii, { kind: 'xml' })).toBe('EN 16931 (CII)');
    expect(formatName(ubl(), { kind: 'pdf' })).toBe('ZUGFeRD · XRechnung 3.0');
  });

  it('sums the invoice up in one line', () => {
    expect(norm(oneLine(ubl(), i18nFor('de')))).toBe('Rechnung RE-2026-117 von Musterlieferant GmbH, 846,00 €, fällig am 28.11.2026');
  });
});

describe('printHtml', () => {
  it('prints the invoice with escaped text', () => {
    const inv = ubl();
    inv.seller.name = 'Evil <img src=x onerror=alert(1)> GmbH';
    const t = i18nFor('en').t;
    const html = printHtml(present(inv, { ...i18nFor('en'), source: { kind: 'xml' } }), t, { generatedFrom: 'from <xml>' });
    expect(html).toContain('<h1>Invoice RE-2026-117</h1>');
    expect(html).toContain('Fachbuch &lt;E-Rechnung&gt;');
    expect(html).toContain('Evil &lt;img src=x onerror=alert(1)&gt; GmbH');
    expect(html).not.toContain('<img');
    expect(html).toContain('from &lt;xml&gt;');
    expect(norm(html)).toContain('€846.00');
  });
});
