// Plausibility checks on a parsed invoice: do the sums add up, is what an
// invoice must name there, is it an e-invoice under German rules at all.
// Not a validation against the XRechnung or EN 16931 rule sets (that needs
// the KoSIT validator); it catches what a person checking the invoice
// would want to know.
//
// Each finding is { id, level, vars }: level 'ok' (shown as a tick),
// 'info' or 'warning'. The ids are locale keys under `check.`.

const CENT = 0.0101;

const sum = (values) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
const differs = (a, b) => Math.abs(a - b) > CENT;
const has = (v) => typeof v === 'number' && Number.isFinite(v);

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86_400_000);
}

export function checkInvoice(inv, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [];
  const t = inv.totals || {};
  const add = (id, level, vars = {}) => out.push({ id, level, vars });

  const missing = [];
  if (!inv.number) missing.push('number');
  if (!inv.issueDate) missing.push('issue_date');
  if (!inv.seller?.name) missing.push('seller');
  if (!inv.buyer?.name) missing.push('buyer');
  if (!inv.currency) missing.push('currency');
  if (missing.length) add('missing', 'warning', { fields: missing });

  // §14 UStG and BR-CO-26: the seller names a VAT ID or a tax number.
  if (inv.seller && !inv.seller.vatId && !inv.seller.taxNumber && !inv.seller.legalId) add('no_tax_id', 'warning');

  if (inv.profile?.level === 'minimum' || inv.profile?.level === 'basicwl') add('not_einvoice_profile', 'warning', { profile: inv.profile.name });
  if (inv.profile?.family === 'xrechnung' && !inv.buyerReference) add('no_buyer_reference', 'warning');

  let sumsChecked = 0;
  let sumsWrong = 0;
  const compare = (id, expected, actual) => {
    if (!has(expected) || !has(actual)) return;
    sumsChecked++;
    if (differs(expected, actual)) {
      sumsWrong++;
      add(id, 'warning', { expected, actual, currency: inv.currency || '' });
    }
  };

  // Sub-lines (CII ParentLineID) are part of their parent's amount.
  const topLines = (inv.lines || []).filter((l) => !l.parentId);
  if (topLines.length && topLines.every((l) => has(l.netAmount))) {
    compare('line_sum', sum(topLines.map((l) => l.netAmount)), t.lineTotal);
  }
  if (has(t.lineTotal)) {
    compare('tax_basis', sum([t.lineTotal, -(t.allowanceTotal || 0), t.chargeTotal || 0]), t.taxBasis);
  }
  const vat = inv.vat || [];
  if (vat.length && vat.every((v) => has(v.amount))) compare('vat_sum', sum(vat.map((v) => v.amount)), t.taxTotal);
  for (const v of vat) {
    if (!has(v.basis) || !has(v.rate) || !has(v.amount)) continue;
    const expected = Math.round(v.basis * v.rate) / 100;
    sumsChecked++;
    if (differs(expected, v.amount)) {
      sumsWrong++;
      add('vat_rate', 'warning', { rate: v.rate, expected, actual: v.amount, currency: inv.currency || '' });
    }
  }
  compare('grand_total', sum([t.taxBasis ?? NaN, t.taxTotal || 0]), t.grandTotal);
  // MINIMUM and BASIC WL have no prepaid amount, and an XRechnung extension
  // adds third-party payments to the amount due.
  const thinProfile = inv.profile?.level === 'minimum' || inv.profile?.level === 'basicwl';
  if (has(t.grandTotal) && !thinProfile && !inv.profile?.extension) {
    compare('amount_due', sum([t.grandTotal, -(t.prepaid || 0), t.rounding || 0]), t.due);
  }
  if (sumsChecked > 0 && sumsWrong === 0) add('sums_ok', 'ok');

  const transfer = (inv.payment?.means || []).some((m) => ['30', '42', '58'].includes(m.code));
  if (transfer && !(inv.payment.means || []).some((m) => m.iban)) add('no_iban', 'warning');

  if (inv.isCreditNote) add('credit_note', 'info');
  const due = t.due ?? t.grandTotal;
  if (inv.dueDate && has(due) && due > 0 && !inv.isCreditNote) {
    const days = daysBetween(today, inv.dueDate);
    if (days !== null && days < 0) add('overdue', 'info', { days: -days });
  }
  return out;
}
