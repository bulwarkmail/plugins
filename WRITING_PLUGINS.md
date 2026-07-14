# Writing Bulwark Webmail Plugins

A practical guide to building a plugin for the sandboxed plugin system. For a
field-by-field reference see the inline JSDoc in `lib/plugin-types.ts`,
`lib/plugin-hooks.ts`, and `lib/plugin-sandbox/runtime.tsx`. Working examples
live next to this file in `repos/plugins/` (start with `hello-world` and
`translate`).

---

## 1. How plugins run

Every enabled plugin gets **one hidden background iframe** that boots when the
host activates it, runs `activate()` once, and answers API calls + hook
invocations. Every visible UI **slot** the plugin offers gets **its own iframe**
that mounts on demand and renders a React component. All of them load the same
bundle and talk to the host over `postMessage` RPC — they never touch host
objects directly.

There are two **execution tiers**:

| | `untrusted` (default) | `privileged` |
|---|---|---|
| Iframe origin | null-origin (`sandbox="allow-scripts"`) | same-origin (`allow-same-origin`) |
| `crypto.subtle`, `IndexedDB` in-frame | ❌ unavailable | ✅ available |
| Can bundle its own crypto libs | ❌ | ✅ (e.g. pkijs, openpgp) |
| Extra host APIs | — | `api.jmap.*` |
| How it's granted | always | signed bundle + admin approval + `crypto:full` consent |

**Pick `untrusted` unless you genuinely need in-frame WebCrypto / IndexedDB.**
The privileged tier is for crypto plugins (S/MIME, PGP) and is gated hard —
see §8.

Whatever the tier, capabilities are mediated by the host and enforced against
the plugin's declared **permissions**.

---

## 2. Project layout

Follow the convention used by the bundled plugins:

```
repos/plugins/my-plugin/
  manifest.json        # plugin metadata (see §4)
  package.json         # build script (esbuild)
  src/
    index.js           # or .jsx / .ts / .tsx — your entry module
  dist/                # build output — index.js + manifest.json (what ships)
```

`package.json` mirrors the existing plugins:

```json
{
  "name": "bulwark-plugin-my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "esbuild src/index.js --bundle --format=cjs --platform=neutral --outfile=dist/index.js --external:react --external:react-dom --external:react-dom/client --external:react/jsx-runtime --external:@plugin-host",
    "dev": "npm run build -- --watch"
  },
  "devDependencies": { "esbuild": "^0.24.0" }
}
```

Key points:
- **CommonJS output** (`--format=cjs`) — the runtime evaluates the bundle and
  reads `module.exports`.
- **Externalize only** `react`, `react-dom`, `react-dom/client`,
  `react/jsx-runtime`, and `@plugin-host`. The host provides those at eval time.
- **Everything else is bundled in.** A privileged crypto plugin lists
  `pkijs` / `asn1js` / etc. as normal `dependencies` and esbuild inlines them.
- Ship `dist/index.js` + `manifest.json` (zipped for upload). Keep the bundle
  under the size cap (`MAX_PLUGIN_SIZE`, 5 MB; privileged bundles may have a
  higher cap).

---

## 3. What your bundle exports

```js
const api = require('@plugin-host'); // the host API object (see §6)

module.exports = {
  // Called once when the background iframe boots. Optionally return a
  // disposer. Wire up hooks/state here.
  activate(api) {
    api.log.info('hello');
    return { dispose() { /* cleanup */ } };
  },

  // Observer / intercept / transform handlers, keyed by hook name (see §5).
  hooks: {
    onEmailOpen: (email) => { api.log.info('opened', email.id); },
    onMailtoIntercept: (ctx) => false, // intercept: false cancels
  },

  // UI slot components, keyed by slot name (see §7).
  slots: {
    'email-banner': {
      component: MyBanner,                 // React component
      shouldShow: (ctx) => true,           // optional predicate (background-side)
      order: 100,                          // optional sort order
    },
  },

  // Optional keyboard shortcuts.
  shortcuts: {
    'my-action': { keys: 'Ctrl+Shift+M', label: 'Do the thing', handler: () => {} },
  },
};
```

All four keys are optional. A pure-hook plugin only exports `hooks`; a pure-UI
plugin only exports `slots`.

> JSX works — configure esbuild for your file extension. Use the host-provided
> React via `require('react')` (externalized), not a bundled copy.

---

