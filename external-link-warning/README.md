# External Link Warning

Asks before a link opens a domain that isn't on the trusted list. Since
2.0 it can also check each link when it is clicked: with the company's own
link check service, with Google Safe Browsing, or with both. The dialog
always names the domain the link really goes to.

Needs Bulwark 1.20.0 or later. Bulwark Lite has no plugins. The dialogs come
in every language Bulwark ships.

## Admin settings

Set on the plugin's page in the admin panel (Plugins > External Link
Warning).

| Setting | Key | Default | What it does |
| --- | --- | --- | --- |
| Trusted domains | `trustedDomains` | empty | Comma- or newline-separated. Subdomains match (example.com also trusts docs.example.com). International domains work in either form (bücher.example or xn--bcher-kva.example). Applies to every user. |
| Check links before they open | `lookup` | `off` | `off`, `endpoint` (company service), `safebrowsing` (Google) or `both`. |
| Link check service URL | `endpointUrl` | empty | Where the company service answers (see below). |
| Link check service token | `endpointToken` | empty | Optional secret, sent as `Authorization: Bearer <token>`. |
| Google Safe Browsing API key | `safeBrowsingKey` | empty | Secret. A key of a Google Cloud project with the Safe Browsing API on. |
| When a link can't be checked | `onFailure` | `open` | `open`: the warning says "Couldn't check this link" and the user may continue. `closed`: the link can't be opened until the check works again. |
| When a check flags a link | `onUnsafe` | `warn` | `warn`: a strong warning, the user may still open it. `block`: it can't be opened. |
| Don't check trusted domains | `skipTrusted` | on | Links to trusted domains open without a check. |

The token and the key are `secret` fields: they stay on the Bulwark server.
The plugin never sees them; the server's plugin proxy adds them to the
request. The plugin reads only the other settings.

Users can add their own trusted domains in the plugin's settings, and after
Continue on an unknown domain they are asked whether to always trust it on
that device (turn "Offer Always trust" off to skip that question).

## What happens on a click

1. A trusted domain opens at once (unless `skipTrusted` is off; then it is
   checked first and opens at once when nothing is found).
2. Otherwise the checks run, side by side. The whole click gets 3 seconds,
   including reading the admin settings and which checks are set up the
   first time (both are read when the plugin starts), so the link still
   opens while the browser counts it as the user's click.
3. A link is **unsafe** when either check says so. The user gets a strong
   warning with the reason, or with `onUnsafe: block` only a Close button.
4. If a check fails (error, bad answer, no answer in 3 seconds, not set up)
   and nothing flagged the link, `onFailure` decides: open shows the normal
   domain warning with "Couldn't check this link" (a trusted domain just
   opens); closed shows only Close.
5. Otherwise the normal domain warning, with "Checked: no known threats."
   when a check answered safe.

One address end to end: the plugin reads every link the way the browser
does (the WHATWG URL rules), and checks, shows and opens exactly that
address. `http://evil.example\@good.example/` goes to evil.example in a
browser, so evil.example is what is checked and named; an international
domain is checked in its punycode form.

When the link text looks like an address ("paypal.com") but the link goes
somewhere else, the dialog says so.

Verdicts are cached in memory only, for the time the service gives. Nothing
about clicked links is written to the device.

## The company link check service

Any service that answers this contract works, for example a small wrapper
around a commercial URL reputation service or Google Web Risk.

Request, sent by the Bulwark server:

```http
POST <endpointUrl>
Content-Type: application/json
Accept: application/json
Authorization: Bearer <endpointToken>      (only when a token is set)

{"url": "https://login.example.net/reset?id=42", "host": "login.example.net"}
```

Answer, HTTP 200 with a JSON body:

```json
{"verdict": "unsafe", "reason": "Known phishing kit", "cacheSeconds": 600}
```

- `verdict`: `safe`, `unsafe` or `unknown`. `unknown` means "no opinion":
  with `lookup: both` Google's answer decides.
- `reason` (optional): shown to the user with an unsafe verdict, up to 300
  characters.
- `cacheSeconds` (optional): how long Bulwark may reuse the answer for this
  URL, in memory, at most 3600.

Anything else counts as "couldn't check": another HTTP status, a body that
isn't such a JSON object, an unknown verdict, or no answer within 3 seconds.

The URL must be https. A plain-http service, or one on a private address,
works only when the server admin lists its origin in
`PLUGIN_PROXY_PRIVATE_ORIGINS` (comma separated, for example
`http://linkcheck.internal:8080`). Redirects to another origin are refused.

## Google Safe Browsing

The plugin uses the Safe Browsing API v5 `hashes:search` method in
Google's No-Storage Real-Time mode. For each link it computes the host and
path combinations Google's spec describes (at most 30), hashes them with
SHA-256 and sends **only the first 4 bytes of each hash**. Google answers
with the full hashes it lists under those prefixes, and the plugin compares
them with its own. Google never gets the URL, and never the user's IP
address: the request comes from the Bulwark server, which adds the API key
(`X-Goog-Api-Key` header).

- **The Safe Browsing API is for non-commercial use only** (Google's terms:
  "not for sale or revenue generating purposes"). For commercial use, put
  Google Web Risk or another service behind the company endpoint above.
- Warnings use Google's hedged wording ("may be a phishing site") and link
  to "Advisory provided by Google". Like every list, it misses some
  dangerous sites and can be wrong about others.
- Entries Google marks as canary or as frame-only, and threat types the
  plugin doesn't know, don't warn.
- Answers are cached in memory for the time Google gives, at most 24 hours.

## No third-party traffic

With Bulwark's "No third-party traffic" switch on (Organisation > Security),
the plugin still runs: the trusted-domain warning and the company endpoint
work, because the admin entered that address. Google Safe Browsing is off
(Google is a third party), and that doesn't count as a failed check, so
`onFailure: closed` doesn't block links because of it. The admin page lists
the endpoint's host among the hosts that stay reachable.

## What it can't catch

The plugin sees the links Bulwark opens: clicks and middle-clicks in mail,
the reader view, calendar events, contacts, notifications, the unsubscribe
link and links other plugins open. It can't see what the browser does on
its own: "Copy link address" and the browser's context-menu "Open link in
new tab" bypass it. Mail read in other apps isn't checked.

## Permissions

- `http:proxy`: the two checks go through Bulwark's plugin proxy.
- `ui:observe` (implicit): the `onBeforeExternalLink` hook and the dialog
  slot.

## Development

```bash
npx vitest run external-link-warning/   # from the repository root
npm run build                            # in this folder: dist/index.js
```

The logic is in `src/lib/` (canonicalisation and hashing, the two clients,
the decision and its dialog) and is tested in `test/` against Google's
published examples and recorded answers, without network access.
