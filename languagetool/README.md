# Proofreading (LanguageTool)

Underlines spelling, grammar and style mistakes while you write a message,
with suggestions to fix them, using [LanguageTool](https://languagetool.org).
The text goes to the LanguageTool server your administrator set up: your own
self-hosted server, or the public api.languagetool.org only if the
administrator allows it. Nothing is sent for a message that will be signed or
encrypted.

Needs Bulwark 1.20 or later, which brought proofreading plugins (the
`compose:check` permission). Plugins don't run in Bulwark Lite.

## What users see

Bulwark draws the underlines and the popup; this plugin is the checker
behind them.

- Spelling mistakes, grammar and style issues are underlined in the
  composer a moment after you stop typing. Click one (or press
  Ctrl+' / Ctrl+;) for LanguageTool's message and up to five suggestions.
- **Ignore** hides that issue in this message. It stays hidden for the same
  rule and the same words elsewhere in the message, also after you edit
  around it.
- **Add to dictionary** adds the word to your personal dictionary and checks
  the message again.
- **Turn off this rule** adds the rule to your turned-off rules, unless the
  administrator locked them.
- In plain-text mode the issues are listed behind the proofreading status in
  the composer's toolbar.

Whether proofreading runs at all is Bulwark's own setting, under Settings >
Composing > Proofreading, and the administrator can require it or turn it
off there. The plugin has no on/off switch of its own.

### The plugin's settings

Under Settings, the plugin's section shows which server checks your text
(host name only) and lets you choose:

- **Language**: follow Bulwark's writing language (the default), or always
  one language. For English, German and Portuguese also the spelling
  variant (British or American English, German from Germany, Austria or
  Switzerland, European or Brazilian Portuguese).
- **Your native language**: LanguageTool then also looks for false friends.
- **Picky mode**: also style and typography.
- **Warn before sending**: Bulwark asks before sending while LanguageTool
  still marks something. Off by default.
- **Personal dictionary**: add and remove words.
- **Turned-off rules**: turn a rule back on.

The dictionary, the turned-off rules and these choices are kept in the
browser, per account: another browser or device has its own list. The
organisation's word list (set by the administrator) applies everywhere.

When the administrator turned off "Users may change language, level and
turned-off rules", the language, picky mode and turned-off rules show the
administrator's values, read-only, with a lock note; the user's own values
for them are not used. The dictionary, native language and the send warning
stay the user's.

## What is sent where, and when

While proofreading is on in a composer, Bulwark hands the plugin the
paragraphs you wrote, without your signature and the quoted message, a
moment after you stop typing (and at once when you paste or leave the
text). The plugin sends them, through the webmail server's proxy, to the
LanguageTool server:

- only paragraphs LanguageTool hasn't seen yet with the same settings; an
  unchanged paragraph is answered from the plugin's memory (up to 1000
  paragraphs, kept until the tab closes);
- as a form POST to `<server>/v2/check` with the text, the language,
  preferred variants, native language, level and the administrator's
  turned-off rules and categories;
- never for a message that will be signed or encrypted (Bulwark doesn't
  hand the text to the plugin then).

Inline images and mentions are sent as placeholders, not as their content.
Your dictionary, ignored issues and your own turned-off rules are applied in
the browser and never sent.

With the public API, the text goes to LanguageTool GmbH's servers in
Germany under [their privacy policy](https://languagetool.org/legal/privacy).

## Language

Each check goes out in one language, picked in this order:

1. The administrator locked a fixed default language: that one.
2. The user picked a fixed language in the plugin's settings: that one.
3. Bulwark's writing language (Settings > Composing) is set: that one.
4. Otherwise the administrator's default: a fixed language, or `auto`,
   which lets LanguageTool detect it.

LanguageTool checks spelling only in a variant (en-GB, de-AT, pt-BR...). A
language without one gets the user's preferred variant, else the
administrator's, else en-US, de-DE or pt-PT. With `auto` these go along as
`preferredVariants`. A writing language LanguageTool doesn't check (Czech,
for example) shows "LanguageTool can't check this language" in the
composer, and nothing is sent.

## Setting it up (administrator)

1. Run a LanguageTool server (below), or allow the public API to try the
   plugin out.
2. Install the plugin and turn it on for everyone (or let users turn it
   on).
3. On the plugin's admin page set **LanguageTool server**, e.g.
   `http://languagetool:8010`. An http address or a private one only works
   when it is listed in `PLUGIN_PROXY_PRIVATE_ORIGINS` on the webmail
   server.
4. Users turn on Proofreading under Settings > Composing, or you require it
   (below).

### A self-hosted server

The `erikvl87/languagetool` image packages LanguageTool's HTTP server. Next
to the webmail in the same Docker Compose project:

```yaml
services:
  languagetool:
    image: erikvl87/languagetool
    restart: unless-stopped
    environment:
      Java_Xms: 512m
      Java_Xmx: 2g
      # Optional, better results for some languages (see below):
      # langtool_languageModel: /ngrams
    # volumes:
    #   - ./ngrams:/ngrams:ro

  webmail:
    # ...
    environment:
      PLUGIN_PROXY_PRIVATE_ORIGINS: http://languagetool:8010
```

Then set the server to `http://languagetool:8010`. The port isn't published
to the host; only the webmail's server talks to LanguageTool.

Memory: give Java at least 1 GB (`Java_Xmx`) for one or two languages and
2 GB or more for many users or many languages. The first check of each
language loads its data and takes a few seconds.

The n-gram data (`langtool_languageModel=/ngrams`) finds more confused
words (their/there, seit/seid). It is a separate download per language from
https://languagetool.org/download/ngram-data/ (several GB per language),
unpacked into the mounted folder as `ngrams/en`,
`ngrams/de`, and so on. LanguageTool works without it.

**Access token**: if your LanguageTool server sits behind a proxy that
wants a bearer token, enter it as **Access token**. The webmail's server adds
it to each request; it never reaches the browser and is never sent to the
public API.

**LanguageTool Premium** isn't supported: its username and API key go in the
form body, which the webmail's proxy can't fill in, and a self-hosted server
refuses them anyway.

### The public API

**Use the public LanguageTool API when no server is set** sends checks to
api.languagetool.org. It's meant for trying the plugin out. As of
2026-11-01 the free API allows, per IP address
([dev.languagetool.org/public-http-api](https://dev.languagetool.org/public-http-api)):

- 20 requests a minute,
- 75 KB of text a minute,
- 20 KB per request.

All users of one webmail share the webmail server's IP address, so a few
people typing at once use this up. The plugin splits text above 20 KB,
counts its own requests in each browser and pauses when LanguageTool
answers "too many requests"; the composer then shows that checking is
paused. LanguageTool's terms ask for a visible link to languagetool.org; the
plugin's settings section shows one while the public API is used.

With Organisation > Security > "No third-party traffic" on, the public API
is off; a server you entered on the plugin's admin page stays reachable.

### Other settings

| Setting | What it does |
|---|---|
| Default level | Default or picky. Users may change it unless locked. |
| Default language | `auto` (detect) or a code such as `de-DE`. See "Language". |
| Preferred variants | For example `de-AT,en-GB`: the spelling variant per language. |
| Rules turned off for everyone | LanguageTool rule ids, comma separated (`WHITESPACE_RULE,EN_QUOTES`). Sent to the server and filtered in the browser. |
| Categories turned off for everyone | Category ids, comma separated (`TYPOGRAPHY,STYLE`). |
| Organisation word list | Company and product names, one per line, accepted for everyone in addition to each user's dictionary. |
| Users may change language, level and turned-off rules | On by default. Off: users see these read-only and their own values are ignored. |

Dictionary matching: a word matches as written and in capitals ("Bulwark"
also accepts "BULWARK", not "bulwark"); a word written all in lower case
matches any capitalisation ("jmap" accepts "JMAP" and "Jmap"). An entry of
several words also adds each word.

### Making proofreading mandatory

1. Turn the plugin on for everyone (forced on, in Admin > Plugins).
2. In the settings policy, lock Bulwark's **Proofreading** setting on. Users
   then can't switch it off, also not per message.
3. Optionally turn off **Users may change language, level and turned-off
   rules**, so everyone checks with your language, level and rules.

Messages that will be signed or encrypted are still never checked.

## When a check fails

The composer's proofreading status says what happened; nothing is lost and
typing goes on:

- LanguageTool (or the webmail's proxy) asked to wait: checking pauses for
  as long as it asked (Retry-After), a minute otherwise.
- Not set up, the address isn't allowed (`PLUGIN_PROXY_PRIVATE_ORIGINS`),
  the address doesn't lead to LanguageTool, the server didn't answer, took
  more than 13 seconds, refused the token, or failed: "Checking
  unavailable" with a short reason. Bulwark tries again a little later.

## Permissions

| Permission | Why |
|---|---|
| `compose:check` | Get the paragraphs you write while proofreading is on, and show what LanguageTool found. |
| `http:proxy` | Send them to the LanguageTool server through the webmail's proxy, which adds the access token. |
| `ui:settings-section` | The plugin's section in Settings. |

## Credentials

- `server`: the server address from the admin page, without a token.
- `server-token`: the same server with the access token as a bearer header;
  used when a token is set.
- `public`: api.languagetool.org, never with the token.

## Tests

```
npx vitest run languagetool                                        # unit tests
npx playwright test -c e2e/playwright.config.mjs languagetool      # end-to-end
```

The end-to-end specs start a mock LanguageTool on port 18110 that answers
from answers recorded in `e2e/fixtures/`, and need the webmail started with
`PLUGIN_PROXY_PRIVATE_ORIGINS=http://localhost:18110` (see
`e2e/common.mjs`). They skip when the webmail isn't running.
