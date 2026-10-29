// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseInvoice, profileOf } from '../src/lib/parse.js';
import { fixture } from './helpers.mjs';

describe('parseInvoice', () => {
  // The two fixtures are one invoice in two syntaxes; both must read the same.
  for (const [name, syntax] of [['xrechnung-ubl.xml', 'ubl'], ['zugferd-cii.xml', 'cii']]) {
    describe(name, () => {
      const inv = parseInvoice(fixture(name));

      it('reads the header', () => {
        expect(inv.syntax).toBe(syntax);
        expect(inv).toMatchObject({
          number: 'RE-2026-117', typeCode: '380', issueDate: '2026-10-29', dueDate: '2026-11-28',
          currency: 'EUR', buyerReference: '04011000-12345-34', orderReference: 'PO-4711', isCreditNote: false,
        });
        expect(inv.notes[0]).toMatch(/^Vielen Dank für Ihren Auftrag\./);
      });

      it('reads seller and buyer', () => {
        expect(inv.seller).toMatchObject({ name: 'Musterlieferant GmbH', vatId: 'DE123456789' });
        expect(inv.seller.address).toMatchObject({ lines: ['Hauptstraße 1'], postcode: '31134', city: 'Hildesheim', country: 'DE' });
        expect(inv.seller.contact).toMatchObject({ name: 'Erika Muster', email: 'erika@musterlieferant.example' });
        expect(inv.buyer).toMatchObject({ name: 'Beispielkunde AG' });
        expect(inv.buyer.address.city).toBe('Hannover');
      });

      it('reads the lines, the discount, the VAT breakdown and the totals', () => {
        expect(inv.lines).toHaveLength(2);
        expect(inv.lines[0]).toMatchObject({ id: '1', name: 'Beratung', description: 'Vor-Ort-Termin am 27.10.', sellerItemId: 'B-100', quantity: 8, unit: 'HUR', unitPrice: 100, vatCategory: 'S', vatRate: 19, netAmount: 800 });
        expect(inv.lines[1]).toMatchObject({ quantity: 2, unit: 'C62', unitPrice: 25, vatRate: 7, netAmount: 50 });
        expect(inv.allowancesCharges).toEqual([expect.objectContaining({ charge: false, amount: 50, reason: 'Treuerabatt', vatRate: 19 })]);
        expect(inv.vat).toEqual([
          expect.objectContaining({ category: 'S', rate: 19, basis: 750, amount: 142.5 }),
          expect.objectContaining({ category: 'S', rate: 7, basis: 50, amount: 3.5 }),
        ]);
        expect(inv.totals).toMatchObject({ lineTotal: 850, allowanceTotal: 50, taxBasis: 800, taxTotal: 146, grandTotal: 946, prepaid: 100, due: 846 });
      });

      it('reads the payment', () => {
        expect(inv.payment.means[0]).toMatchObject({ code: '58', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', accountName: 'Musterlieferant GmbH' });
        expect(inv.payment.reference).toBe('RE-2026-117');
        expect(inv.payment.terms).toBe('Zahlbar innerhalb von 30 Tagen ohne Abzug.');
      });
    });
  }

  it('reads names that hold markup as text', () => {
    expect(parseInvoice(fixture('xrechnung-ubl.xml')).lines[1].name).toBe('Fachbuch <E-Rechnung>');
  });

  it('reads the documents an XRechnung carries', () => {
    expect(parseInvoice(fixture('xrechnung-ubl.xml')).attachments).toEqual([
      expect.objectContaining({ id: 'Stundennachweis', filename: 'stundennachweis.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQKJSVFT0YK' }),
    ]);
  });

  it('tells the profiles apart', () => {
    expect(parseInvoice(fixture('xrechnung-ubl.xml')).profile).toMatchObject({ name: 'XRechnung 3.0', family: 'xrechnung' });
    expect(parseInvoice(fixture('zugferd-cii.xml')).profile).toMatchObject({ name: 'EN 16931' });
    expect(profileOf('urn:factur-x.eu:1p0:minimum')).toMatchObject({ level: 'minimum' });
    expect(profileOf('urn:factur-x.eu:1p0:basicwl')).toMatchObject({ level: 'basicwl' });
    expect(profileOf('urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic')).toMatchObject({ level: 'basic' });
    expect(profileOf('urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended')).toMatchObject({ level: 'extended' });
    expect(profileOf('urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0#conformant#urn:xeinkauf.de:kosit:extension:xrechnung_3.0')).toMatchObject({ name: 'XRechnung 3.0', extension: true });
    expect(profileOf('urn:ferd:CrossIndustryDocument:invoice:1p0:comfort')).toMatchObject({ name: 'ZUGFeRD 1.0 COMFORT' });
    expect(profileOf('urn:fdc:peppol.eu:2017:poacc:billing:3.0')).toMatchObject({ family: 'peppol' });
  });

  it('reads a ZUGFeRD 1.0 document', () => {
    const inv = parseInvoice(`<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryDocument xmlns:rsm="urn:ferd:CrossIndustryDocument:invoice:1p0" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:12" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:15">
  <rsm:SpecifiedExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:ferd:CrossIndustryDocument:invoice:1p0:basic</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:SpecifiedExchangedDocumentContext>
  <rsm:HeaderExchangedDocument><ram:ID>471102</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20130305</udt:DateTimeString></ram:IssueDateTime></rsm:HeaderExchangedDocument>
  <rsm:SpecifiedSupplyChainTradeTransaction>
    <ram:ApplicableSupplyChainTradeAgreement><ram:SellerTradeParty><ram:Name>Lieferant GmbH</ram:Name></ram:SellerTradeParty><ram:BuyerTradeParty><ram:Name>Kunden AG</ram:Name></ram:BuyerTradeParty></ram:ApplicableSupplyChainTradeAgreement>
    <ram:ApplicableSupplyChainTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax><ram:CalculatedAmount currencyID="EUR">37.62</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount currencyID="EUR">198.00</ram:BasisAmount><ram:ApplicablePercent>19.00</ram:ApplicablePercent></ram:ApplicableTradeTax>
      <ram:SpecifiedTradeSettlementMonetarySummation><ram:LineTotalAmount currencyID="EUR">198.00</ram:LineTotalAmount><ram:TaxBasisTotalAmount currencyID="EUR">198.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">37.62</ram:TaxTotalAmount><ram:GrandTotalAmount currencyID="EUR">235.62</ram:GrandTotalAmount><ram:DuePayableAmount currencyID="EUR">235.62</ram:DuePayableAmount></ram:SpecifiedTradeSettlementMonetarySummation>
    </ram:ApplicableSupplyChainTradeSettlement>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:SpecifiedSupplyChainTradeDelivery><ram:BilledQuantity unitCode="C62">20.0000</ram:BilledQuantity></ram:SpecifiedSupplyChainTradeDelivery>
      <ram:SpecifiedSupplyChainTradeSettlement><ram:SpecifiedTradeSettlementMonetarySummation><ram:LineTotalAmount currencyID="EUR">198.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementMonetarySummation></ram:SpecifiedSupplyChainTradeSettlement>
      <ram:SpecifiedTradeProduct><ram:Name>Trennblätter A4</ram:Name></ram:SpecifiedTradeProduct>
    </ram:IncludedSupplyChainTradeLineItem>
  </rsm:SpecifiedSupplyChainTradeTransaction>
</rsm:CrossIndustryDocument>`);
    expect(inv).toMatchObject({ syntax: 'zugferd1', number: '471102', issueDate: '2013-03-05', currency: 'EUR' });
    expect(inv.profile.name).toBe('ZUGFeRD 1.0 BASIC');
    expect(inv.lines[0]).toMatchObject({ name: 'Trennblätter A4', quantity: 20, unit: 'C62', netAmount: 198 });
    expect(inv.vat[0]).toMatchObject({ rate: 19, basis: 198, amount: 37.62 });
    expect(inv.totals).toMatchObject({ grandTotal: 235.62, due: 235.62 });
  });

  it('marks credit notes and takes the currency from the amounts when the code is empty', () => {
    const credit = fixture('zugferd-cii.xml')
      .replace('<r:TypeCode>380</r:TypeCode>', '<r:TypeCode>381</r:TypeCode>')
      .replace('<r:InvoiceCurrencyCode>EUR</r:InvoiceCurrencyCode>', '<r:InvoiceCurrencyCode/>');
    expect(parseInvoice(credit)).toMatchObject({ isCreditNote: true, currency: 'EUR' });
  });

  it('refuses what is not an invoice', () => {
    expect(() => parseInvoice('<?xml version="1.0"?><order/>')).toThrow(/not an e-invoice/);
    expect(() => parseInvoice('not xml at all <')).toThrow();
  });
});