## 4. The manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "You",
  "description": "What it does.",
  "type": "ui-extension",
  "permissions": ["email:read", "ui:email-banner"],
  "entrypoint": "index.js",
  "minAppVersion": "1.7.0",

  "settingsSchema": { /* per-user settings, see below */ },
  "locales": { "en": { "key": "text" } },
  "httpOrigins": ["https://api.example.com"],
  "apiPostPaths": ["/api/my-endpoint"],
  "frameOrigins": ["https://embed.example.com"]
}
```

- `type`: `ui-extension` | `sidebar-app` | `hook`.
- `tier`: omit for untrusted; set `"privileged"` only for a crypto plugin (§8).
- `permissions`: subset of `ALL_PERMISSIONS` (`lib/plugin-types.ts`). Declaring
  a permission is necessary but not sufficient — the user must also grant it
  via the consent dialog (managed/admin plugins are pre-approved).
- `settingsSchema`: fields rendered in the plugin's settings UI; values reach
  the plugin as `api.plugin.settings`. Field types: `boolean | string | number
  | select` (with `options` / `min` / `max`).
- `locales`: bundled translations for `api.i18n.t(key)`.
- `httpOrigins` / `apiPostPaths` / `frameOrigins`: allowlists for
  `api.http.fetch`, `api.http.post`, and embedded iframes respectively.

---

## 5. Hooks

Register handlers under `hooks` (or via `activate`). A hook belongs to one of
three patterns:

- **Observer** — fire-and-forget notifications. Return value ignored.
  e.g. `onEmailOpen`, `onAfterEmailSend`, `onAppReady`.
- **Intercept** — return `false` to cancel the operation.
  e.g. `onBeforeCompose`, `onMailtoIntercept`, `onComposeSend` (return `false`
  = "I handled the send").
- **Transform** — receive a value, return a (possibly modified) value, or
  `undefined` to pass through. Handlers chain.
  e.g. `onTransformOutgoingEmail`, `onBuildQuoteHeader`, `onEmailListItemRender`,
  `onRenderEmailBody`.

Hooks are grouped by domain in `lib/plugin-hooks.ts` (email, calendar,
contacts, files, auth, settings, identity, filters, tasks, templates, ui,
theme, toast, drag-drop, keyboard, app lifecycle, render, router, …). Read the
JSDoc on each bus for its exact signature and pattern.

Notable hooks for crypto/compose/view plugins:
- `onComposeSend` *(intercept)* — fires at the top of the send path with the
  draft + sign/encrypt intent. Build raw MIME, submit via `api.jmap.sendRaw`,
  return `false` to take over sending.
- `onRenderEmailBody` *(transform)* — fires before the viewer renders a body.
  Inspect the message, fetch the raw blob via `api.jmap.fetchBlob`, decrypt /
  verify, and return a replaced `{ html, text, attachments, verification }`.
  The host still sanitizes returned HTML.

---

## 6. The `api` object

`require('@plugin-host')` (and the argument to `activate`) returns:

```ts
api.plugin    // { id, version, settings }
api.storage   // get(key) / set(key,value) / remove(key) / keys()  — host-backed KV, per-plugin
api.http      // post(path, body)  — same-origin /api/*, allowlisted by apiPostPaths
              // fetch(url, init)  — cross-origin https, allowlisted by httpOrigins
api.toast     // success / error / info / warning (string)
api.ui        // confirm(opts) -> Promise<boolean>; alert(opts); openExternalUrl(url)
              //downloadFile(opts)->void : Alow to download a file generated by a plugin. This is not related to attachment or user's file.
api.admin     // getConfig / getAllConfig / setConfig / deleteConfig  — needs admin:config
api.log       // debug / info / warn / error  (prefixed console, local)
api.i18n      // t(key, vars?) / locale  — resolves manifest.locales

// Privileged tier only (throws for untrusted plugins):
api.jmap      // fetchBlob(blobId, opts?) -> Promise<Uint8Array>
              // sendRaw(rawBytes, identityId, opts?) -> submit a raw RFC822 message
              // 
// Privileged tier only (throws for untrusted plugins):
api.upfiles   // save: (formerFileId:string, file:File): Edit an attachment before it is uploaded to server. The raw data is exposed
              // get: (fileId:string) => Promise<File> : Get an attachment before it is uploaded to server. The raw data is exposed
