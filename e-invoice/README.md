# E-Invoices

Shows XRechnung and ZUGFeRD / Factur-X invoices in Bulwark as a readable invoice, and forwards them to your accounting address in one click.

Since 2025, businesses in Germany have to be able to receive e-invoices. An e-invoice is an XML file, either on its own (XRechnung) or inside a PDF (ZUGFeRD, Factur-X). The PDF of a ZUGFeRD invoice is only a picture; the XML is the invoice, and an XRechnung has no picture at all. This plugin reads the XML and shows what is in it.

## What it does

- **A bar above the message** when it holds an e-invoice: who it is from, the amount due and the due date, with **Show invoice** and **Forward to accounting**. When it was forwarded already, the bar says when and to whom.
- **The invoice, readable.** Seller and buyer with VAT ID and tax number, invoice and delivery dates, buyer reference (Leitweg-ID), order and contract numbers, the items with quantity, unit price and VAT rate, discounts and surcharges, the VAT breakdown, the totals down to the amount due, the bank details (IBAN, BIC, reference), payment terms, notes, and the documents an XRechnung carries (download them from the dialog). Codes are shown as words: "SEPA credit transfer", "Reverse charge", "8 h".
- **Checks the sums.** Do the items add up to the total, the VAT amounts to the VAT total, net and VAT to the gross amount? Does the seller give a VAT ID or tax number, an XRechnung the buyer reference? Is the invoice overdue? It also says when an invoice uses the MINIMUM or BASIC WL profile, which don't count as e-invoices in Germany. This is a check of the amounts, not a validation against the XRechnung rules.
- **Print** the readable invoice, or save it as a PDF from the print dialog.
- **Forward to accounting** sends the message with its attachments (or only the invoice file) to the accounting address, with a line for the bookkeeper: "For accounting: Invoice RE-2026-117 from Musterlieferant GmbH, €846.00, due 11/28/2026". The copy lands in Sent and the message is marked as forwarded. The first time the plugin forwards to an address, Bulwark asks you to allow it.
- **"Show as invoice"** in the menu of any XML or PDF attachment.
- **E-invoices in the message list** get a badge and an "E-invoices" filter (Settings: "Mark e-invoices in the message list").
- **Automatic forwarding** of new e-invoices, if you turn it on. It runs while Bulwark is open.

Formats: XRechnung (UBL and CII, any version), ZUGFeRD 1.0, ZUGFeRD 2.x and Factur-X in every profile, Peppol BIS Billing 3.0, and EN 16931 invoices in UBL or CII in general. Credit notes are shown as such.

The plugin was run against the 72 invoices of the KoSIT XRechnung test suite and the 125 hybrid PDFs and 33 XML files of the ZUGFeRD corpus: all were read, and the only sums it flagged are wrong in the files themselves.

## Setting it up

The accounting address comes from, in this order:

1. the administrator's address, when "Use this address for everyone" is on (admin dashboard > Plugins > E-Invoices);
2. the user's own address in Settings > Plugins > E-Invoices;
3. the administrator's address;
4. what the user typed when they first clicked "Forward to accounting" without an address.

Bookkeeping services with a receipt inbox, such as DATEV Unternehmen online, lexoffice or sevDesk, take e-invoices sent there.

## Permissions

| Permission | Why |
| --- | --- |
| `email:read` | Sees the open message and its attachment list; reads new mail when tagging or forwarding on its own. |
| `email:blob-read` | Reads the XML or PDF attachment to find the invoice. |
| `email:forward` | Forwards the message to the accounting address. Bulwark asks before the first forward to an address and lists allowed addresses in Settings > Plugins, where you can remove them. |
| `email:write` | Marks e-invoices with the `$einvoice` keyword for the badge and the filter. |
| `ui:email-banner` | The bar above the message. |
| `ui:message-list` | The "E-invoices" filter in the list header. |
| `ui:download-file` | Saves documents an XRechnung carries. |

Needs Bulwark 1.20 or later (`api.email.forward`, `api.ui.print` and the kit's `Table`).

## How it reads the PDF

ZUGFeRD and Factur-X attach the XML to the PDF as an embedded file. The plugin finds the embedded file streams, inflates them (with its own inflate, because the browser's refuses the trailing bytes some PDFs have) and tries each as invoice XML. Encrypted PDFs can't be read.
