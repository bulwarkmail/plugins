// Invoice XML to one plain invoice object, for the three syntaxes German
// e-invoices come in:
// - UBL 2.1 Invoice / CreditNote (XRechnung UBL, Peppol BIS),
// - UN/CEFACT CII D16B CrossIndustryInvoice (XRechnung CII, ZUGFeRD 2.x,
//   Factur-X),
// - ZUGFeRD 1.0 CrossIndustryDocument.
// Field names follow EN 16931 (BT-1 is `number`, and so on). Everything
// is optional: what the XML leaves out is '' or null.

import { all, attr, block, kids, num, one, parseXml, text } from './xml.js';

/** Which syntax a document is, from its root element; null for anything else. */
export function syntaxOf(doc) {
  const root = doc.documentElement;
  const ns = root.namespaceURI || '';
  if ((root.localName === 'Invoice' || root.localName === 'CreditNote') && ns.includes('oasis')) return 'ubl';
  if (root.localName === 'CrossIndustryInvoice') return 'cii';
  if (root.localName === 'CrossIndustryDocument') return 'zugferd1';
  return null;
}

/** Whether a piece of text is invoice XML, from its first bytes (cheap). */
export function looksLikeInvoiceXml(head) {
  return /<(?:[\w.-]+:)?(?:CrossIndustryInvoice|CrossIndustryDocument)\b/.test(head)
    || /<(?:[\w.-]+:)?(?:Invoice|CreditNote)\b[^>]*urn:oasis:names:specification:ubl/.test(head);
}

/** YYYYMMDD (CII format 102) or YYYY-MM-DD to YYYY-MM-DD; other forms as given. */
function isoDate(value, format) {
  const v = (value || '').trim();
  if (!v) return '';
  if (/^\d{8}$/.test(v) && (!format || format === '102')) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  if (/^\d{6}$/.test(v) && format === '610') return `${v.slice(0, 4)}-${v.slice(4, 6)}`;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1] : v;
}

function ciiDate(el, ...paths) {
  const node = one(el, ...paths.map((p) => `${p}/DateTimeString`)) || one(el, ...paths.map((p) => `${p}/DateString`));
  return node ? isoDate(node.textContent, attr(node, 'format')) : '';
}

function compact(obj) {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0)) delete obj[key];
  }
  return obj;
}

/** The profile in words, from the specification identifier (BT-24). */
export function profileOf(id) {
  const v = (id || '').toLowerCase();
  if (!v) return { name: '', family: '' };
  const xr = /xrechnung_(\d+(?:\.\d+)*)/.exec(v);
  if (xr) return { name: `XRechnung ${xr[1]}`, family: 'xrechnung', extension: v.includes('#conformant#') };
  if (v.includes('xrechnung')) return { name: 'XRechnung', family: 'xrechnung' };
  if (v.includes('peppol')) return { name: 'Peppol BIS Billing 3.0', family: 'peppol' };
  if (v.startsWith('urn:ferd:')) {
    // 1.0 and its release candidate (urn:ferd:invoice:rc:comfort).
    const level = /:(basic|comfort|extended)$/.exec(v)?.[1] || '';
    return { name: `ZUGFeRD 1.0 ${level.toUpperCase()}`.trim(), family: 'zugferd1', level };
  }
  if (v.includes('minimum')) return { name: 'MINIMUM', family: 'facturx', level: 'minimum' };
  if (v.includes('basicwl')) return { name: 'BASIC WL', family: 'facturx', level: 'basicwl' };
  if (v.includes('extended')) return { name: 'EXTENDED', family: 'facturx', level: 'extended' };
  if (v.includes('basic')) return { name: 'BASIC', family: 'facturx', level: 'basic' };
  if (v.startsWith('urn:cen.eu:en16931:2017')) return { name: 'EN 16931', family: 'en16931', level: 'en16931' };
  return { name: id, family: '' };
}

// ─── CII and ZUGFeRD 1.0 ──────────────────────────────────────

