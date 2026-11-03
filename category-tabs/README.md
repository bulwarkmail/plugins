# Inbox Category Tabs

Gmail-style inbox tabs (**Primary / Social / Promotions / Updates**) for
Bulwark's message list ([issue #656](https://github.com/rathlinus/jmap-webmail/issues/656)).

The host renders the tab strip natively and ANDs the active tab's filter into
the inbox `Email/query`; this plugin only contributes tab definitions,
classification rules, and per-sender overrides. Off unless installed and
enabled; self-hosters who want a flat inbox keep one.

## Two classification modes

| | `search` (default) | `sieve` |
|---|---|---|
| How | Live JMAP query per tab (`from`/`subject`/`header` conditions) | Managed Sieve section assigns `$category-*` keywords at delivery |
| Mail modified | Never | Keywords only, message stays in INBOX |
| Other clients see it | No (view-time only) | Yes (keywords are durable, any JMAP/IMAP client can filter) |
| Server requirements | Email/query with `header` filter support | JMAP Sieve capability (`urn:ietf:params:jmap:sieve`) |

In `sieve` mode the classifier section is spliced into the account's active
script via the `onSieveScriptGenerate` transform hook and
`api.sieve.regenerate()`, so user filter rules are never overwritten and the
section is replaced (sentinel comments), never duplicated.

## User customization

The plugin adds its own **settings page** (a `settings-section` slot) where
everything is user-editable:

- enable/disable each tab, rename it, pick a Lucide icon, accent color, order
- edit the sender-domain and subject-keyword rule lists per tab
- toggle bulk-mail markers (List-Unsubscribe / `Precedence: bulk`) per tab
- add **custom tabs** with their own rules (e.g. a "GitHub" or "Forums" tab)
- switch classification mode (search ↔ sieve)
- review and remove per-sender pins created by "move to tab"
- reset to the shipped defaults

Config is stored via `api.storage`; "Save & apply" re-registers the tabs live
(`api.tabs.set`) and, in sieve mode, regenerates the managed script section, with
no reload needed.

## What it demonstrates

- `api.tabs.set()` / `api.tabs.clear()` — native tab registration
  (`ui:message-list-tabs`)
- Search-based tabs (`query`) vs. keyword tabs (`keyword`), plus the default
  "Primary" bucket (server-side `NOT` of the other tabs)
- A `settings-section` slot that reads/writes `api.storage` and re-applies
  tabs live: the pattern for user-customizable plugin behavior
- `onEmailCategorize` — persisting per-sender overrides when the user moves
  mail between tabs ("do this for all mail from X"), reapplied to queries
  and to the Sieve section
- `onSieveScriptGenerate` + `api.sieve.regenerate()` — safe coexistence with
  the user's own filter rules in the single active Sieve script; the
  transform re-reads config from storage on every run so settings saved in
  the slot iframe are always honored

## Build

```bash
npm install
npm run build      # emits dist/index.js
npm run package    # zips dist/ into category-tabs.zip
```

## Ideas / exercises

- Add a `context-menu-email` slot ("Always show sender in …") so search-mode
  users can pin senders without a keyword move.
- Add a Forums tab (`header: ["List-Id"]`): two clicks in the settings page,
  or ship it as another default.