api.webauthn // getOrCreate: Used to get or create a PRF generated by keys.
```

Every method except `log` and `i18n` crosses the RPC boundary (async). Values
must be structured-cloneable — no functions in returned data (slot
`extraProps` callbacks are the one marshalled exception).

`api.storage` is the right place for plugin state in untrusted plugins (the
in-frame `localStorage`/`IndexedDB` are unavailable). Privileged plugins may
additionally use real in-frame `IndexedDB` for large/binary data.

---

## 7. UI slots

Offer a React component for a named mount point. Available slots (see `SlotName`
in `lib/plugin-types.ts`) include `email-banner`, `email-footer`,
`email-details-section`, `composer-toolbar`, `composer-sidebar`,
`sidebar-widget`, `settings-section`, `context-menu-email`, `app-top-banner`,
`toolbar-actions`, `navigation-rail-bottom`, `calendar-event-actions`, …

```js
slots: {
  'email-banner': {
    component: function MyBanner(props) {
      // props = host-supplied extraProps for this slot (e.g. the email)
      const api = require('@plugin-host');
      return <div>…</div>;
    },
    shouldShow: (ctx) => ctx?.email?.hasAttachment === true,
    order: 50,
  },
}
```

- The slot iframe renders your component and reports its height back; you don't
  size it.
- `shouldShow` runs in the **background** iframe (cheap gate before a slot
  iframe is spawned).
- The host injects its theme as CSS variables + a `.dark` class, so use the
  host's design tokens (`var(--…)`) to match the app.
- Each UI slot needs the matching `ui:*` permission (e.g. `ui:email-banner`,
  `ui:composer-toolbar`, `ui:settings-section`).

---

## 8. The privileged tier (crypto plugins)

Only needed when you must run `crypto.subtle` / `IndexedDB` in-frame or bundle a
crypto library. To be granted the same-origin tier, **all** of these must hold
(enforced by `resolvePluginTier` in `lib/plugin-sandbox/tier.ts`):

1. Manifest declares `"tier": "privileged"` **and** the `crypto:full` permission.
2. The bundle is **signed** (Ed25519) and delivered through the admin/server
   channel — i.e. `managed`. Self-uploaded bundles are unsigned and can never
   reach this tier.
3. An **admin has approved** this specific bundle (`bundleHash`).
4. The user gives **explicit high-risk consent** for `crypto:full` (managed
   plugins are pre-approved by the operator).

Relevant permissions: `crypto:full` (umbrella), `email:blob-read` (read raw
message bytes), `email:raw-send` (submit signed/encrypted messages),
`email:render-takeover` (replace rendered body).

Because same-origin == effectively full host access, treat `crypto:full` like a
full-access browser extension: only signed, admin-approved, audited code should
hold it. A privileged bundle that fails any gate is **refused**, not downgraded.

Typical crypto-plugin shape:
- Bundles its crypto stack (e.g. `pkijs`, `asn1js`).
- Stores keys/certs in in-frame `IndexedDB`; keeps unlocked `CryptoKey`s
  non-extractable and in memory only.
- Stores preferences via `api.storage`.
- Hooks `onComposeSend` (sign/encrypt → `api.jmap.sendRaw`) and
  `onRenderEmailBody` (`api.jmap.fetchBlob` → decrypt/verify → replaced body).
- Offers `composer-toolbar` (sign/encrypt toggles), `email-banner`
  (verification status), and `settings-section` (key management) slots.

---

## 9. Build, package, install

```bash
cd repos/plugins/my-plugin
npm install
npm run build          # emits dist/index.js
# zip dist/ (index.js + manifest.json) and upload via the admin Plugins UI,
# or drop it in PLUGIN_DEV_DIR for local development.
```

Lifecycle in the app: **install → enable**. On enable the host runs the consent
gate (and, for managed plugins, the admin-approval gate), then loads the
background iframe and calls `activate`. A misbehaving plugin (repeated errors,
hung init) is auto-disabled by the circuit breaker.

---

## 10. Gotchas

- **No host globals.** You can't read host cookies / `localStorage`; use
  `api.storage`. Untrusted plugins also can't use in-frame `crypto.subtle` /
  `IndexedDB` (null-origin) — that's what the privileged tier is for.
- **Permissions are double-gated.** Manifest declaration + user grant. If a
  call throws `lacks permission`, add it to the manifest and re-consent.
- **Allowlists.** `api.http.fetch` needs the origin in `httpOrigins`;
  `api.http.post` needs the path in `apiPostPaths`. Empty list = blocked.
- **Structured-clone only** across RPC. Don't return functions or class
  instances from hooks/API calls.
- **Returned HTML is sanitized.** `onRenderEmailBody` output still passes
  through the host sanitizer — don't rely on raw markup surviving.
- **`activate` runs once** (background iframe). Slot iframes do **not** re-run
  `activate`; put shared setup behind `api.storage` or recompute per slot.
```