function ciiParty(p) {
  if (!p) return null;
  const address = one(p, 'PostalTradeAddress');
  const taxIds = all(p, 'SpecifiedTaxRegistration/ID');
  const contact = one(p, 'DefinedTradeContact');
  return compact({
    name: text(p, 'Name'),
    tradingName: text(p, 'SpecifiedLegalOrganization/TradingBusinessName'),
    id: text(p, 'ID') || text(p, 'GlobalID'),
    legalId: text(p, 'SpecifiedLegalOrganization/ID'),
    vatId: text(taxIds.find((t) => attr(t, 'schemeID') === 'VA')),
    taxNumber: text(taxIds.find((t) => attr(t, 'schemeID') === 'FC')),
    electronicAddress: text(p, 'URIUniversalCommunication/URIID'),
    address: address ? compact({
      lines: [text(address, 'LineOne'), text(address, 'LineTwo'), text(address, 'LineThree')].filter(Boolean),
      postcode: text(address, 'PostcodeCode'),
      city: text(address, 'CityName'),
      region: text(address, 'CountrySubDivisionName'),
      country: text(address, 'CountryID'),
    }) : null,
    contact: contact ? compact({
      name: text(contact, 'PersonName') || text(contact, 'DepartmentName'),
      phone: text(contact, 'TelephoneUniversalCommunication/CompleteNumber'),
      email: text(contact, 'EmailURIUniversalCommunication/URIID'),
    }) : null,
  });
}

function ciiAllowanceCharge(ac) {
  const indicator = text(ac, 'ChargeIndicator/Indicator', 'ChargeIndicator').toLowerCase();
  return compact({
    charge: indicator === 'true',
    amount: num(ac, 'ActualAmount'),
    baseAmount: num(ac, 'BasisAmount'),
    percent: num(ac, 'CalculationPercent'),
    reason: text(ac, 'Reason'),
    reasonCode: text(ac, 'ReasonCode'),
    vatCategory: text(ac, 'CategoryTradeTax/CategoryCode'),
    vatRate: num(ac, 'CategoryTradeTax/RateApplicablePercent', 'CategoryTradeTax/ApplicablePercent'),
  });
}

function ciiAttachments(agreement) {
  return all(agreement, 'AdditionalReferencedDocument').map((d) => {
    const bin = one(d, 'AttachmentBinaryObject');
    return compact({
      id: text(d, 'IssuerAssignedID'),
      description: text(d, 'Name'),
      typeCode: text(d, 'TypeCode'),
      uri: text(d, 'URIID'),
      filename: attr(bin, 'filename'),
      mimeType: attr(bin, 'mimeCode'),
      base64: bin ? bin.textContent.replace(/\s+/g, '') : '',
    });
  });
}

