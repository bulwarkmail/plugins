// A parsed invoice as what a person reads: labels in the user's language,
// amounts and dates in their format, codes as words. The dialog and the
// printout both draw from this, so they show the same thing.
//
// `t(key, vars)` and `has(key)` come from api.i18n; `locale` is the app's.

export function createFormat(locale) {
  const safeLocale = (() => {
    try { new Intl.NumberFormat(locale); return locale; } catch { return 'en'; }
  })();
  const money = (amount, currency) => {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
    if (/^[A-Z]{3}$/.test(currency || '')) {
      try {
        return new Intl.NumberFormat(safeLocale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
      } catch { /* unknown currency code */ }
    }
    return new Intl.NumberFormat(safeLocale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount) + (currency ? ` ${currency}` : '');
  };
  const number = (n) => (typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat(safeLocale, { maximumFractionDigits: 4 }).format(n) : '');
  const percent = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${new Intl.NumberFormat(safeLocale, { maximumFractionDigits: 2 }).format(n)} %` : '');
  const date = (iso) => {
    if (!iso) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const d = new Date(`${iso}T12:00:00Z`);
    try {
      return new Intl.DateTimeFormat(safeLocale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(d);
    } catch {
      return iso;
    }
  };
  return { money, number, percent, date, locale: safeLocale };
}

/** "DE89 3704 0044 0532 0130 00" from an IBAN without spaces. */
export function groupIban(iban) {
  const v = (iban || '').replace(/\s+/g, '');
  return /^[A-Z]{2}\d{2}[A-Z0-9]+$/i.test(v) ? v.replace(/(.{4})(?=.)/g, '$1 ') : iban || '';
}

function label(t, has, prefix, code, fallback = code) {
  if (!code) return '';
  const key = `${prefix}.${code}`;
  return has(key) ? t(key) : fallback;
}

function country(code, locale) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

function partyBlock(p, { t, fmt }) {
  if (!p) return null;
  const a = p.address || {};
  const cityLine = [a.postcode, a.city].filter(Boolean).join(' ');
  const lines = [
    p.tradingName && p.tradingName !== p.name ? p.tradingName : '',
    ...(a.lines || []),
    cityLine,
    a.region || '',
    a.country ? country(a.country, fmt.locale) : '',
  ].filter(Boolean);
  const details = [];
  if (p.vatId) details.push({ label: t('party.vat_id'), value: p.vatId });
  if (p.taxNumber) details.push({ label: t('party.tax_number'), value: p.taxNumber });
  if (p.legalId) details.push({ label: t('party.register'), value: p.legalId });
  if (p.id) details.push({ label: t('party.id'), value: p.id });
  if (p.contact?.name) details.push({ label: t('party.contact'), value: p.contact.name });
  if (p.contact?.phone) details.push({ label: t('party.phone'), value: p.contact.phone });
  if (p.contact?.email) details.push({ label: t('party.email'), value: p.contact.email });
  if (p.electronicAddress && p.electronicAddress !== p.contact?.email) details.push({ label: t('party.electronic_address'), value: p.electronicAddress });
  return { name: p.name || '', lines, details };
}

function period(start, end, fmt) {
  if (start && end) return `${fmt.date(start)} – ${fmt.date(end)}`;
  return fmt.date(start || end);
}

/** The amount to pay, or the credit's amount. */
export function amountDue(inv) {
  const t = inv.totals || {};
  return t.due ?? t.grandTotal ?? null;
}

export function documentTitle(inv, t, has) {
  return label(t, has, 'type', inv.typeCode, inv.isCreditNote ? t('type.381') : t('type.380'));
}

/** The format in words: "XRechnung 3.0 (UBL)", "ZUGFeRD / Factur-X · EN 16931". */
export function formatName(inv, source) {
  const syntax = { ubl: 'UBL', cii: 'CII', zugferd1: 'CII' }[inv.syntax] || '';
  const profile = inv.profile?.name || '';
  if (source?.kind === 'pdf') {
    if (inv.syntax === 'zugferd1') return profile || 'ZUGFeRD 1.0';
    if (inv.profile?.family === 'xrechnung') return `ZUGFeRD · ${profile}`;
    return profile ? `ZUGFeRD / Factur-X · ${profile}` : 'ZUGFeRD / Factur-X';
  }
  if (inv.profile?.family === 'xrechnung') return `${profile} (${syntax})`;
  return profile ? `${profile} (${syntax})` : `${syntax} e-invoice`;
}

/** Everything the dialog and the printout show, in display form. */
export function present(inv, { t, has, locale, source }) {
  const fmt = createFormat(locale);
  const cur = inv.currency || '';
  const money = (n) => fmt.money(n, cur);

  const facts = [];
  const fact = (key, value) => { if (value) facts.push({ label: t(key), value }); };
  fact('fact.number', inv.number);
  fact('fact.issue_date', fmt.date(inv.issueDate));
  fact('fact.due_date', fmt.date(inv.dueDate));
  fact('fact.delivery_date', fmt.date(inv.deliveryDate));
  fact('fact.period', period(inv.periodStart, inv.periodEnd, fmt));
  fact('fact.buyer_reference', inv.buyerReference);
  fact('fact.order', inv.orderReference);
  fact('fact.sales_order', inv.salesOrderReference);
  fact('fact.contract', inv.contractReference);
  fact('fact.project', inv.projectReference);
  for (const p of inv.precedingInvoices || []) {
    fact('fact.preceding', [p.number, p.date ? fmt.date(p.date) : ''].filter(Boolean).join(', '));
  }
  fact('fact.format', formatName(inv, source));

  const lines = (inv.lines || []).map((l, i) => {
    const qty = [fmt.number(l.quantity), label(t, has, 'unit', l.unit)].filter(Boolean).join(' ');
    const details = [
      l.description && l.description !== l.name ? l.description : '',
      l.sellerItemId ? `${t('line.item_number')} ${l.sellerItemId}` : '',
      l.periodStart || l.periodEnd ? period(l.periodStart, l.periodEnd, fmt) : '',
      ...(l.allowancesCharges || []).map((ac) => `${ac.charge ? t('line.charge') : t('line.allowance')}${ac.reason ? ` (${ac.reason})` : ''}: ${money(ac.amount)}`),
      l.note || '',
    ].filter(Boolean);
    return {
      key: `${l.id || ''}-${i}`,
      position: l.id || String(i + 1),
      name: l.name || l.description || '',
      details,
      quantity: qty,
      unitPrice: money(l.unitPrice) + (l.priceBaseQuantity && l.priceBaseQuantity !== 1 ? ` / ${fmt.number(l.priceBaseQuantity)}` : ''),
      vat: l.vatCategory === 'S' || l.vatRate ? fmt.percent(l.vatRate ?? 0) : label(t, has, 'vatcat', l.vatCategory),
      net: money(l.netAmount),
      sub: !!l.parentId,
    };
  });

  const tt = inv.totals || {};
  const summary = [];
  const row = (key, value, strong = false, vars) => {
    if (typeof value === 'number' && Number.isFinite(value)) summary.push({ label: t(key, vars), value: money(value), strong });
  };
  row('total.lines', tt.lineTotal);
  for (const ac of inv.allowancesCharges || []) {
    const name = ac.reason || label(t, has, ac.charge ? 'charge' : 'allowance', ac.reasonCode, '');
    summary.push({
      label: `${ac.charge ? t('total.charge') : t('total.allowance')}${name ? `: ${name}` : ''}`,
      value: money(ac.charge ? ac.amount : -(ac.amount || 0)),
    });
  }
  row('total.net', tt.taxBasis);
  for (const v of inv.vat || []) {
    const what = v.category === 'S' || (v.rate && v.category !== 'E')
      ? t('total.vat_rate', { rate: fmt.percent(v.rate ?? 0) })
      : `${t('total.vat')} (${label(t, has, 'vatcat', v.category)})`;
    summary.push({ label: what, value: money(v.amount ?? 0) });
  }
  if ((inv.vat || []).length === 0) row('total.vat', tt.taxTotal);
  row('total.gross', tt.grandTotal, tt.due === undefined || tt.due === tt.grandTotal);
  row('total.prepaid', tt.prepaid ? -tt.prepaid : undefined);
  row('total.rounding', tt.rounding || undefined);
  if (tt.due !== undefined && tt.due !== tt.grandTotal) row(inv.isCreditNote ? 'total.credit' : 'total.due', tt.due, true);

  const vatRows = (inv.vat || []).map((v, i) => ({
    key: String(i),
    category: label(t, has, 'vatcat', v.category),
    rate: fmt.percent(v.rate ?? 0),
    basis: money(v.basis),
    amount: money(v.amount),
    reason: v.exemptionReason || (v.exemptionCode ? label(t, has, 'vatex', v.exemptionCode) : ''),
  }));

  const payment = [];
  const pay = (key, value) => { if (value) payment.push({ label: t(key), value }); };
  const means = inv.payment?.means || [];
  for (const m of means) {
    pay('pay.means', label(t, has, 'means', m.code, m.text || m.code));
    pay('pay.account_name', m.accountName);
    pay('pay.iban', groupIban(m.iban));
    pay('pay.bic', m.bic);
    pay('pay.debited_iban', groupIban(m.debitedIban));
    pay('pay.card', m.card ? `•••• ${m.card.slice(-4)}` : '');
  }
  pay('pay.reference', inv.payment?.reference);
  pay('pay.mandate', inv.payment?.mandateId);
  pay('pay.creditor_id', inv.payment?.creditorId);
  pay('pay.terms', inv.payment?.terms);

  const attachments = (inv.attachments || []).map((a, i) => ({
    key: String(i),
    name: a.filename || a.id || t('attachment.unnamed'),
    description: a.description || '',
    mimeType: a.mimeType || '',
    size: a.base64 ? Math.floor((a.base64.length * 3) / 4) : 0,
    base64: a.base64 || '',
    uri: a.uri || '',
  }));

  return {
    title: documentTitle(inv, t, has),
    number: inv.number || '',
    currency: cur,
    due: money(amountDue(inv)),
    facts,
    seller: partyBlock(inv.seller, { t, fmt }),
    buyer: partyBlock(inv.buyer, { t, fmt }),
    payee: inv.payee?.name && inv.payee.name !== inv.seller?.name ? partyBlock(inv.payee, { t, fmt }) : null,
    shipTo: inv.shipTo?.name || inv.shipTo?.address ? partyBlock(inv.shipTo, { t, fmt }) : null,
    lines,
    summary,
    vatRows,
    payment,
    notes: inv.notes || [],
    attachments,
    noLines: lines.length === 0,
  };
}

/** One line for the banner and the forward: "Invoice 2026-117 from Supplier GmbH, 1.190,00 €, due 15.11.2026". */
export function oneLine(inv, { t, has, locale }) {
  const fmt = createFormat(locale);
  const vars = {
    title: documentTitle(inv, t, has),
    number: inv.number || '',
    seller: inv.seller?.name || '',
    amount: fmt.money(amountDue(inv), inv.currency),
    due: fmt.date(inv.dueDate),
  };
  return t(inv.dueDate && !inv.isCreditNote ? 'summary.with_due' : 'summary.plain', vars);
}
