# Package tracking

Finds tracking numbers in your mail and shows where each parcel is.

- **Reader card**: above the text of a shipping mail, one info bar per
  parcel, like the reader's own bars: the carrier, the current status and the
  latest scan ("The shipment has been processed in the parcel center ·
  Hannover, DE"), the tracking number and the expected delivery day when the
  carrier gives one, then *Track at <carrier>* (the carrier's own tracking
  page), *Refresh* and *Mark received*.
- **Deliveries** section in the mail sidebar, below the folders and tags:
  every parcel you follow that you haven't marked received, newest activity
  first, one row each with a short status. A small **Refresh** button appears
  on the same line as the Deliveries heading alongside the most recent check time, so all
  active parcels can be updated without finding each original email. A row
  opens the parcel with its full status, *Track* and *Mark received*.
  *Add tracking number* at the end follows a number by hand.
- **Notifications** when a parcel's status changes (for example from *In
  transit* to *Out for delivery*), as a system notification when you allowed
  them for the webmail, otherwise as a message in the app.

![Reader card, light](screenshots/reader-card-light.png)
![Reader card, dark](screenshots/reader-card-dark.png)
![Status change notification and the deliveries section](screenshots/status-notification-light.png)
![Deliveries section](screenshots/deliveries-light.png)
![Adding a tracking number](screenshots/add-dialog-light.png)
![A parcel opened from the sidebar](screenshots/parcel-dialog-light.png)
![Reader card on a phone](screenshots/reader-card-phone-light.png)

## Carriers and number formats

One module per carrier in `src/lib/carriers/`. A module lists its number
formats and how sure a match is; to add a carrier, copy one (for example
`ups.js`) and add it to `carriers/index.js`.

| Carrier | Formats | Check digit |
| --- | --- | --- |
| DHL / Deutsche Post | 20-digit DHL Paket barcode `00340…` (also in groups of four), `JJD` + 18 digits, `JD` + 18 digits, `GM` + 16-18 digits, registered mail `XX123456785DE`, Express waybill (10 digits), DHL Paket 12 digits | GS1 mod 10, UPU S10 mod 11, Express mod 7; none published for JJD/JD/GM/12 digits |
| UPS | `1Z` + 16 characters, also printed with spaces | UPS mod 10 |
| USPS | Intelligent Mail package barcode, 20-22 digits starting 91-95 (also behind a `420` + ZIP prefix), international `XX123456785US` | GS1 mod 10, S10 |
| Royal Mail | `XX123456785GB` | S10 |
| PostNL | `3S` + four letters + digits, `XX123456785NL` | S10 for the international form |
| Amazon Logistics | `TBA` / `TBC` / `TBM` + 12 digits | none |
| FedEx | 12 digits (Express), 15 digits (Ground) | mod 11 (Express), GS1 mod 10 (Ground) |
| DPD | 14 digits starting with 0 | none published |
| Hermes / Evri | `H` + 15-19 characters, 14 digits | none published |
| GLS | 11 or 12 digits | none published |
| Other postal services | UPU S10 from any other country | S10 |

A number whose carrier defines a check digit only counts when the check
digit fits.

### Not mistaking other numbers for tracking numbers

Distinctive formats (`1Z…`, `JJD…`, `TBA…`, S10, the DHL `00340…` barcode)
count wherever they appear. Plain digit runs look just like order, customer,
invoice and phone numbers, so they only count when

- the carrier is named in the message (text, subject or sender), and
- a tracking word comes before the number ("tracking number", "Sendungsnummer",
  "Paketnummer", "suivi", "zending", ...), and
- the label right before the number doesn't say order, invoice, customer,
  phone, IBAN, reference, meeting and the like, and
- the number isn't part of a longer compound (a date, a `+49…` phone number,
  an order id with dashes).

The unit tests hold a set of such look-alikes that must not be found (order
numbers, phone numbers, IBANs, invoice numbers, dates, numbers with a wrong
check digit) next to real-format numbers that must be.

### schema.org markup

Many shops mark up the shipment in the HTML of the mail as a schema.org
`ParcelDelivery` (JSON-LD or microdata). The plugin reads `trackingNumber`,
the carrier (`carrier` or `provider`) and `trackingUrl` from there first;
those numbers need no guessing and keep the shop's own tracking link.

## Live status

The plugin asks a tracking service through the webmail's server, which adds
the API key. The keys never reach the browser.

- **17TRACK API v2.2**: all carriers. Numbers are registered with 17TRACK
  once, the first time they are looked up.