function parseCii(doc, syntax) {
  const root = doc.documentElement;
  const v1 = syntax === 'zugferd1';
  const context = one(root, v1 ? 'SpecifiedExchangedDocumentContext' : 'ExchangedDocumentContext');
  const header = one(root, v1 ? 'HeaderExchangedDocument' : 'ExchangedDocument');
  const tx = one(root, v1 ? 'SpecifiedSupplyChainTradeTransaction' : 'SupplyChainTradeTransaction');
  const agreement = one(tx, v1 ? 'ApplicableSupplyChainTradeAgreement' : 'ApplicableHeaderTradeAgreement');
  const delivery = one(tx, v1 ? 'ApplicableSupplyChainTradeDelivery' : 'ApplicableHeaderTradeDelivery');
  const settlement = one(tx, v1 ? 'ApplicableSupplyChainTradeSettlement' : 'ApplicableHeaderTradeSettlement');
  const sums = one(settlement, v1 ? 'SpecifiedTradeSettlementMonetarySummation' : 'SpecifiedTradeSettlementHeaderMonetarySummation');
  // Some senders leave the code empty; the amounts still carry it.
  const currency = text(settlement, 'InvoiceCurrencyCode') || attr(doc.querySelector('[currencyID]'), 'currencyID');

  // TaxTotalAmount may come twice: in the invoice currency and in the VAT currency.
  const taxTotals = all(sums, 'TaxTotalAmount');
  const taxTotal = taxTotals.find((t) => !attr(t, 'currencyID') || attr(t, 'currencyID') === currency) || taxTotals[0];

  const lines = kids(tx, 'IncludedSupplyChainTradeLineItem').map((li) => {
    const lineAgreement = one(li, v1 ? 'SpecifiedSupplyChainTradeAgreement' : 'SpecifiedLineTradeAgreement');
    const lineDelivery = one(li, v1 ? 'SpecifiedSupplyChainTradeDelivery' : 'SpecifiedLineTradeDelivery');
    const lineSettlement = one(li, v1 ? 'SpecifiedSupplyChainTradeSettlement' : 'SpecifiedLineTradeSettlement');
    const product = one(li, 'SpecifiedTradeProduct');
    const qty = one(lineDelivery, 'BilledQuantity');
    const netPrice = one(lineAgreement, 'NetPriceProductTradePrice');
    return compact({
      id: text(li, 'AssociatedDocumentLineDocument/LineID'),
      parentId: text(li, 'AssociatedDocumentLineDocument/ParentLineID'),
      note: block(li, 'AssociatedDocumentLineDocument/IncludedNote/Content'),
      name: text(product, 'Name'),
      description: block(product, 'Description'),
      sellerItemId: text(product, 'SellerAssignedID'),
      standardItemId: text(product, 'GlobalID'),
      quantity: qty ? num(qty) : null,
      unit: attr(qty, 'unitCode'),
      unitPrice: num(netPrice, 'ChargeAmount'),
      priceBaseQuantity: num(netPrice, 'BasisQuantity'),
      grossPrice: num(lineAgreement, 'GrossPriceProductTradePrice/ChargeAmount'),
      vatCategory: text(lineSettlement, 'ApplicableTradeTax/CategoryCode'),
      vatRate: num(lineSettlement, 'ApplicableTradeTax/RateApplicablePercent', 'ApplicableTradeTax/ApplicablePercent'),
      netAmount: num(lineSettlement, v1 ? 'SpecifiedTradeSettlementMonetarySummation/LineTotalAmount' : 'SpecifiedTradeSettlementLineMonetarySummation/LineTotalAmount'),
      periodStart: ciiDate(lineSettlement, 'BillingSpecifiedPeriod/StartDateTime'),
      periodEnd: ciiDate(lineSettlement, 'BillingSpecifiedPeriod/EndDateTime'),
      allowancesCharges: kids(lineSettlement, 'SpecifiedTradeAllowanceCharge').map(ciiAllowanceCharge),
    });
  });

  const means = kids(settlement, 'SpecifiedTradeSettlementPaymentMeans').map((pm) => compact({
    code: text(pm, 'TypeCode'),
    text: text(pm, 'Information'),
    iban: text(pm, 'PayeePartyCreditorFinancialAccount/IBANID') || text(pm, 'PayeePartyCreditorFinancialAccount/ProprietaryID'),
    accountName: text(pm, 'PayeePartyCreditorFinancialAccount/AccountName'),
    bic: text(pm, 'PayeeSpecifiedCreditorFinancialInstitution/BICID'),
    debitedIban: text(pm, 'PayerPartyDebtorFinancialAccount/IBANID'),
    card: text(pm, 'ApplicableTradeSettlementFinancialCard/ID'),
  }));
  const terms = kids(settlement, 'SpecifiedTradePaymentTerms');

  return {
    syntax,
    profileId: text(context, 'GuidelineSpecifiedDocumentContextParameter/ID'),
    processId: text(context, 'BusinessProcessSpecifiedDocumentContextParameter/ID'),
    number: text(header, 'ID'),
    typeCode: text(header, 'TypeCode'),
    issueDate: ciiDate(header, 'IssueDateTime'),
    dueDate: terms.map((t) => ciiDate(t, 'DueDateDateTime')).find(Boolean) || '',
    currency,
    taxCurrency: text(settlement, 'TaxCurrencyCode'),
    notes: kids(header, 'IncludedNote').map((n) => block(n, 'Content')).filter(Boolean),
    buyerReference: text(agreement, 'BuyerReference'),
    orderReference: text(agreement, 'BuyerOrderReferencedDocument/IssuerAssignedID'),
    salesOrderReference: text(agreement, 'SellerOrderReferencedDocument/IssuerAssignedID'),
    contractReference: text(agreement, 'ContractReferencedDocument/IssuerAssignedID'),
    projectReference: [text(agreement, 'SpecifiedProcuringProject/ID'), text(agreement, 'SpecifiedProcuringProject/Name')].filter(Boolean).join(' '),
    precedingInvoices: kids(settlement, 'InvoiceReferencedDocument').map((d) => compact({ number: text(d, 'IssuerAssignedID'), date: ciiDate(d, 'FormattedIssueDateTime') })),
    deliveryDate: ciiDate(delivery, 'ActualDeliverySupplyChainEvent/OccurrenceDateTime'),
    periodStart: ciiDate(settlement, 'BillingSpecifiedPeriod/StartDateTime'),
    periodEnd: ciiDate(settlement, 'BillingSpecifiedPeriod/EndDateTime'),
    seller: ciiParty(one(agreement, 'SellerTradeParty')),
    buyer: ciiParty(one(agreement, 'BuyerTradeParty')),
    payee: ciiParty(one(settlement, 'PayeeTradeParty')),
    shipTo: ciiParty(one(delivery, 'ShipToTradeParty')),
    lines,
    allowancesCharges: kids(settlement, 'SpecifiedTradeAllowanceCharge').map(ciiAllowanceCharge),
    vat: kids(settlement, 'ApplicableTradeTax').map((t) => compact({
      category: text(t, 'CategoryCode'),
      rate: num(t, 'RateApplicablePercent', 'ApplicablePercent'),
      basis: num(t, 'BasisAmount'),
      amount: num(t, 'CalculatedAmount'),
      exemptionReason: text(t, 'ExemptionReason'),
      exemptionCode: text(t, 'ExemptionReasonCode'),
    })),
    totals: compact({
      lineTotal: num(sums, 'LineTotalAmount'),
      allowanceTotal: num(sums, 'AllowanceTotalAmount'),
      chargeTotal: num(sums, 'ChargeTotalAmount'),
      taxBasis: num(sums, 'TaxBasisTotalAmount'),
      taxTotal: taxTotal ? num(taxTotal) : null,
      rounding: num(sums, 'RoundingAmount'),
      grandTotal: num(sums, 'GrandTotalAmount'),
      prepaid: num(sums, 'TotalPrepaidAmount'),
      due: num(sums, 'DuePayableAmount'),
    }),
    payment: compact({
      means,
      reference: text(settlement, 'PaymentReference'),
      terms: terms.map((t) => block(t, 'Description')).filter(Boolean).join('\n'),
      mandateId: terms.map((t) => text(t, 'DirectDebitMandateID')).find(Boolean) || '',
      creditorId: text(settlement, 'CreditorReferenceID'),
    }),
    attachments: ciiAttachments(agreement),
  };
}

