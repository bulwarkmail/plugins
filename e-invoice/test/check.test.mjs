// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { checkInvoice } from '../src/lib/check.js';
import { parseInvoice } from '../src/lib/parse.js';
import { fixture } from './helpers.mjs';

const base = () => parseInvoice(fixture('xrechnung-ubl.xml'));
const ids = (findings, level) => findings.filter((f) => !level || f.level === level).map((f) => f.id);

describe('checkInvoice', () => {
  it('finds nothing wrong with a sound invoice', () => {
    const findings = checkInvoice(base(), { today: '2026-10-30' });
    expect(ids(findings, 'warning')).toEqual([]);
    expect(ids(findings)).toEqual(['sums_ok']);
  });

  it('notices items that do not add up to the total', () => {
    const inv = base();
    inv.lines[1].netAmount = 60;
    const [finding] = checkInvoice(inv, { today: '2026-10-30' }).filter((f) => f.level === 'warning');
    expect(finding).toEqual({ id: 'line_sum', level: 'warning', vars: { expected: 860, actual: 850, currency: 'EUR' } });
    expect(ids(checkInvoice(inv))).not.toContain('sums_ok');
  });

  it('notices a wrong VAT amount and a wrong total', () => {
    const inv = base();
    inv.vat[1].amount = 5;
    inv.totals.grandTotal = 950;
    const found = ids(checkInvoice(inv, { today: '2026-10-30' }), 'warning');
    expect(found).toEqual(expect.arrayContaining(['vat_rate', 'vat_sum', 'grand_total', 'amount_due']));
  });

  it('allows a cent of rounding', () => {
    const inv = base();
    inv.vat[0].amount = 142.51;
    inv.totals.taxTotal = 146.01;
    inv.totals.grandTotal = 946.01;
    inv.totals.due = 846.01;
    expect(ids(checkInvoice(inv, { today: '2026-10-30' }), 'warning')).toEqual([]);
  });

  it('says what an invoice lacks', () => {
    const inv = base();
    delete inv.number;
    delete inv.buyer;
    inv.seller.vatId = '';
    delete inv.buyerReference;
    inv.payment.means[0].iban = '';
    const findings = checkInvoice(inv, { today: '2026-10-30' });
    expect(findings.find((f) => f.id === 'missing').vars.fields).toEqual(['number', 'buyer']);
    expect(ids(findings, 'warning')).toEqual(expect.arrayContaining(['missing', 'no_buyer_reference', 'no_iban']));
    // The seller still has a registration number.
    expect(ids(findings)).not.toContain('no_tax_id');
    inv.seller.legalId = '';
    expect(ids(checkInvoice(inv))).toContain('no_tax_id');
  });

  it('warns that MINIMUM and BASIC WL are no e-invoices in Germany', () => {
    const inv = base();
    inv.profile = { name: 'MINIMUM', family: 'facturx', level: 'minimum' };
    inv.totals.due = 500;
    const found = checkInvoice(inv, { today: '2026-10-30' });
    expect(found.find((f) => f.id === 'not_einvoice_profile').vars.profile).toBe('MINIMUM');
    // MINIMUM has no prepaid amount, so the amount due can't be checked.
    expect(ids(found)).not.toContain('amount_due');
  });

  it('says when an invoice is overdue, but not for a credit note', () => {
    expect(checkInvoice(base(), { today: '2026-12-08' }).find((f) => f.id === 'overdue')).toEqual({ id: 'overdue', level: 'info', vars: { days: 10 } });
    const credit = { ...base(), isCreditNote: true };
    expect(ids(checkInvoice(credit, { today: '2026-12-08' }))).toEqual(['sums_ok', 'credit_note']);
  });
});