- **DHL Shipment Tracking - Unified API**: DHL numbers go here first when it
  is set up. When DHL doesn't know a number (or isn't set up), 17TRACK is
  asked.

Without either, the card and the sidebar section still show the carrier,
the number and the link to the carrier's tracking page, and say that live
status isn't set up.

### Polling

- A parcel is asked about at most every **30 minutes** by normal background
  polling (the plugin checks once a minute which parcels are due, at most 20
  at a time).
- Opening webmail and returning to its browser tab also checks parcels whose
  last request is **at least 5 minutes old**. Repeated focus/visit events
  within five minutes do not cause duplicate lookups.
- The **Refresh** icon in Deliveries checks all eligible parcels on demand,
  subject to a **10-second per-parcel minimum**, provider Retry-After backoff
  and the existing per-round limit. Received, stopped, expired and delivered
  parcels are never polled.
- Polling stops when a parcel is **delivered**, when you mark it received,
  and **30 days** after it was found.
- When a service answers "too many requests", the plugin waits as long as
  the service asks.
- Opening a message looks the status up again when the stored one is older
  than 5 minutes; *Refresh* asks right away (at most every 10 seconds).

## Settings

For the administrator (Admin → Plugins → Package tracking):

| Setting | What it is |
| --- | --- |
| 17TRACK API key | Security key from the 17TRACK API dashboard (sent as the `17token` header). |
| 17TRACK API address | Leave at `https://api.17track.net/track/v2.2` unless you use a test server. |
| DHL API key | API key from developer.dhl.com (sent as the `DHL-API-Key` header). Optional. |
| DHL tracking API address | Leave at `https://api-eu.dhl.com/track/shipments`. |

Set the address together with the key: the server only sends the key to the
address's origin. An address with `http://` only works for origins listed in
`PLUGIN_PROXY_PRIVATE_ORIGINS`.

For each user (Settings → Plugins → Package tracking):

| Setting | Default |
| --- | --- |
| Look up the status when I open a message | on |
| Follow parcels from new mail | on |
| Notify me when a parcel's status changes | on |

## Privacy

- Finding tracking numbers happens in your browser. Nothing leaves it for
  that.
- **Tracking numbers** (and nothing else from your mail) are sent to the
  tracking service your administrator set up (17TRACK and/or DHL), through
  the webmail's server: when you open a message that has one (unless you turn
  that off), when you press *Refresh* or add a number, and every 30 minutes
  for the parcels you follow until they are delivered or 30 days old.
- With *Follow parcels from new mail* on, the plugin reads the text of new
  messages whose subject, preview or sender look like a shipping notice, to
  find their tracking numbers. Other mail isn't opened.
- The parcels you follow are kept in this browser (plugin storage, per
  account): number, carrier, the subject of the mail, the last status.

## Permissions

| Permission | Why |
| --- | --- |
| `email:read` | Read the open message (and new shipping mail) to find tracking numbers. |
| `ui:email-banner` | The reader card. |
| `ui:sidebar-widget` | The deliveries section in the sidebar (and its title). |
| `ui:notifications` | Tell you when a status changes. |
| `http:proxy` | Ask 17TRACK / DHL with the keys the administrator stored on the server. |

The tracking service addresses the administrator set are read with
`api.config.get()`, which needs no permission and never includes the keys.

## Decisions

- New shipping mail is followed automatically and statuses are looked up
  when a message is opened; both can be turned off per user.
- Delivered parcels stay in the sidebar until you mark them received, so a
  parcel left at a neighbour doesn't vanish.
- A number added by hand whose format several carriers share (plain
  digits) gets no carrier; the tracking service works it out and the button
  says *Track online*, linking to 17TRACK's public tracking page. A length
  only one carrier uses counts when its check digit fits, so a 10-digit
  DHL Express waybill is taken as DHL.

## Development

```
node scripts/build.mjs parcels
node node_modules/vitest/vitest.mjs run parcels
BULWARK_ADMIN_PASSWORD=... node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.mjs parcels.spec
```

The end-to-end tests install the plugin as admin, point it at the 17TRACK and
DHL mocks of `test-env` (http://localhost:18099), open the seeded shipping
mail in Stalwart, put a new shipping mail with schema.org markup into the
inbox and watch the mock number `JJD000390007878901234` move from one status
to the next. Set `BULWARK_ADMIN_STATE=<file>` to reuse the admin session
between runs; the admin sign-in is rate limited.