// ─── UBL ──────────────────────────────────────────────────────

function ublParty(p) {
  if (!p) return null;
  const address = one(p, 'PostalAddress');
  const schemes = all(p, 'PartyTaxScheme');
  const vat = schemes.find((s) => text(s, 'TaxScheme/ID').toUpperCase() === 'VAT');
  const other = schemes.find((s) => s !== vat);
  const contact = one(p, 'Contact');
  const legal = one(p, 'PartyLegalEntity');
  const legalName = text(legal, 'RegistrationName');
  const tradingName = text(p, 'PartyName/Name');
  return compact({
    name: legalName || tradingName,
    tradingName: legalName && tradingName !== legalName ? tradingName : '',
    id: text(p, 'PartyIdentification/ID'),
    legalId: text(legal, 'CompanyID'),
    vatId: text(vat, 'CompanyID'),
    taxNumber: text(other, 'CompanyID'),
    electronicAddress: text(p, 'EndpointID'),
    address: address ? compact({
      lines: [text(address, 'StreetName'), text(address, 'AdditionalStreetName'), text(address, 'AddressLine/Line')].filter(Boolean),
      postcode: text(address, 'PostalZone'),
      city: text(address, 'CityName'),
      region: text(address, 'CountrySubentity'),
      country: text(address, 'Country/IdentificationCode'),
    }) : null,
    contact: contact ? compact({
      name: text(contact, 'Name'),
      phone: text(contact, 'Telephone'),
      email: text(contact, 'ElectronicMail'),
    }) : null,
  });
}

function ublAllowanceCharge(ac) {
  return compact({
    charge: text(ac, 'ChargeIndicator').toLowerCase() === 'true',
    amount: num(ac, 'Amount'),
    baseAmount: num(ac, 'BaseAmount'),
    percent: num(ac, 'MultiplierFactorNumeric'),
    reason: text(ac, 'AllowanceChargeReason'),
    reasonCode: text(ac, 'AllowanceChargeReasonCode'),
    vatCategory: text(ac, 'TaxCategory/ID'),
    vatRate: num(ac, 'TaxCategory/Percent'),
  });
}

function parseUbl(doc) {
  const root = doc.documentElement;
  const credit = root.localName === 'CreditNote';
  const sums = one(root, 'LegalMonetaryTotal');
  const currency = text(root, 'DocumentCurrencyCode') || attr(doc.querySelector('[currencyID]'), 'currencyID');
  const taxTotals = kids(root, 'TaxTotal');
  const mainTax = taxTotals.find((t) => attr(one(t, 'TaxAmount'), 'currencyID') === currency) || taxTotals[0];
  const delivery = one(root, 'Delivery');

  const lines = kids(root, credit ? 'CreditNoteLine' : 'InvoiceLine').map((li) => {
    const qty = one(li, credit ? 'CreditedQuantity' : 'InvoicedQuantity');
    const item = one(li, 'Item');
    const price = one(li, 'Price');
    const priceAllowance = one(price, 'AllowanceCharge');
    return compact({
      id: text(li, 'ID'),
      note: block(li, 'Note'),
      name: text(item, 'Name'),
      description: block(item, 'Description'),
      sellerItemId: text(item, 'SellersItemIdentification/ID'),
      standardItemId: text(item, 'StandardItemIdentification/ID'),
      quantity: qty ? num(qty) : null,
      unit: attr(qty, 'unitCode'),
      unitPrice: num(price, 'PriceAmount'),
      priceBaseQuantity: num(price, 'BaseQuantity'),
      grossPrice: num(priceAllowance, 'BaseAmount'),
      vatCategory: text(item, 'ClassifiedTaxCategory/ID'),
      vatRate: num(item, 'ClassifiedTaxCategory/Percent'),
      netAmount: num(li, 'LineExtensionAmount'),
      periodStart: isoDate(text(li, 'InvoicePeriod/StartDate')),
      periodEnd: isoDate(text(li, 'InvoicePeriod/EndDate')),
      allowancesCharges: kids(li, 'AllowanceCharge').map(ublAllowanceCharge),
    });
  });

  const means = kids(root, 'PaymentMeans').map((pm) => compact({
    code: text(pm, 'PaymentMeansCode'),
    text: attr(one(pm, 'PaymentMeansCode'), 'name'),
    iban: text(pm, 'PayeeFinancialAccount/ID'),
    accountName: text(pm, 'PayeeFinancialAccount/Name'),
    bic: text(pm, 'PayeeFinancialAccount/FinancialInstitutionBranch/ID'),
    debitedIban: text(pm, 'PaymentMandate/PayerFinancialAccount/ID'),
    card: text(pm, 'CardAccount/PrimaryAccountNumberID'),
    reference: text(pm, 'PaymentID'),
    mandateId: text(pm, 'PaymentMandate/ID'),
  }));

  return {
    syntax: 'ubl',
    profileId: text(root, 'CustomizationID'),
    processId: text(root, 'ProfileID'),
    number: text(root, 'ID'),
    typeCode: text(root, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode') || (credit ? '381' : '380'),
    issueDate: isoDate(text(root, 'IssueDate')),
    dueDate: isoDate(text(root, 'DueDate') || text(root, 'PaymentMeans/PaymentDueDate')),
    currency,
    taxCurrency: text(root, 'TaxCurrencyCode'),
    notes: kids(root, 'Note').map((n) => block(n)).filter(Boolean),
    buyerReference: text(root, 'BuyerReference'),
    orderReference: text(root, 'OrderReference/ID'),
    salesOrderReference: text(root, 'OrderReference/SalesOrderID'),
    contractReference: text(root, 'ContractDocumentReference/ID'),
    projectReference: text(root, 'ProjectReference/ID'),
    precedingInvoices: all(root, 'BillingReference/InvoiceDocumentReference').map((d) => compact({ number: text(d, 'ID'), date: isoDate(text(d, 'IssueDate')) })),
    deliveryDate: isoDate(text(delivery, 'ActualDeliveryDate')),
    periodStart: isoDate(text(root, 'InvoicePeriod/StartDate')),
    periodEnd: isoDate(text(root, 'InvoicePeriod/EndDate')),
    seller: ublParty(one(root, 'AccountingSupplierParty/Party')),
    buyer: ublParty(one(root, 'AccountingCustomerParty/Party')),
    payee: ublParty(one(root, 'PayeeParty')),
    shipTo: delivery && one(delivery, 'DeliveryLocation') ? compact({
      name: text(delivery, 'DeliveryParty/PartyName/Name'),
      address: compact({
        lines: [text(delivery, 'DeliveryLocation/Address/StreetName'), text(delivery, 'DeliveryLocation/Address/AdditionalStreetName')].filter(Boolean),
        postcode: text(delivery, 'DeliveryLocation/Address/PostalZone'),
        city: text(delivery, 'DeliveryLocation/Address/CityName'),
        country: text(delivery, 'DeliveryLocation/Address/Country/IdentificationCode'),
      }),
    }) : null,
    lines,
    allowancesCharges: kids(root, 'AllowanceCharge').map(ublAllowanceCharge),
    vat: kids(mainTax, 'TaxSubtotal').map((s) => compact({
      category: text(s, 'TaxCategory/ID'),
      rate: num(s, 'TaxCategory/Percent'),
      basis: num(s, 'TaxableAmount'),
      amount: num(s, 'TaxAmount'),
      exemptionReason: text(s, 'TaxCategory/TaxExemptionReason'),
      exemptionCode: text(s, 'TaxCategory/TaxExemptionReasonCode'),
    })),
    totals: compact({
      lineTotal: num(sums, 'LineExtensionAmount'),
      allowanceTotal: num(sums, 'AllowanceTotalAmount'),
      chargeTotal: num(sums, 'ChargeTotalAmount'),
      taxBasis: num(sums, 'TaxExclusiveAmount'),
      taxTotal: num(mainTax, 'TaxAmount'),
      rounding: num(sums, 'PayableRoundingAmount'),
      grandTotal: num(sums, 'TaxInclusiveAmount'),
      prepaid: num(sums, 'PrepaidAmount'),
      due: num(sums, 'PayableAmount'),
    }),
    payment: compact({
      means,
      reference: means.map((m) => m.reference).find(Boolean) || '',
      terms: kids(root, 'PaymentTerms').map((t) => block(t, 'Note')).filter(Boolean).join('\n'),
      mandateId: means.map((m) => m.mandateId).find(Boolean) || '',
      creditorId: all(root, 'AccountingSupplierParty/Party/PartyIdentification/ID').filter((e) => attr(e, 'schemeID') === 'SEPA').map((e) => text(e))[0] || '',
    }),
    attachments: kids(root, 'AdditionalDocumentReference').map((d) => {
      const bin = one(d, 'Attachment/EmbeddedDocumentBinaryObject');
      return compact({
        id: text(d, 'ID'),
        description: text(d, 'DocumentDescription'),
        typeCode: text(d, 'DocumentTypeCode'),
        uri: text(d, 'Attachment/ExternalReference/URI'),
        filename: attr(bin, 'filename'),
        mimeType: attr(bin, 'mimeCode'),
        base64: bin ? bin.textContent.replace(/\s+/g, '') : '',
      });
    }),
  };
}

/** Parse invoice XML. Throws when it is not XML or not an invoice. */
export function parseInvoice(xmlText) {
  const doc = parseXml(xmlText.replace(/^﻿/, ''));
  const syntax = syntaxOf(doc);
  if (!syntax) throw new Error('not an e-invoice');
  const invoice = syntax === 'ubl' ? parseUbl(doc) : parseCii(doc, syntax);
  for (const key of Object.keys(invoice)) {
    const v = invoice[key];
    if (v === null || v === undefined) delete invoice[key];
  }
  invoice.profile = profileOf(invoice.profileId);
  invoice.isCreditNote = ['381', '396', '81', '83', '532'].includes(invoice.typeCode) || (syntax === 'ubl' && doc.documentElement.localName === 'CreditNote');
  return invoice;
}
