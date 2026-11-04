# Writing plugins for Bulwark

This guide covers everything a plugin can do in the Bulwark webmail: how it
runs, what goes in the manifest, which hooks and UI surfaces exist, and the
full `api` object. The reference tables (permissions, hooks, surfaces, method
permissions) are generated from the webmail source by `scripts/gen-docs.mjs`,
so they match the version they were generated from.

The working plugins in this repository are the best examples. `hello-world`
is the smallest; `slot-showcase` fills every UI surface and is what the
screenshots below were taken with.

- [Quick start](#quick-start)
- [How a plugin runs](#how-a-plugin-runs)
- [Manifest](#manifest)
- [Permissions](#permissions)
- [Hooks](#hooks)
- [UI surfaces](#ui-surfaces)
- [API reference](#api-reference)
- [Accounts and API keys](#accounts-and-api-keys)
- [Testing](#testing)
- [Security notes](#security-notes)

## Quick start

A plugin is a folder with a manifest and a source entry point:

```
my-plugin/
  manifest.json
  package.json        optional: a build script and esbuild options
  src/index.js        or index.jsx, index.ts, index.tsx
  test/*.test.mjs     optional unit tests (Vitest)
  e2e/*.spec.mjs      optional Playwright tests
```

A minimal manifest:

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "author": "You",
  "description": "Shows a note above messages from your boss.",
  "type": "ui-extension",
  "permissions": ["email:read", "ui:email-banner"]
}
```

`src/index.js` exports up to four things. All of them are optional.

```js
import { createElement as h } from 'react';

const api = require('@plugin-host');

// Runs once, in the plugin's hidden background frame.
export async function activate(api) {
  await api.ui.setActions('reader-actions', [{ id: 'hello', label: 'Say hello', icon: 'hand-stop' }]);
}

// Hook handlers, keyed by hook name. They run in the background frame too.
export const hooks = {
  onEmailOpen(email) {
    api.log.info('opened', email.subject);
  },
  onAction({ actionId, context }) {
    if (actionId === 'hello') api.toast.info(`Hello from ${context.emailId}`);
  },
};

// React components for UI slots, keyed by slot name.
export const slots = {
  'email-banner': {
    component: ({ email }) => h('div', { style: { padding: 8 } }, `From ${email.from[0]?.email}`),
    shouldShow: ({ email }) => email?.from?.[0]?.email?.endsWith('@example.com'),
  },
};

// Keyboard shortcuts (needs ui:keyboard).
export const shortcuts = {
  hello: { keys: 'Alt+H', label: 'Say hello', handler: () => api.toast.info('Hello') },
};
```

`export default { activate, hooks, slots, shortcuts }` works as well.

Build and package it from the repository root:

```
node scripts/build.mjs my-plugin          # writes my-plugin/my-plugin.zip
node scripts/build.mjs                    # every plugin
node scripts/build.mjs --check            # fail if a committed zip is stale
```

The build bundles `src/index.*` with esbuild into one CommonJS file, keeps
React and `@plugin-host` external, and zips it with the manifest:
`manifest.json` and `index.js` at the root of the ZIP. A plugin can add
esbuild options under `bulwarkBuild` in its own `package.json`, for example
`{ "bulwarkBuild": { "alias": { "crypto": "./src/shim.js" }, "minify": true } }`.
The script only takes folder names at the repository root, not nested paths.

Install it one of three ways:

- **As an admin.** Turn on plugins in the admin dashboard, then upload the ZIP
  under Plugins. An admin-installed plugin is "managed": the user is never
  asked to consent, and it can be forced on for everyone or left for each
  user to turn on in Settings > Plugins.
- **As a user.** Settings > Plugins > upload, if the admin allows user
  uploads. The user confirms the permissions in a consent dialog. When the
  admin requires approval, the plugin only runs after the admin approved
  this exact package (the approval is pinned to a hash of the manifest and
  the code).
- **From a dev directory.** Start the webmail with `PLUGIN_DEV_DIR` pointing
  at a folder whose subfolders are plugins (this repository works). The
  server bundles `src/<entrypoint>` with esbuild on every request, so a
  browser reload picks up your changes. Missing `version`, `author` and
  `type` default to `0.0.0`, `dev` and `hook`. Dev plugins show up in the
  admin plugin list next to the installed ones.

```
PLUGIN_DEV_DIR=/path/to/bulwark-plugins npm run dev
```

In `next dev` the plugin frames also get `allow-same-origin` (the dev server
needs it to hydrate them). Try a plugin in a production build before you
release it, since things that work same-origin can fail in the real sandbox.

## How a plugin runs

**A sandboxed frame with no origin.** Each plugin runs in an iframe with
`sandbox="allow-scripts"` and nothing else, so its origin is opaque
(`null`). It has no cookies, no `localStorage`, no IndexedDB and no access to
the webmail page. Everything goes through `api`, which sends a message to the
host and waits for the answer. The host checks the plugin's permissions on
every call.

**One background frame and one frame per slot.** When a plugin starts, the
host creates a hidden background frame. It evaluates your bundle, registers
`hooks` and `shortcuts`, and calls `activate(api)` once. Every place a slot
appears gets its own frame, which evaluates the same bundle again and
renders `slots[name].component`. `activate` does not run in slot frames, and
module variables are not shared between frames. Keep shared state in
`api.storage`, or load it again in the slot. A plugin that takes more than
30 seconds to start is put into an error state.

**Stopping.** There is no `deactivate`. When a plugin is turned off or
removed, the host destroys its frames and drops everything it registered:
hooks, actions, day labels, pages, inbox tabs, open dialogs and running proxy
requests. The return value of `activate` is ignored.

**No direct network.** The sandbox page has a strict Content Security Policy:
`connect-src 'self'`, images only from `data:` and `blob:`, fonts only from
`data:`, and forms can't be submitted anywhere. `fetch()` to another site,
a remote `<img>`, a web font or a form post all fail. Reach the network with
`api.http.fetch` (origins listed in `httpOrigins`), `api.proxy.fetch`
(accounts and API keys, see [below](#accounts-and-api-keys)) or
`api.http.post` (the webmail's own `/api/` routes listed in `apiPostPaths`).
Bundle images as data URLs or inline SVG.

**Every call is async.** `api` methods return promises (except `api.log`,
`api.i18n` and `api.plugin`, which are local). A call rejects with an
`Error` whose message says what was wrong: a missing permission
(`Plugin "my-plugin" lacks permission "email:read"`), a bad argument, a
rate limit. Calls time out after 30 seconds, `api.http.*` and
`api.email.getAttachment`/`getRaw` after 120 seconds. Dialogs
(`api.ui.confirm`, `alert`, `prompt`, `openDialog`), `api.proxy.fetch` and
`api.proxy.connect` wait as long as the user or the transfer takes.

**Plain data only.** Arguments, results, hook payloads and slot props are
copied with the structured clone algorithm. Functions, class instances and
DOM nodes don't survive. The one exception is the host callbacks some slots
receive in their props (`insertText`, `onAttach`, `onResult`, ...): in the
slot they are async functions that call back into the host. Changing a hook
payload in place has no effect; return a new value instead.

**React comes from the host.** The bundle is evaluated as CommonJS with
`new Function(module, exports, require)`. `require` knows `react`,
`react-dom`, `react-dom/client`, `react/jsx-runtime` and `@plugin-host`, and
nothing else. Keep those external (the build script does) and bundle
everything else. An ES module bundle (`export ...` at the top level) fails
to parse. The webmail currently ships React 19.

**Theme.** Before a slot renders, the host copies its theme into the frame:
the CSS variables below, `color-scheme`, the app font and font size, and the
`dark` class on `<html>` in dark mode. The page background is transparent.
The values update live when the user switches theme.

```
--color-background --color-foreground --color-primary --color-primary-foreground
--color-secondary(-foreground) --color-muted(-foreground) --color-accent(-foreground)
--color-destructive(-foreground) --color-popover(-foreground) --color-card(-foreground)
--color-sidebar --color-sidebar-foreground --color-sidebar-border
--color-sidebar-accent(-foreground) --color-success(-foreground)
--color-warning(-foreground) --color-info(-foreground) --color-selection(-foreground)
--color-border --color-input --color-ring --color-unread --color-chart-1 ... -5
--font-size-base --list-item-height --transition-duration
--density-item-py --density-item-gap --density-header-py --density-card-p --density-sidebar-py
```

**Language.** `api.i18n.t(key, vars)` looks the key up in the manifest's
`locales` for the app language (`de-CH`, then `de`, then `en`, then the key
itself) and fills `{placeholders}` from `vars`. Slots re-render when the
language or the plugin's settings change. Text direction follows the
language, so slots flip for Arabic, Hebrew and Persian.

## Manifest

The host validates `manifest.json` at install time and keeps only the fields
below. Anything else is dropped without an error.

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | 2 to 64 characters, lowercase letters, digits and hyphens, starting and ending with a letter or digit |
| `name` | string | yes | at most 100 characters |
| `version` | string | yes | `1.2.3`, optionally with `-beta.1` or `+build` |
| `author` | string | yes | at most 200 characters |
| `description` | string | no | at most 2000 characters |
| `type` | string | yes | `ui-extension`, `sidebar-app` or `hook` (a label for the plugin lists; it doesn't change what the plugin may do) |
| `permissions` | string[] | no | names from [Permissions](#permissions); an unknown name refuses the install, duplicates are removed |
| `optionalPermissions` | string[] | no | 1.20 and later: permissions the plugin uses when the webmail offers them. Those the webmail knows are granted like `permissions` (consent included); unknown ones are left out with a warning. See [Optional permissions](#optional-permissions) |
| `entrypoint` | string | no | the `.js` or `.mjs` file in the ZIP, default `index.js`, no `..` or leading `/` |
| `tier` | string | no | `untrusted` (default) or `privileged`, see [Security notes](#security-notes) |
| `minAppVersion` | string | no | `1.2.3`; older webmails refuse the install. `1.15.0` or later when the plugin uses `@plugin-host/ui` or the composer API |
| `settingsSchema` | object | no | settings each user sets in Settings > Plugins |
| `configSchema` | object | no | settings the admin sets on the plugin's admin page |
| `locales` | object | no | translations, see below |
| `httpOrigins` | string[] | no | sites `api.http.fetch` may call |
| `frameOrigins` | string[] | no | sites the plugin may show in an iframe |
| `apiPostPaths` | string[] | no | webmail routes `api.http.post` may call |
| `credentials` | object | no | accounts and API keys for `api.proxy`, see [Accounts and API keys](#accounts-and-api-keys) |

The package itself: a ZIP of at most 5 MB with at most 200 files, none
larger than 20 MB unpacked, `manifest.json` at most 512 KB. Allowed file
types are `.js .mjs .css .json .png .svg .woff2 .jpg .jpeg .webp`. The
installer warns (but installs) when the code contains `eval(`,
`new Function(`, `document.cookie`, `document.write` or `innerHTML =`.

### settingsSchema

Per-user settings. The webmail draws the form in Settings > Plugins and the
plugin reads the values from `api.plugin.settings`, with defaults filled in.

```json
"settingsSchema": {
  "showBanner": { "type": "boolean", "label": "settings.showBanner", "default": true },
  "language":   { "type": "select", "label": "Language", "options": ["en", "de"], "default": "en" },
  "maxItems":   { "type": "number", "label": "Items", "default": 5, "min": 1, "max": 20 },
  "signature":  { "type": "string", "label": "Signature", "description": "Added below the text.", "default": "" }
}
```

Keys are 1 to 64 letters, digits and `_`, starting with a letter. Each field
needs `type` (`boolean`, `string`, `number` or `select`), `label` and a
`default` of the right type. A `select` needs a non-empty `options` list of
strings that contains the default; a `number` may set `min` and `max`. A
label, description or option that is a key in `locales` is shown
translated.

### configSchema

Settings for the admin, shown on the plugin's page in the admin dashboard.

```json
"configSchema": {
  "serverUrl": { "type": "string", "label": "Server address", "placeholder": "https://cloud.example.com", "default": "" },
  "apiKey":    { "type": "secret", "label": "API key", "required": true },
  "mode":      { "type": "select", "label": "Mode", "options": [{ "label": "Fast", "value": "fast" }] }
}
```

Field types are `string`, `secret`, `boolean`, `number` and `select`; each
needs a `label`, and may set `description`, `required`, `default` and
`placeholder`. `select` options are `{ label, value }` objects. A `string`
field with `"multiline": true` gets a full-width text box that keeps line
breaks (webmail 1.19.1 and later; older versions show one line). Admin labels
are shown as written, not translated.

Any user's plugin can read the non-secret values with `api.config.get()`.
`secret` fields never reach the plugin; use them through a credential with
`scope: "admin"`. Reading and changing every field with `api.admin.*` needs
`admin:config` and only works for an admin.

### locales

```json
"locales": {
  "en": { "settings.showBanner": "Show the banner", "greeting": "Hello {name}" },
  "de": { "settings.showBanner": "Banner anzeigen", "greeting": "Hallo {name}" }
}
```

At most 64 languages with at most 2000 strings each. Language tags look like
`en`, `de` or `fr-CA`.

### httpOrigins, frameOrigins and apiPostPaths

`httpOrigins` and `frameOrigins` take origins like `https://api.example.com`,
`https://api.example.com:8443` or `https://*.example.com` (one level of
subdomain). Only `https`, no paths, no IP addresses. Invalid entries are
dropped with a warning. `frameOrigins` are added to the page's `frame-src`.

`apiPostPaths` lists webmail routes like `/api/jitsi`. An entry that ends in
`/` allows every path below it. Some routes are never allowed, whatever the
manifest says: everything under `/api/account`, `admin`, `auth`, `caldav`,
`dev-jmap`, `plugin-approval-status`, `plugins`, `push`, `settings`,
`setup`, `system`, `webdav` and `wopi`.

## Permissions

A plugin gets a permission when its manifest lists it and either an admin
installed the plugin or the user accepted it in the consent dialog.
`ui:observe` and `app:lifecycle` are always granted. Without the permission:

- an `api` call rejects with `Plugin "<id>" lacks permission "<permission>"`;
- a hook is not registered (the console says so);
- a slot is not rendered, and an action surface refuses `setActions`;
- a prop or click context key that needs a read permission is left out.

High-risk permissions are listed first in the consent dialog and marked.

### Optional permissions

A plugin that uses host calls of a newer webmail, but should still install
on older ones, lists those calls' permissions in `optionalPermissions`
instead of `permissions`. Webmail 1.20 and later grant the ones they know
exactly like `permissions` (the consent dialog shows them) and leave out
the rest with an install warning; older webmails drop the field and install
the plugin without them. Check for the feature before using it, through its
flag in `api.host.features` (see [api.host](#apihost)), and hide what isn't
there:

```json
{
  "permissions": ["email:read", "calendar:write"],
  "optionalPermissions": ["calendar:respond"],
  "minAppVersion": "1.17.0"
}
```

A permission an older webmail doesn't know must not go into `permissions`:
that refuses the install there.

<!-- generated:permissions -->
<!-- Generated by scripts/gen-docs.mjs; edit the webmail catalogues, not this table. -->

| Permission | What the consent dialog says | High risk |
|---|---|---|
| `email:read` | **Read your email.** See senders, recipients, subjects and the full text of any message in your account, and your folders. | yes |
| `email:write` | **Change and organise your email.** Add or remove tags, flags and other keywords on your messages, move them between your folders and to the archive, and save drafts. It can also store a small value that every member of a team mailbox can read. |  |
| `email:send` | **Change mail before it is sent.** Read and change the recipients, subject, text and attachments of messages you write, and stop a message from being sent. | yes |
| `crypto:full` | **Full access to this app.** Runs with the same rights as the webmail itself. It can read all your mail and stored keys and act for you. Only allow this for plugins you fully trust. | yes |
| `keystore` | **Use certificates on this computer.** Ask to sign and decrypt messages with certificates on this computer or a smart card. The app asks you first. The plugin never gets the private key, but while you allow it, it can sign in your name and read what it decrypts. | yes |
| `email:raw-send` | **Send messages it built itself.** Send complete messages, for example signed or encrypted ones, from your account. | yes |
| `email:blob-read` | **Read attachments and message sources.** Read attachments (their text and pictures too) and the full source of messages you act on, and every file you attach before it is sent. | yes |
| `email:blob-write` | **Replace attachments before sending.** Upload files to your mail server and replace a file you attached with another one before the message is sent. | yes |
| `email:render-takeover` | **Change how messages are shown.** Replace the text of messages you open and of the message list, for example to show decrypted content. | yes |
| `compose:open` | **Open the composer for you.** Open a new message with recipients, text or attachments filled in. You still decide whether to send it. |  |
| `compose:read` | **Read the message you are writing.** Read a message while you write it, when you use the plugin in the composer: its text, subject, recipients including Bcc, and the names and sizes of attachments. Not the signature or the quoted message. |  |
| `compose:write` | **Change the message you are writing.** Replace or add text in a message while you write it, when you use the plugin in the composer. You can undo each change, and you still decide whether to send. |  |
| `compose:check` | **Check what you write.** Reads what you write in the composer while you type and may send it to the service it uses. Only where proofreading is on, and nothing while a message is set to be signed or encrypted. Text you wrote before you turned that on may already have been checked. | yes |
| `email:forward` | **Forward your mail.** Forward messages from your account with their attachments, without opening the composer. You are asked before the first forward to each address. | yes |
| `calendar:read` | **Read your calendar.** See your calendars and their events. |  |
| `calendar:write` | **Change your calendar.** Create, change and delete events. |  |
| `contacts:read` | **Read your contacts.** Search and read your address books. |  |
| `contacts:write` | **Change your contacts.** Create, change and delete contacts and address books. |  |
| `files:read` | **Read your files.** Find, open and read the files in your account. |  |
| `files:write` | **Change your files.** Save, create, rename and move files in your account, and stop a file from being deleted. |  |
| `identity:read` | **See your sender addresses.** See the addresses you send from and their signatures. |  |
| `identity:write` | **Change your sender addresses.** Create, change and delete sender addresses and signatures. | yes |
| `filters:read` | **Read your mail filters.** See the rules that sort your incoming mail. |  |
| `filters:write` | **Change your mail filters.** Add rules to your server-side filters. Such rules can move, forward or delete incoming mail. | yes |
| `tasks:read` | **Read your tasks.** See your task lists and tasks. |  |
| `tasks:write` | **Change your tasks.** Create, change, complete and delete tasks. |  |
| `templates:read` | **Read your templates.** See your saved message templates. |  |
| `templates:write` | **Change your templates.** Create, change and delete message templates. |  |
| `vacation:read` | **See your out-of-office reply.** See whether your automatic reply is on and what it says. |  |
| `vacation:write` | **Change your out-of-office reply.** Turn your automatic reply on or off and change its text and dates. | yes |
| `settings:read` | **Read your settings.** See your preferences and tag definitions. |  |
| `settings:write` | **Change your tags.** Add, rename and reorder your tags, and stop changes to your settings. |  |
| `security:read` | **See your account security.** See whether two-factor sign-in and encryption are on, without access to secrets. |  |
| `auth:observe` | **Know when you sign in.** Be told when you sign in, switch accounts or your session is renewed. |  |
| `auth:emit` | **Sign you out.** Sign you out of the webmail. |  |
| `account:read` | **See your accounts.** See the accounts you added with their addresses and servers, and which mail accounts are team mailboxes. |  |
| `directory:read` | **Look up people.** Look up people in your organisation's directory. |  |
| `http:post` | **Use the webmail server for you.** Call these server endpoints with your login: | yes |
| `http:fetch` | **Connect to other websites.** Send requests to these sites. Anything the plugin can read may be sent there: | yes |
| `ui:observe` | **Follow where you are in the app.** Know which page is open and react to links you click. Always granted; not shown in the dialog. |  |
| `ui:toolbar` | **Add buttons to toolbars.** Show its own buttons in the message toolbar, on an open message and in the top bar. |  |
| `ui:app-top-banner` | **Show a banner at the top.** Show a notice across the top of the app. |  |
| `ui:email-banner` | **Show notices on messages.** Show its own notices and summaries above, inside and between the parts of an open message or conversation. |  |
| `ui:email-footer` | **Add content below messages.** Show its own content under an open message. |  |
| `ui:contact-cryptokeys` | **Show encryption keys of contacts.** Show and manage the encryption keys on a contact. |  |
| `ui:email-details` | **Add panels to message details.** Show its own panel next to or below an open message. |  |
| `ui:download-file` | **Save files to your device.** Offer files it created for download. |  |
| `ui:notifications` | **Show notifications.** Show notifications on your device, or in the app if you haven't allowed them. Each one names the plugin. |  |
| `ui:message-list-tabs` | **Add tabs to your inbox.** Sort your inbox into tabs such as Updates or Promotions. |  |
| `ui:composer-toolbar` | **Add to the composer.** Show its own buttons, menu entries and sections while you write a message. |  |
| `ui:composer-sidebar` | **Add a panel to the composer.** Show its own panel next to the message you write. |  |
| `ui:sidebar-widget` | **Add to the sidebar.** Show its own boxes and sections in the mail sidebar. |  |
| `ui:settings-section` | **Add a settings page.** Show its own page in Settings. |  |
| `ui:context-menu` | **Add to the message menu.** Add entries to the menu that opens when you right-click a message. |  |
| `ui:navigation-rail` | **Add to the navigation bar.** Show its own button in the navigation bar. |  |
| `ui:keyboard` | **Add keyboard shortcuts.** React to keyboard shortcuts it defines. |  |
| `ui:calendar-action` | **Add to the calendar.** Show its own buttons and sections on events, and short labels and dots on calendar days. |  |
| `ui:admin-page` | **Add an admin page.** Show its own page in the admin settings. |  |
| `ui:message-list` | **Add to the message list.** Show its own content above the message list, and buttons on messages and in the selection toolbar. |  |
| `ui:contacts` | **Add to contacts.** Show its own sections in a contact's details and buttons in the contact list. |  |
| `ui:tasks` | **Add to tasks.** Show its own sections in a task's details, buttons in the task list, and its own task list in place of Bulwark's. |  |
| `ui:files` | **Add to files.** Show its own sections in the file preview and entries in a file's menu. |  |
| `ui:commands` | **Add commands.** Add its own entries to the command palette (Ctrl+K). |  |
| `ui:app-page` | **Add pages.** Add its own pages to the app, each with a button in the navigation bar. |  |
| `http:proxy` | **Use accounts you connect.** Send requests through Bulwark's server with an account or key that you or your administrator set up. The plugin never sees the password, but it can do anything that account can do on its own server. | yes |
| `admin:config` | **Read its settings from your administrator.** Read the settings your administrator saved for this plugin. |  |
| `app:lifecycle` | **Know when the app starts and stops.** Be told when the app starts, goes offline or you sign out. Always granted; not shown in the dialog. |  |
| `calendar:respond` | **Answer invitations.** Accept or decline calendar invitations. Your answer goes to the organiser by email. | yes |
| `settings:change` | **Change your settings.** Change how the app looks and works, such as the theme, the time format or the reading pane. Settings your organisation set stay as they are. | yes |
| `ui:side-panel` | **Add a panel to other views.** Show its own panel next to Calendar, Contacts, Files and Settings. |  |

<!-- /generated:permissions -->

## Hooks

Hooks let a plugin react to what happens in the app, and change or stop some
of it. Export them as `hooks`; they run in the background frame.

```js
export const hooks = {
  // observer: told after the fact
  onEmailOpen(email) { /* ... */ },
  // intercept: return false to stop it
  async onBeforeEmailSend(outgoing) {
    if (outgoing.to.length > 50) {
      return api.ui.confirm({ title: 'Send to everyone?', message: `${outgoing.to.length} recipients` });
    }
  },
  // transform: return a new value, or nothing to leave it
  onBuildQuoteHeader(header, ctx) {
    return { ...header, text: `On ${ctx.date}, ${ctx.from?.email} wrote:` };
  },
};
```

How each kind behaves:

- **observer**: the return value is ignored.
- **intercept**: return `false` to stop the action. Anything else lets it go
  ahead. A few intercepts also take a value instead: `onBeforeCompose`
  (return `ComposeOptions` to fill the composer), `onBeforeExternalLink`
  (return `{ href }` to send the click elsewhere, http and https only) and
  `onBeforeDraftAutoSave` (return a changed draft). There `false` stops,
  `undefined`, `null` and `true` keep the value, and handlers run one after
  the other, each seeing the previous result.
- **transform**: return the changed value, or `undefined` (or `false`) to
  leave it. Handlers run in order and each sees the previous result.
- **takeover**: `onComposeSend` only. Return `false` when the plugin sent the
  message itself, `{ abort: true }` to stop the send (after telling the
  user), anything else to let the webmail send it.

Timing and failures:

- A handler has 5 seconds. Intercepts and takeovers get at least 60 seconds,
  because they often wait for a dialog. `onBeforeEmailSend` and
  `onComposeSend` get 10 minutes, `onBeforeBlobUpload` 15 minutes.
- An intercept that throws or runs out of time counts as "go ahead", except
  `onBeforeEmailSend`, which then stops the send. A takeover that fails
  stops the send as well, so a crypto plugin's failure never sends a
  message in clear text.
- Three failures (an exception, a rejected promise or a timeout) within 60
  seconds turn the plugin off. The user sees a notice and can turn it on
  again in Settings > Plugins. When a hook times out, the host closes the
  plugin's open dialogs, since nothing waits for their answer any more.
- From 1.20, while a plugin the admin forces on is loading, failed to start
  or was turned off after errors, and it checks sends (`onBeforeEmailSend`),
  Bulwark doesn't send at all: it waits up to 8 seconds, then tells the user
  a required check isn't running. A `false` from the hook never counts as a
  failure. The message is built after that wait, so a check that was still
  starting gets the whole of it.
- From 1.20 a plugin frame may start a Web Worker from a blob URL
  (`worker-src 'self' blob:`), for work it has to stop at a deadline. The
  worker has the frame's own network limits.

What `onBeforeEmailSend` gets (1.20 and later; older hosts leave the new
fields out, so treat them as optional). It runs for the composer, quick
replies and `api.email.forward`:

```js
{
  to, cc, bcc, subject, htmlBody, textBody, identityId, fromEmail, inReplyTo,
  surface: 'composer' | 'quick-reply' | 'plugin-forward',
  mode: 'compose' | 'reply' | 'replyAll' | 'forward',
  authoredText,        // what the user wrote: no quoted original, no signature
  externalRecipients,  // bare lowercase addresses outside the organisation
                       // of the sending account (empty: all internal)
  attachments: [{
    name, type, size,
    blobId, inline,    // inline: an image shown in the body
    sniffedType,       // what the first bytes say: application/x-msdownload,
                       // application/zip, application/pdf, text/plain, ...
    textExcerpt,       // first 1 MB of a text file; email:blob-read only
    unreadable,        // true: Bulwark couldn't read the file; treat as not checked
  }],
}
```

`onBeforeAttachmentUpload` gets `sniffedType` (or `unreadable`) too, for a
file from the user's device. `onBeforeExternalLink` gets `{ href, target,
emailId, text }`, `text` being what the link says (1.20 and later). `href`
is the address as the browser parses it (`new URL(href).href`), and that
exact string is what opens, so check that one. It fails open, so a check
that must hold a link returns `false` and opens it itself with
`api.ui.openExternalUrl`, which doesn't come back to the plugin's own
handler.
- Some hooks run for every row of the message list or on every keystroke.
  Answer from memory and do slow work afterwards.

Two hooks are not in the table because they belong to the plugin's own UI:
`onAction({ surface, actionId, context })` receives clicks on the buttons it
declared with `api.ui.setActions`, and each entry of `shortcuts` runs its
`handler`. Neither needs a permission of its own (shortcuts need
`ui:keyboard`).

<!-- generated:hooks -->
<!-- Generated by scripts/gen-docs.mjs; edit the webmail catalogues, not this table. -->

212 hooks in 27 groups.

#### Mail: message list

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onEmailsFetched` | transform | `email:render-takeover` | `Email[] (list rows), { mailboxId }` | after a page of the message list is loaded, before it is shown |
| `onEmailListItemRender` | transform | `email:read` | `EmailListBadge[], { email: EmailSummary }` | for each visible row; returned badges are shown next to the subject |
| `onEmailSelectionChange` | observer | `email:read` | `{ emailIds: string[] }` | when the set of selected messages changes |
| `onMailboxChange` | observer | `email:read` | `{ mailboxId, role, previousMailboxId }` | when the user opens another folder |

#### Mail: reading

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onEmailOpen` | observer | `email:read` | `EmailReadView` | when a message is opened |
| `onEmailClose` | observer | `email:read` | `{ emailId }` | when the open message is closed or replaced |
| `onRenderEmailBody` | transform | `email:render-takeover` | `RenderableBody, MessageContext` | before the body of an opened message is rendered |
| `onEmailContentRender` | observer | `email:read` | `{ emailId, hasHtml, hasExternalContent }` | after the body of an opened message is on screen |
| `onThreadExpand` | observer | `email:read` | `{ threadId, emailIds, expanded }` | when a conversation is expanded or collapsed |
| `onBeforeReply` | intercept | `email:read` | `ReplyContext` | when Reply is chosen, before the composer opens |
| `onBeforeReplyAll` | intercept | `email:read` | `ReplyContext` | when Reply all is chosen, before the composer opens |
| `onBeforeForward` | intercept | `email:read` | `ReplyContext` | when Forward is chosen, before the composer opens |
| `onBeforeExternalLink` | intercept | `ui:observe` | `ExternalLinkContext` | when a link is opened (mail, reader view, events, contacts, notifications, the unsubscribe link, links other plugins open); return false to stop it or { href } to change it |
| `onAvatarResolve` | transform | `email:read` | `string \| null (avatar URL), { email, name }` | when a sender avatar is needed |

#### Mail: writing

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onBeforeCompose` | intercept | `email:send` | `ComposeOptions` | before the composer opens; return false to stop it or a ComposeOptions to prefill it |
| `onComposerOpen` | observer | `email:read` | `ComposerContext` | after the composer opened |
| `onComposerClose` | observer | `email:read` | `{ draftId, sent: boolean }` | after the composer closed |
| `onDraftChange` | observer | `email:read` | `DraftView` | while the user writes (debounced) |
| `onBeforeDraftAutoSave` | transform | `email:send` | `AlmostSavedDraft` | before a draft is saved; return a changed draft, or false to skip a save while typing (saves on close and before send always run) |
| `onDraftAutoSave` | observer | `email:read` | `{ draftId, subject }` | after a draft was saved |
| `onBeforeEditDraft` | transform | `email:send` | `Email` | before a saved draft is opened in the composer |
| `onBuildQuoteHeader` | transform | `email:send` | `QuoteHeader, QuoteHeaderContext` | when a reply or forward is set up |
| `onRecipientChipsChange` | transform | `email:send` | `Recipient[]` | when the recipient fields change |
| `onBeforeComposeOpenToReply` | transform | `email:send` | `Email (the original)` | before a reply is filled in |
| `onBeforeComposeOpenToReplyAll` | transform | `email:send` | `Email (the original)` | before a reply-all is filled in |
| `onBeforeComposeOpenToForward` | transform | `email:send` | `Email (the original)` | before a forward is filled in |
| `onBeforeComposeOpenToForwardAsAttachment` | transform | `email:send` | `Email (the original)` | before a forward-as-attachment is filled in |
| `onMailtoIntercept` | intercept | `email:read` | `MailtoContext` | when a mailto: link is opened; return false to stop the composer |

#### Mail: sending

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onBeforeEmailSend` | intercept | `email:send` | `OutgoingEmail` | when Send is pressed; a handler that fails or times out stops the send |
| `onTransformOutgoingEmail` | transform | `email:send` | `OutgoingEmail` | right before the message is submitted |
| `onComposeSend` | takeover | `email:send` | `ComposeSendRequest` | at the start of sending; may send the message itself |
| `onAfterEmailSend` | observer | `email:read` | `{ emailId, accountId, submissionId, to, cc, bcc, subject, scheduledFor, composerId }` | after the server accepted the message |

#### Mail: organizing

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onBeforeEmailDelete` | intercept | `email:write` | `{ emailIds, permanent }` | before messages are deleted or moved to Trash |
| `onAfterEmailDelete` | observer | `email:read` | `{ emailIds, permanent }` | after messages were deleted |
| `onBeforeEmailMove` | intercept | `email:write` | `{ emailIds, fromMailboxId, toMailboxId }` | before messages are moved (toMailboxId null: removed from fromMailboxId only, still in other folders) |
| `onAfterEmailMove` | observer | `email:read` | `{ emailIds, fromMailboxId, toMailboxId }` | after messages were moved (toMailboxId null: removed from fromMailboxId only, still in other folders) |
| `onBeforeEmailArchive` | intercept | `email:write` | `{ emailIds }` | before messages are archived |
| `onEmailArchive` | observer | `email:read` | `{ emailIds }` | after messages were archived |
| `onEmailUnarchive` | observer | `email:read` | `{ emailIds, toMailboxId }` | after messages were moved out of the archive |
| `onBeforeEmailSpamToggle` | intercept | `email:write` | `{ emailIds, spam }` | before messages are marked as spam or not spam |
| `onEmailSpamToggle` | observer | `email:read` | `{ emailIds, spam }` | after messages were marked as spam or not spam |
| `onBeforeEmailReadStateChange` | intercept | `email:write` | `{ emailIds, read }` | before messages are marked read or unread |
| `onEmailReadStateChange` | observer | `email:read` | `{ emailIds, read }` | after messages were marked read or unread |
| `onBeforeEmailStarToggle` | intercept | `email:write` | `{ emailIds, starred, accountId }` | before messages are starred or unstarred; `accountId` names the messages' account when it is not the user's own (a team or shared mailbox) |
| `onEmailStarToggle` | observer | `email:read` | `{ emailIds, starred, accountId }` | after messages were starred or unstarred; `accountId` as on onBeforeEmailStarToggle |
| `onBeforeEmailKeywordChange` | intercept | `email:write` | `{ emailIds, added: string[], removed: string[] }` | before tags or other keywords are changed |
| `onEmailKeywordChange` | observer | `email:read` | `{ emailIds, added: string[], removed: string[] }` | after tags or other keywords changed |
| `onBeforeEmailCategorize` | intercept | `email:read` | `EmailCategorizeContext` | before messages are moved to another inbox tab |
| `onEmailCategorize` | observer | `email:read` | `EmailCategorizeContext` | after messages were moved to another inbox tab |

#### Mail: folders

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onMailboxesRefresh` | observer | `email:read` | `MailboxView[]` | after the folder list was loaded or refreshed |
| `onBeforeMailboxCreate` | intercept | `email:write` | `{ name, parentId }` | before a folder is created |
| `onMailboxCreate` | observer | `email:read` | `{ mailboxId, name, parentId }` | after a folder was created |
| `onBeforeMailboxRename` | intercept | `email:write` | `{ mailboxId, name }` | before a folder is renamed |
| `onMailboxRename` | observer | `email:read` | `{ mailboxId, name, previousName }` | after a folder was renamed |
| `onBeforeMailboxDelete` | intercept | `email:write` | `{ mailboxId, name }` | before a folder is deleted |
| `onMailboxDelete` | observer | `email:read` | `{ mailboxId, name }` | after a folder was deleted |
| `onBeforeMailboxEmpty` | intercept | `email:write` | `{ mailboxId, role }` | before a folder (usually Trash or Spam) is emptied |
| `onMailboxEmpty` | observer | `email:read` | `{ mailboxId, role, count }` | after a folder was emptied |
| `onQuotaChange` | observer | `email:read` | `QuotaView` | when the storage quota was read and changed |

#### Mail: search

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onSearch` | transform | `email:read` | `{ query, filters: SearchFilters }` | before a search runs; may change the query and filters |
| `onSearchResults` | transform | `email:read` | `string[], { query, filters, emailIds }` | after search results arrived; return ids of further messages to add to them (at most 100) |
| `onProvideSearchResults` | transform | `email:read` | `ExternalSearchResult[], { query, filters }` | to add results from elsewhere to a search; drawn above its message list; an entry naming a message (email) opens it on a click, any other click comes back as onAction with surface "search-results" and the entry's key |

#### Mail: attachments

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onBeforeAttachmentUpload` | intercept | `email:read` | `AttachmentInfo` | before a file is attached in the composer |
| `onBeforeBlobUpload` | transform | `email:blob-write` | `{ file, blobId } \| ExternalAttachmentResult` | before an attachment is uploaded; may offload it |
| `onAfterAttachmentUpload` | observer | `email:read` | `AttachmentInfo` | after an attachment was uploaded |
| `onAttachmentDownload` | observer | `email:read` | `AttachmentInfo` | when an attachment of a message is downloaded |
| `onAttachmentPreview` | transform | `email:render-takeover` | `AttachmentPreview, AttachmentInfo` | when an attachment preview opens |

#### Mail: new mail

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onNewEmailReceived` | observer | `email:read` | `EmailSummary` | for each new message in the inbox (push or poll) |
| `onPushConnectionChange` | observer | `email:read` | `{ connected: boolean }` | when live updates connect or drop |
| `onSyncStateChange` | observer | `email:read` | `{ state: "syncing" \| "idle" \| "error", error? }` | when the app starts or finishes fetching changes from the server |

#### Calendar

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onCalendarEventOpen` | observer | `calendar:read` | `CalendarEventView` | when an event is opened |
| `onCalendarEventFormOpen` | observer | `calendar:read` | `CalendarEventFormView` | when the event form opens |
| `onCalendarEventFormSave` | transform | `calendar:write` | `CalendarEventFormSavePatch, CalendarEventFormView` | while the event form is saved |
| `onCheckEventConflicts` | transform | `calendar:read` | `ConflictWarning[], { event }` | while start or end change in the event form |
| `onBeforeEventCreate` | intercept | `calendar:write` | `CalendarEventView` | before an event is created |
| `onAfterEventCreate` | observer | `calendar:read` | `CalendarEventView` | after an event was created |
| `onBeforeEventUpdate` | intercept | `calendar:write` | `{ eventId, patch }` | before an event is changed |
| `onAfterEventUpdate` | observer | `calendar:read` | `CalendarEventView` | after an event was changed |
| `onBeforeEventDelete` | intercept | `calendar:write` | `{ eventId, title }` | before an event is deleted |
| `onAfterEventDelete` | observer | `calendar:read` | `{ eventId, title }` | after an event was deleted |
| `onBeforeEventRsvp` | intercept | `calendar:write` | `{ eventId, status }` | before an invitation is answered |
| `onEventRsvp` | observer | `calendar:read` | `{ eventId, status }` | after an invitation was answered |
| `onBeforeEventsImport` | intercept | `calendar:write` | `{ calendarId, count }` | before events from a file are imported |
| `onEventsImport` | observer | `calendar:read` | `{ calendarId, imported, skipped }` | after events were imported |
| `onCalendarDateChange` | observer | `calendar:read` | `{ date }` | when the shown date changes |
| `onCalendarViewChange` | observer | `calendar:read` | `{ view }` | when day, week, month or agenda view is chosen |
| `onCalendarChange` | observer | `calendar:read` | `{ calendarId, change: "created" \| "updated" \| "removed" }` | after a calendar was created, changed or removed |
| `onCalendarVisibilityToggle` | observer | `calendar:read` | `{ calendarId, visible }` | when a calendar is shown or hidden |
| `onICalSubscriptionChange` | observer | `calendar:read` | `{ subscriptionId, change: "added" \| "updated" \| "removed" \| "refreshed" }` | when a calendar subscription changes |
| `onBeforeCalendarAlert` | intercept | `calendar:write` | `CalendarAlertView` | before Bulwark shows a reminder of an event or a task, in every open tab; return false to show it yourself (no toast, sound or title alert from Bulwark; onCalendarAlert still fires); a task's needs tasks:write, an event's calendar:write |
| `onCalendarAlert` | observer | `calendar:read` | `CalendarAlertView ({ id, eventId, eventTitle, triggerTime } or { id, taskId, taskTitle, triggerTime })` | when a reminder of an event or a task fires, in every open tab, also one a plugin took over; a task's needs tasks:read, an event's calendar:read |
| `onCalendarAlertAcknowledge` | observer | `calendar:read` | `{ alertId, eventId } or { alertId, taskId }` | when the user closes a reminder's toast, in that tab only; a task's needs tasks:read, an event's calendar:read |

#### Contacts

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onContactOpen` | observer | `contacts:read` | `ContactView` | when a contact is opened |
| `onBeforeContactCreate` | intercept | `contacts:write` | `ContactView` | before a contact is created |
| `onAfterContactCreate` | observer | `contacts:read` | `ContactView` | after a contact was created |
| `onBeforeContactUpdate` | intercept | `contacts:write` | `{ contactId, patch }` | before a contact is changed |
| `onAfterContactUpdate` | observer | `contacts:read` | `ContactView` | after a contact was changed |
| `onBeforeContactDelete` | intercept | `contacts:write` | `{ contactIds }` | before contacts are deleted |
| `onAfterContactDelete` | observer | `contacts:read` | `{ contactIds }` | after contacts were deleted |
| `onContactsImport` | observer | `contacts:read` | `{ addressBookId, imported }` | after contacts were imported |
| `onContactSelectionChange` | observer | `contacts:read` | `{ contactIds }` | when the selected contacts change |
| `onContactGroupChange` | observer | `contacts:read` | `{ groupId, change: "created" \| "updated" \| "deleted" }` | after a contact group changed |
| `onContactGroupMemberChange` | observer | `contacts:read` | `{ groupId, added, removed }` | after members were added to or removed from a group |
| `onContactMove` | observer | `contacts:read` | `{ contactId, toAddressBookId }` | after a contact moved to another address book |
| `onProvideRecipientSuggestions` | transform | `contacts:read` | `RecipientSuggestion[], { query }` | to add suggestions to recipient autocomplete |

#### Tasks

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onTasksLoaded` | observer | `tasks:read` | `TaskView[]` | after the task list was loaded |
| `onBeforeTaskCreate` | intercept | `tasks:write` | `TaskView` | before a task is created |
| `onTaskCreate` | observer | `tasks:read` | `TaskView` | after a task was created |
| `onBeforeTaskUpdate` | intercept | `tasks:write` | `{ taskId, patch }` | before a task is changed |
| `onTaskUpdate` | observer | `tasks:read` | `TaskView` | after a task was changed |
| `onBeforeTaskDelete` | intercept | `tasks:write` | `{ taskId, title }` | before a task is deleted |
| `onTaskDelete` | observer | `tasks:read` | `{ taskId, title }` | after a task was deleted |
| `onTaskToggleComplete` | observer | `tasks:read` | `{ taskId, complete }` | after a task was checked off or reopened |
| `onTaskFilterChange` | observer | `tasks:read` | `{ filter, showCompleted }` | when the task filter changes |

#### Files

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onFileNavigate` | observer | `files:read` | `{ path }` | when another folder is opened |
| `onBeforeFileUpload` | intercept | `files:write` | `{ name, size, type, path }` | before a file is uploaded |
| `onAfterFileUpload` | observer | `files:read` | `FileResourceView` | after a file was uploaded |
| `onFileUploadCancel` | observer | `files:read` | `{ name, path }` | when an upload is cancelled |
| `onFileDownload` | observer | `files:read` | `FileResourceView` | when a file is downloaded |
| `onDirectoryCreate` | observer | `files:read` | `FileResourceView` | after a folder was created |
| `onBeforeFileDelete` | intercept | `files:write` | `{ files: FileResourceView[] }` | before files are deleted |
| `onAfterFileDelete` | observer | `files:read` | `{ files: FileResourceView[] }` | after files were deleted |
| `onBeforeFileRename` | intercept | `files:write` | `{ file, newName }` | before a file is renamed |
| `onFileRename` | observer | `files:read` | `{ file, previousName }` | after a file was renamed |
| `onBeforeFileMove` | intercept | `files:write` | `{ files, toPath }` | before files are moved |
| `onFileMove` | observer | `files:read` | `{ files, toPath }` | after files were moved |
| `onFileCopy` | observer | `files:read` | `{ files, toPath }` | after files were copied |
| `onFileDuplicate` | observer | `files:read` | `FileResourceView` | after a file was duplicated |
| `onFileFavoriteToggle` | observer | `files:read` | `{ file, favorite }` | when a file is starred or unstarred |
| `onFileSelectionChange` | observer | `files:read` | `{ files: FileResourceView[] }` | when the selected files change |
| `onFileUndo` | observer | `files:read` | `{ action }` | after the last file action was undone |

#### Settings

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onBeforeSettingChange` | intercept | `settings:write` | `{ key, value, previous }` | before a preference is changed |
| `onSettingChange` | observer | `settings:read` | `{ key, value, previous }` | after a preference changed |
| `onSettingsExport` | observer | `settings:read` | `{ keys: string[] }` | after settings were exported |
| `onSettingsImport` | observer | `settings:read` | `{ keys: string[] }` | after settings were imported |
| `onSettingsReset` | observer | `settings:read` | `{}` | after settings were reset to defaults |
| `onSettingsSync` | observer | `settings:read` | `{ direction: "pulled" \| "pushed" }` | after settings were synced with the server |
| `onKeywordChange` | observer | `settings:read` | `{ keywords: KeywordView[] }` | after the tag definitions changed |
| `onTrustedSenderChange` | observer | `settings:read` | `{ email, trusted }` | after a sender was trusted or untrusted for remote content |

#### Sender identities

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onIdentitiesLoaded` | observer | `identity:read` | `IdentityView[]` | after sender identities were loaded |
| `onBeforeIdentityChange` | intercept | `identity:write` | `{ identityId?, change: "create" \| "update" \| "delete", identity? }` | before an identity is created, changed or deleted |
| `onIdentityCreate` | observer | `identity:read` | `IdentityView` | after an identity was created |
| `onIdentityUpdate` | observer | `identity:read` | `IdentityView` | after an identity was changed |
| `onIdentityDelete` | observer | `identity:read` | `{ identityId }` | after an identity was deleted |
| `onIdentitySelect` | observer | `identity:read` | `IdentityView` | when another From identity is chosen in the composer |
| `onSignatureRender` | transform | `identity:read` | `{ html, text }, { identityId }` | when a signature is inserted into the composer |

#### Filters

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onFiltersLoaded` | observer | `filters:read` | `FilterRuleView[]` | after filter rules were loaded |
| `onFilterRuleChange` | observer | `filters:read` | `{ ruleId, change: "added" \| "updated" \| "deleted" \| "reordered" \| "toggled" }` | after a filter rule changed in the editor |
| `onBeforeFiltersSave` | intercept | `filters:write` | `{ rules: FilterRuleView[] }` | before filter rules are saved to the server |
| `onFiltersSave` | observer | `filters:read` | `{ accountId }` | after the filter script was saved |
| `onSieveScriptChange` | observer | `filters:read` | `{ accountId }` | after the active script changed |
| `onSieveScriptGenerate` | transform | `filters:write` | `string (Sieve script), SieveScriptGenerateContext` | before the generated script is uploaded |

#### Out of office

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onVacationLoaded` | observer | `vacation:read` | `VacationView` | after the out-of-office reply was loaded |
| `onBeforeVacationUpdate` | intercept | `vacation:write` | `VacationView` | before the out-of-office reply is changed |
| `onVacationUpdate` | observer | `vacation:read` | `VacationView` | after the out-of-office reply was changed |

#### Templates

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onTemplateCreate` | observer | `templates:read` | `TemplateView` | after a template was created |
| `onTemplateUpdate` | observer | `templates:read` | `TemplateView` | after a template was changed |
| `onTemplateDelete` | observer | `templates:read` | `{ templateId }` | after a template was deleted |
| `onTemplatesImport` | observer | `templates:read` | `{ count }` | after templates were imported |
| `onTemplateApply` | observer | `templates:read` | `TemplateView` | after a template was inserted into the composer |
| `onTemplateRender` | transform | `templates:read` | `{ subject, html, text }, { templateId }` | before a template is inserted; may change the text |

#### Sign-in and accounts

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onLogin` | observer | `auth:observe` | `{ accountId, username }` | after a sign-in |
| `onAuthReady` | observer | `auth:observe` | `{ accountId }` | when the session is ready after start or sign-in |
| `onTokenRefresh` | observer | `auth:observe` | `{ accountId }` | after the access token was renewed |
| `onAccountAdd` | observer | `auth:observe` | `{ accountId }` | after another account was added |
| `onAccountRemove` | observer | `auth:observe` | `{ accountId }` | after an account was removed |
| `onAccountSwitch` | observer | `app:lifecycle` | `{ accountId, previousAccountId }` | after another account was made active |
| `onBeforeLogout` | observer | `app:lifecycle` | `{ accountId }` | just before signing out |
| `onAfterLogout` | observer | `app:lifecycle` | `{ accountId }` | after signing out |
| `onOAuthCallback` | observer | `http:fetch` | `OAuthCallbackPayload` | when a third-party OAuth flow this plugin started returns |

#### Account security

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onPasswordChange` | observer | `security:read` | `{}` | after the account password was changed |
| `onTotpChange` | observer | `security:read` | `{ enabled }` | after two-factor sign-in was turned on or off |
| `onAppPasswordChange` | observer | `security:read` | `{ change: "created" \| "removed" }` | after an app password was created or removed |
| `onEncryptionChange` | observer | `security:read` | `{ enabled }` | after encryption at rest was changed |
| `onDisplayNameChange` | observer | `security:read` | `{ displayName }` | after the account display name was changed |

#### Navigation

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onNavigate` | observer | `ui:observe` | `RouteContext` | after the app moved to another page |
| `onRouteEnter` | observer | `ui:observe` | `RouteContext` | when a page is entered |
| `onRouteLeave` | observer | `ui:observe` | `RouteContext` | when a page is left |

#### Theme and language

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onThemeChange` | observer | `ui:observe` | `{ theme: "light" \| "dark" \| "system", resolved: "light" \| "dark" }` | after the colour scheme changed |
| `onCustomThemeChange` | observer | `ui:observe` | `{ themeId }` | after another theme was activated |
| `onThemeBeforeApply` | transform | `ui:observe` | `string (CSS), { themeId, variant }` | before theme CSS is applied |
| `onLocaleChange` | observer | `ui:observe` | `{ locale }` | after the app language changed |

#### Notifications

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onToastShow` | observer | `ui:observe` | `{ id, type, title, message }` | when the app shows a toast |
| `onToastDismiss` | observer | `ui:observe` | `{ id }` | when a toast is dismissed |
| `onNotificationClick` | observer | `ui:notifications` | `{ tag }` | when a notification the plugin showed, or one from the app, is clicked |

#### App lifecycle

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onAppReady` | observer | `app:lifecycle` | `{ accountId }` | once after the app has started and the mail data is loaded |
| `onVisibilityChange` | observer | `app:lifecycle` | `{ visible }` | when the tab is hidden or shown |
| `onWindowFocus` | observer | `app:lifecycle` | `{}` | when the window gains focus |
| `onWindowBlur` | observer | `app:lifecycle` | `{}` | when the window loses focus |
| `onOnline` | observer | `app:lifecycle` | `{}` | when the network comes back |
| `onOffline` | observer | `app:lifecycle` | `{}` | when the network goes away |
| `onBeforeUnload` | observer | `app:lifecycle` | `{}` | when the page is about to close |
| `onAppError` | observer | `app:lifecycle` | `{ message }` | when an unhandled error occurs in the app |
| `onInterval` | observer | `app:lifecycle` | `{ now }` | once a minute while the app is open |

#### Layout

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onViewChange` | observer | `ui:observe` | `{ view: "sidebar" \| "list" \| "viewer" }` | when the phone layout switches between folders, message list and message |
| `onSidebarToggle` | observer | `ui:observe` | `{ open }` | when the sidebar is opened or closed |
| `onSidebarCollapse` | observer | `ui:observe` | `{ collapsed }` | when the sidebar is collapsed or expanded |
| `onDeviceTypeChange` | observer | `ui:observe` | `{ deviceType: "mobile" \| "tablet" \| "desktop" }` | when the layout switches between phone, tablet and desktop |
| `onColumnResize` | observer | `ui:observe` | `{ column: "sidebar" \| "email-list" \| "email-list-height", width }` | after a column was resized or reset |
| `onMobileBack` | observer | `ui:observe` | `{}` | when Back is used on the phone layout |
| `onTextSelectionChange` | observer | `email:read` | `SelectionContext` | when the user selects text (debounced) |
| `onDragStart` | observer | `email:read` | `{ kind: "email", ids }` | when messages start being dragged |
| `onDragEnd` | observer | `email:read` | `{ kind, ids, dropped }` | when a drag ends |
| `onEmailDrop` | observer | `email:read` | `{ emailIds, targetMailboxId }` | after messages were dropped on a folder |
| `onTagDrop` | observer | `email:read` | `{ emailIds, keyword }` | after a tag was dropped on messages |
| `onSidebarAppOpen` | observer | `ui:observe` | `{ appId }` | when a sidebar app is opened |
| `onSidebarAppClose` | observer | `ui:observe` | `{ appId }` | when a sidebar app is closed |

#### Keyboard

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onBeforeShortcut` | intercept | `ui:keyboard` | `{ key, action }` | before an app shortcut runs; return false to stop it |
| `onAfterShortcut` | observer | `ui:keyboard` | `{ key, action }` | after an app shortcut ran |

#### Inbox tabs

| Hook | Kind | Permission | Receives | When |
|---|---|---|---|---|
| `onTabsChange` | observer | `ui:message-list-tabs` | `MessageListTab[]` | after the set of inbox tabs changed |
| `onTabActivate` | observer | `ui:message-list-tabs` | `TabActivateContext` | when another inbox tab is chosen |
| `onTabCountsRefresh` | observer | `ui:message-list-tabs` | `Record<tabId, number>` | after the unread counts per tab were refreshed |

<!-- /generated:hooks -->

## UI surfaces

There are three kinds of surface:

- **frame**: the plugin renders a React component in its own sandboxed
  frame. For banners, panels, sections and pages. An **inline** frame sits
  in a row of buttons and takes the width of its content.
- **action**: the plugin declares buttons or menu entries as data with
  `api.ui.setActions`, and the host draws them in its own style. For things
  that repeat per row or must look like the rest of a menu.
- **data**: the plugin hands the host plain data to draw, such as labels on
  calendar days.

### Frame slots

```js
export const slots = {
  'reader-header': {
    component: ReaderNote,          // gets the props from the table below
    shouldShow: (props) => true,    // optional, runs in the background frame
    order: 50,                      // optional, lower comes first, default 100
  },
};
```

- **Props.** The component receives the props listed for the slot, minus
  those the plugin has no permission for. New props arrive as a re-render.
  Host callbacks in props are async functions.
- **shouldShow** runs in the background frame before the slot frame is
  created, with the same props but without the callbacks. If it returns
  false or throws, nothing is mounted. It is cheaper than rendering an empty
  component.
- **Size.** The host watches the size of the element your component renders
  into and sets the frame's height to match, up to 2000 px (more scrolls
  inside the frame). An outer `margin` of your root element is not counted,
  so use `padding`. Inline slots are measured at their natural width, up to
  480 px.
- **Filling a panel.** A panel slot (`composer-sidebar`,
  `composer-sidebar-right`, `email-detail-sidebar`, and from 1.20
  `app-side-panel`) may declare `fill: true`
  instead: the frame is then as tall as the panel and your root element gets
  `height: 100%`, so you can pin controls at the bottom (a chat input) and
  scroll a part of your own. Nothing is measured; the user drags the
  panel's edge to make it wider. With `startFolded: true` the panel starts
  folded until the user or the plugin opens it, and stays the way the user
  left it: for a chat that is opened on demand, not on every message.
- **Opening a panel.** `api.ui.openPanel(slot, { composerId })`,
  `closePanel` and `togglePanel` open and close the panel one of those
  slots sits in, from a toolbar button, a shortcut or a right-click entry.
  They resolve to the panel's state afterwards, or `null` when no such
  panel is on screen (no composer or message open, or a phone), so you can
  fall back to a dialog. A panel opened this way gets a new `focusRequest`
  number in its props: focus your input when it changes. For
  `app-side-panel` see [The side panel in other views](#the-side-panel-in-other-views).
- **The api in a slot.** `const api = require('@plugin-host')` gives the
  same `api` as in the background frame.
- **Dialogs.** `api.ui.openDialog({ title, slot: 'plugin-dialog', extraProps, width, fill })`
  opens one of the plugin's own slots in a real dialog. The component gets
  `extraProps` plus `onResult`; `openDialog` resolves to the value passed to
  `onResult(value)`, or `null` when the user closes the dialog. With
  `fill: true` (1.20 and later; older versions ignore it) the dialog is as
  tall as the visible window allows (90 % of it, at most 640 px, and it
  follows a phone's keyboard) and the frame fills it, instead of growing
  with its content. Your root element is then as tall as the frame, as in
  a filled panel: for a chat whose input stays at the bottom.

  The host draws the title, the plugin's name under it, a close button and
  the footer. Declare the footer's buttons with `DialogButtons` (Cancel
  first, the main action last); a click calls your `onClick(id)`:

```js
import { createElement as h, useState } from 'react';
import { Stack, Field, Input, DialogButtons } from '@plugin-host/ui';

function ConfirmUpload({ fileName, onResult }) {
  const [name, setName] = useState(fileName);
  return h(Stack, { gap: 4 },
    h(Field, { label: 'File name' }, h(Input, { value: name, onChange: (e) => setName(e.target.value) })),
    h(DialogButtons, {
      buttons: [
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
        { id: 'upload', label: 'Upload', disabled: !name },
      ],
      onClick: (id) => onResult(id === 'upload' ? name : null),
    }));
}
export const slots = { 'plugin-dialog': { component: ConfirmUpload } };
// in a hook or an action:
const name = await api.ui.openDialog({ title: 'Upload', slot: 'plugin-dialog', extraProps: { fileName } });
```

### The side panel in other views

From 1.20 a plugin can show a side panel next to Calendar, Contacts, Files
and Settings: the `app-side-panel` slot, permission `ui:side-panel`. Mail
keeps `email-detail-sidebar` next to the open message. List the permission
in `optionalPermissions`, so older webmails, which don't know it, still
install the plugin.

```js
// manifest.json
"optionalPermissions": ["ui:side-panel"]

// index.js
export const slots = {
  'app-side-panel': { component: Panel, fill: true, startFolded: true, shouldShow },
};

await api.ui.openPanel('app-side-panel')    // true: open; false: no room here (see below); null: no such panel on screen
await api.ui.closePanel('app-side-panel')
await api.ui.togglePanel('app-side-panel')
```

- **Where.** A button at the end of each view's toolbar row shows and hides
  the panel, at the same place as the reader's panel button. In Calendar it
  comes after the view menu; in Files right after the details button (the
  two panels take turns: opening one folds the other); in Contacts on a row
  over the open contact; in Settings (1024 px and wider) on a row over the
  page. The Pro shell's panes have none.
- **Which plugins.** Only plugins whose `shouldShow` for the slot says yes,
  or that have none. `shouldShow` gets `{ view, context }`; until it
  answers, there is no button.
- **The button and the panel.** The button is named "Plugin panel" and has
  `aria-pressed`. A plugin keyboard shortcut with the id `toggle-panel` is
  named in its title and `aria-keyshortcuts`. The open panel is a
  `complementary` landmark named after its plugin. When it closes with the
  focus inside, the focus goes back to the button.
- **Size.** 200 to 500 px wide, 280 by default. The width and whether it is
  folded are the same in all four views (localStorage `appSidePanelWidth`
  and `appSidePanelCollapsed`). Dragging stops where the view keeps 480 px.
  When the view would get narrower than that, the panel folds, and opened
  anyway it lies over the view. `startFolded` holds until the user chooses.
  In Files, while the details panel is open the plugin panel steps aside
  there only.
- **Props.** `{ view, context, focusRequest }`. `view` is `'calendar'`,
  `'contacts'`, `'files'` or `'settings'`. `focusRequest` counts up when the
  panel opens on request (its button, a shortcut, `api.ui.openPanel`).
  `context` is what the view shows; each field reaches the plugin only with
  its permission, and fields not listed here never do:

  | Field | Permission | What |
  | --- | --- | --- |
  | `event` | `calendar:read` | `CalendarEventView`: the event open in the details or the editor |
  | `contact` | `contacts:read` | `ContactView`: the contact open in the details |
  | `selectedCount` | `contacts:read` | How many contacts are ticked in the list |
  | `files` | `files:read` | `FileResourceView[]`: the selected files, at most 20 |
  | `fileCount` | `files:read` | How many files are selected, also past those 20 |
  | `folder` | `files:read` | `{ id, path }` of the open folder (`id` is null in the top folder) |
  | `page` | none | `{ id, label }`: the open settings page, its name in the user's language |

- **Phones, and Settings below 1024 px.** There is no panel. The phone
  header shows a panel button instead (in Contacts also over an open
  contact), and a click sends the plugin `onAction({ surface: 'app-side-panel', actionId: 'open', context: { view, context } })`,
  with `context` cut to the plugin's permissions as above. Open your
  dialog there, for example
  `api.ui.openDialog({ slot: 'plugin-dialog', fill: true, extraProps: { view, context } })`.
  `openPanel` and `togglePanel` answer `false` there and send the same
  `onAction` to the plugin that asked; `closePanel` answers `false`.
- **Is it there?** `api.host.features.sidePanel` is `true` when this plugin
  may show the panel, `false` when the webmail has the panel but the plugin
  lacks `ui:side-panel` (it was enabled before an update added the
  permission: the user turns it off and on), and missing on older webmails.
  There `openPanel('app-side-panel')` throws "is not a panel".

### The app's controls: `@plugin-host/ui`

Draw your UI with the app's own components, so it looks like the rest of
Bulwark in every theme. The sandbox provides them like React, so they add
nothing to your bundle and always match the app version they run in:

```js
import { Stack, Field, Input, Select, Checkbox, DialogButtons } from '@plugin-host/ui';
```

The build script (`scripts/build.mjs`) keeps the module external; unit tests
get a stand-in (`test-utils/ui-kit.mjs`) with the same roles and labels.
The frame only has styles for these components, not the app's whole
stylesheet, so lay out with `Stack` and `Row` instead of class names.

| component | what it is in the app |
|---|---|
| `Button` | the app's button: `variant` primary, secondary, ghost or destructive; `size` sm, md or icon; `icon`, `busy` |
| `LinkButton`, `Link` | an inline text link ("Add condition"); an external link |
| `Input`, `Textarea`, `SearchInput` | the app's text fields; the Files toolbar's search box |
| `Select` | the settings select; `options`, `onChange(value)`, `block` for full width in forms |
| `Checkbox`, `Switch`, `Segmented` | the composer's check items, the settings toggle and choice row |
| `Field` | label above a control, `hint` and `error` below |
| `Stack`, `Row`, `Text`, `Heading`, `Divider` | layout and text in the app's sizes and colours; `Row fill` puts fields side by side |
| `Page`, `PageHeader` | an app page's width and padding, title, description and actions |
| `Section`, `SettingRow`, `Card` | a settings group and row; the admin pages' bordered card |
| `Tabs` | the tab bar of the app's dialogs |
| `Toolbar`, `ToolbarButton`, `ToolbarSpacer`, `Breadcrumbs` | the Files app's toolbar |
| `List`, `ListRow`, `RowAction`, `FileIcon` | the Files app's list: 40 px rows, its file icons, size and date columns |
| `Badge`, `Chip` | status pills; the reader's attachment chips |
| `InfoBar`, `BarButton` | the reader's info bars (external content, invitations) and their buttons; `compact` for one line |
| `Alert`, `ProgressBar`, `Spinner`, `Loading`, `EmptyState` | messages, progress, loading and empty states |
| `SidebarRow`, `SidebarEmpty` | rows and the "nothing here" line of a sidebar section |
| `DiffView` | a text with removed and added words marked, for previews |
| `Panel`, `DetailHeading`, `DetailList`, `DetailRow` | the padding of side panels; the message details' small caps headings and label/value rows |
| `Table` | a data table: `columns` (`key`, `label`, `align: 'end'` for amounts, `hideNarrow`, `width`), `rows` keyed by column, `summary` rows under the last column for totals (`strong` for the one that matters); Bulwark 1.19.1 and later |
| `ColorDot` | a dot in a colour the data carries (a calendar's colour); `#rgb` or `#rrggbb` only |
| `Icon` | an app icon by name (the names `setActions` takes) |
| `DialogButtons` | the buttons of a plugin dialog, drawn by the host in the dialog's footer |

A few rules make a plugin look like it belongs:

- Don't wrap content in a box of your own where the host already gives it
  one: dialogs, pages and sidebar sections come with their surface and
  padding.
- Buttons and menu entries that sit in the app's toolbars and menus are
  actions (`api.ui.setActions`), not buttons in a frame.
- No hard-coded colours: the components take theirs from the theme, in
  light, dark and custom themes.
- Information about the open message goes in the `email-banner` slot as an
  `InfoBar`, where it lines up with the app's own info bars.

### Actions

```js
await api.ui.setActions('message-row-actions', [
  { id: 'to-task', label: 'Make a task', icon: 'checklist', mailboxRoles: ['inbox'] },
]);
await api.ui.setActions('attachment-menu', [
  { id: 'save', label: 'Save to the archive', icon: 'archive', mimeTypes: ['application/pdf', 'image/'] },
]);

export const hooks = {
  onAction({ surface, actionId, context }) {
    // context holds the keys listed for the surface, e.g. { emailId }
  },
};
```

Each call replaces what the plugin set on that surface before; `[]` removes
its buttons. At most 8 actions per surface. An action has:

- `id`: 1 to 40 letters, digits, `-`, `_` or `.`, unique on the surface;
- `label`: 1 to 60 characters;
- `icon` (optional): a [Tabler icon](https://tabler.io/icons) name such as
  `bolt`, `file-text` or `cloud-upload`; an unknown name shows no icon;
- `order` (optional): lower comes first, default 100;
- `mailboxRoles` (optional): show the action only in folders with these
  roles, such as `inbox` or `sent` (message surfaces);
- `mimeTypes` (optional): show it only for attachments or files of these
  types; `image/` or `image/*` matches all images;
- `accounts` (optional, message surfaces): show the action only on messages
  in these kinds of mail account: `personal` (the user's own), `group` (a
  team mailbox, a Stalwart group account the user is a member of) or
  `shared` (a mailbox another person shared). On `message-bulk-actions` the
  open folder's account counts. Surfaces that aren't about messages never
  show such an action;
- `hasKeyword` / `notKeyword` (optional, `message-row-actions` and
  `reader-actions`): show the action only when the message has, or lacks,
  this keyword. A trailing `*` matches any keyword that starts with the
  rest (`"$assigned:*"`). Case doesn't matter;
- `danger` (optional): draw it in red;
- `checked` (optional, the composer's Options and Send menus): draw the entry
  as a check item, ticked or not, like the menu's own options; it stays open
  on click, and ticked entries count in the Options badge. Call `setActions`
  again with the new value after a click;
- `description` (optional, menus): a second line under the label, up to 120
  characters;
- `shortcut` (optional, `composer-toolbar-actions` only): a key combination
  such as `Alt+A` that runs the action while the composer has focus. It needs
  Alt, Ctrl/Cmd+Shift or Ctrl/Cmd+Alt, shows in the button's tooltip and is
  listed in the keyboard help.

A click on `message-row-actions` or `reader-actions` carries `emailId` and,
for a message in a team or shared mailbox, `accountId`, the JMAP account
the message is in. Pass it on to `api.email.get` and
`api.email.updateKeywords`; without it they work on the user's own account.

```js
await api.ui.setActions('reader-actions', [
  { id: 'done', label: 'Mark done', icon: 'circle-check', accounts: ['group'], notKeyword: '$done' },
  { id: 'reopen', label: 'Reopen', icon: 'arrow-back-up', accounts: ['group'], hasKeyword: '$done' },
]);
// onAction({ actionId: 'done', context: { emailId: 'm1', accountId: 'ch' } })
await api.email.updateKeywords(context.emailId, { $done: true }, context.accountId);
```

`accounts`, `hasKeyword` and `notKeyword` are new in Bulwark 1.19; older
versions ignore them and show the action everywhere, so set
`minAppVersion` to `1.19.0` when you rely on them.

Clicks on the composer's surfaces (its toolbar, Options, Attach and Send
menus) carry `composerId`, which the [`api.composer`](#apicomposer) methods
take, so a plugin works on the message the user clicked in.

Two surfaces are right-click menus on selected text: `composer-selection-menu`
in the message being written and `reader-selection-menu` in an open
message. The browser's own menu stays until a plugin adds entries; the host
then draws Cut/Copy and the plugin's entries, and the click carries the
selected text as `selection: { text }` (with `composerId` or `emailId`).
The composer's panels and frames, and the reader's side panel, also get the
selection as it changes, as a `selection` prop, so a panel can follow what
the user highlights.

The surface's permission is checked on every call, and the click context is
cut down to what the plugin may see.

### Day labels

```js
await api.ui.setDayLabels([
  { date: '2026-12-24', text: 'Christmas Eve', title: 'Public holiday', dot: true },
  { date: '2026-12-31', dot: true },
]);
```

At most 400 labels; each needs `date` (`YYYY-MM-DD`) and `text` (at most 24
characters) or `dot`, and may have a `title` tooltip (at most 120). The text
shows under the day's name in the day and week views and in the month
view's day cells; the dot shows in the small month calendar. Each call
replaces the plugin's earlier labels.

### Pages

```js
await api.ui.setPages([{ id: 'documents', title: 'Documents', icon: 'file-text' }]);
export const slots = { 'app-page': { component: ({ pageId, path }) => h(Documents, { pageId, path }) } };
```

At most 3 pages, ids of lowercase letters, digits and hyphens (up to 32),
titles up to 40 characters. Each page gets a button in the navigation rail
(the bottom bar on phones) and the route `/apps/<plugin id>/<page id>`, where
the `app-page` slot fills the content area.

### Badges on message rows

The `onEmailListItemRender` hook returns badges for a row:
`[{ key, label, color, title, icon }]`, at most 3 per row, labels up to 32
characters. `icon` (Bulwark 1.19 and later) is a Tabler icon name drawn
before the label, such as `check` or `user`, by the same rule as an
action's icon (letters, digits and `-`, up to 40). The host caches the badges per
message and keyword state, so call `api.ui.refreshRowBadges()` (at most
once a second) when your answer changes for another reason.

```js
export const hooks = {
  onEmailListItemRender(badges, { email }) {
    if (!email.keywords.includes('$done')) return undefined;
    return [...badges, { key: 'done', label: 'Done', icon: 'check', color: 'var(--color-success)' }];
  },
};
```

### List filters

```js
await api.ui.setListFilters([
  { id: 'mine', label: 'Assigned to me', icon: 'user', hasKeyword: '$assigned:cj', accounts: ['group'] },
  { id: 'open', label: 'Open', notKeyword: '$done', accounts: ['group'] },
]);
```

Keyword filters for the message list (permission `ui:message-list`,
Bulwark 1.19 and later). The host draws each as a chip in the list header
of the folders it applies to. A chip the user turns on adds its condition to
the folder's query, together with the folder, an inbox tab and the other
chips that are on; the chip then shows a cross and turns off again with one
click. Which chips are on lasts until the page is reloaded, across folders;
a chip that doesn't apply to a folder is neither shown nor applied there.
When a message changes a keyword an active filter tests (through the app or
`api.email.updateKeywords`), the list loads again, so a message marked done
leaves an "Open" list.

At most 4 filters per plugin, and each call replaces the plugin's earlier
ones (`[]` removes them). A filter has:

- `id`: 1 to 40 letters, digits, `-`, `_` or `.`;
- `label`: 1 to 40 characters;
- `hasKeyword` and/or `notKeyword`: the keyword messages must have or lack
  (at least one of the two);
- `icon` (optional): a Tabler icon name;
- `accounts` (optional): `personal`, `group` and/or `shared`, as for
  actions;
- `mailboxRoles` (optional): only in folders with these roles;
- `order` (optional): lower comes first, default 100.

Filters apply to a folder's own list, not to searches, tag views or the
merged views of several accounts.

### Surface reference

<!-- generated:surfaces -->
<!-- Generated by scripts/gen-docs.mjs; edit the webmail catalogues, not this table. -->

57 surfaces. A plugin may use a surface with any one of the listed permissions; a prop or context key with a permission in brackets is only passed when the plugin holds that permission too.

#### App

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `app-top-banner` | frame | `ui:app-top-banner` | `username` (`account:read`), `serverUrl` (`account:read`), `impersonated` (`account:read`) | a banner across the top of every page; `impersonated` is true when an admin opened the mailbox through an impersonation handoff |
| `command-palette` | action | `ui:commands` |  | entries in the command palette (Ctrl+K) |
| `app-side-panel` | frame | `ui:side-panel` | `view`, `context`, `focusRequest` | a side panel next to Calendar, Contacts, Files and Settings (desktop and tablet; phones and Settings below 1024 px have none: the toggle there asks the plugin for a dialog through onAction, surface `app-side-panel`, actionId `open`, context { view, context }); `view` names the view ("calendar" \| "contacts" \| "files" \| "settings"); `context` is what it shows: { event } (calendar:read), { contact, selectedCount } (contacts:read), { files, fileCount, folder } (files:read), { page: { id, label } }; `focusRequest` counts up when the panel opens on request |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/command-palette-dark.png"><img src="docs/screenshots/command-palette-light.png" alt="command-palette: two entries, typed &quot;showcase&quot;" width="640"></picture>
<img src="docs/screenshots/command-palette-phone.png" alt="The same on a phone" width="195">
<br><em>command-palette: two entries, typed "showcase"</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/notifications-dark.png"><img src="docs/screenshots/notifications-light.png" alt="A notification from api.notifications.show in the notifications panel" width="640"></picture>
<img src="docs/screenshots/notifications-phone.png" alt="The same on a phone" width="195">
<br><em>A notification from api.notifications.show in the notifications panel</em>
</p>

#### Dialogs

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `plugin-dialog` | frame | `ui:observe` | whatever the plugin passed as `extraProps`, plus `onResult` | inside a dialog the plugin opened with api.ui.openDialog (with `anchor: 'trigger'` a popover beside what the user clicked) |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/dialog-dark.png"><img src="docs/screenshots/dialog-light.png" alt="plugin-dialog opened with api.ui.openDialog" width="640"></picture>
<img src="docs/screenshots/dialog-phone.png" alt="The same on a phone" width="195">
<br><em>plugin-dialog opened with api.ui.openDialog</em>
</p>

#### Navigation

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `navigation-rail-bottom` | frame | `ui:navigation-rail` |  | the bottom of the navigation rail |
| `sidebar-widget` | frame | `ui:sidebar-widget` |  | a widget at the bottom of the mail sidebar |
| `sidebar-section` | frame | `ui:sidebar-widget` | `mailboxId` | a collapsible section in the mail sidebar, below the folders |
| `side-panel` | frame | `ui:sidebar-widget` | `focusRequest` | a panel beside the mail (list and reader), opened from its button in the rail at the right edge (Mountain View's side panel; in the default layout a rail of its own, desktop only); the button's title and icon from api.ui.setSidePanel, else the plugin's name, no button with its `rail: false` (then opened by api.ui.openPanel / togglePanel only); the open panel is remembered in this browser; `slots['side-panel'].fill = true` makes the frame as tall as the panel; `focusRequest` counts up when the plugin opened it with api.ui.openPanel('side-panel') |
| `sidebar-section-actions` | frame, inline | `ui:sidebar-widget` |  | compact controls beside a collapsible plugin sidebar-section heading |
| `top-bar-actions` | action, inline | `ui:toolbar` |  | buttons in the top bar, next to search |
| `app-page` | frame | `ui:app-page` | `pageId`, `path` | a full page of its own, with an entry in the navigation rail (api.ui.setPages); api.ui.openPage moves the tab there |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/navigation-dark.png"><img src="docs/screenshots/navigation-light.png" alt="app-top-banner, navigation-rail-bottom (&quot;slot: rail&quot;), sidebar-section, sidebar-widget, top-bar-actions (flask icon next to Refresh), the page entry in the rail" width="640"></picture>
<img src="docs/screenshots/navigation-phone.png" alt="The same on a phone" width="195">
<br><em>app-top-banner, navigation-rail-bottom ("slot: rail"), sidebar-section, sidebar-widget, top-bar-actions (flask icon next to Refresh), the page entry in the rail</em>
</p>

<p>
<img src="docs/screenshots/navigation-sidebar-phone.png" alt="sidebar-section and sidebar-widget in the phone menu" width="195">
<br><em>sidebar-section and sidebar-widget in the phone menu</em>
</p>

<p>
<img src="docs/screenshots/navigation-top-bar-phone.png" alt="top-bar-actions in the phone top bar menu" width="195">
<br><em>top-bar-actions in the phone top bar menu</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/app-page-dark.png"><img src="docs/screenshots/app-page-light.png" alt="app-page, the page registered with api.ui.setPages" width="640"></picture>
<img src="docs/screenshots/app-page-phone.png" alt="The same on a phone" width="195">
<br><em>app-page, the page registered with api.ui.setPages</em>
</p>

#### Message list

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `message-list-header` | frame | `ui:message-list` | `mailboxId`, `mailboxRole` | above the message list |
| `message-list-empty` | frame | `ui:message-list` | `mailboxId`, `mailboxRole`, `searching` | in an empty message list, below the "no messages" text |
| `message-row-actions` | action, inline | `ui:message-list` | `emailId` (`email:read`), `accountId` (`email:read`) | hover buttons on a message row, and its right-click menu (the row menu on phones); the click's `accountId` names the message's account when it is not the user's own (a team or shared mailbox) |
| `message-bulk-actions` | action, inline | `ui:message-list` | `emailIds` (`email:read`) | buttons in the toolbar shown while messages are selected |
| `context-menu-email` | frame | `ui:context-menu` |  | the right-click menu of a message |
| `toolbar-actions` | frame, inline | `ui:toolbar` |  | the message toolbar |
| `search-results` | data | `email:read` | `query` (`email:read`) | entries a plugin returns from onProvideSearchResults, in a block above a search's message list; a click opens the message an entry names, any other reaches the plugin as onAction with the entry's key as actionId |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/message-list-dark.png"><img src="docs/screenshots/message-list-light.png" alt="message-list-header and message-row-actions (hover)" width="640"></picture>
<img src="docs/screenshots/message-list-phone.png" alt="The same on a phone" width="195">
<br><em>message-list-header and message-row-actions (hover)</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/message-list-context-menu-dark.png"><img src="docs/screenshots/message-list-context-menu-light.png" alt="context-menu-email and the row action in the right-click menu" width="640"></picture>
<img src="docs/screenshots/message-list-context-menu-phone.png" alt="The same on a phone" width="195">
<br><em>context-menu-email and the row action in the right-click menu</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/message-list-bulk-dark.png"><img src="docs/screenshots/message-list-bulk-light.png" alt="message-bulk-actions in the selection toolbar" width="640"></picture>
<img src="docs/screenshots/message-list-bulk-phone.png" alt="The same on a phone" width="195">
<br><em>message-bulk-actions in the selection toolbar</em>
</p>

#### Reader

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `reader-header` | frame | `ui:email-banner` | `email` (`email:read`) | at the top of the open message, above the subject |
| `reader-below-subject` | frame | `ui:email-banner` | `email` (`email:read`) | right under the subject and sender of the open message |
| `email-banner` | frame | `ui:email-banner` | `email` (`email:read`), `deviceType` | a banner above the message body; `deviceType` ("mobile" \| "tablet" \| "desktop") says whether the reader has a side panel (not on phones) |
| `reader-above-quote` | frame | `ui:email-banner` | `email` (`email:read`) | between the new text of a message and the quoted text below it |
| `email-footer` | frame | `ui:email-footer` | `emailId` (`email:read`) | below the message body |
| `thread-summary` | frame | `ui:email-banner` | `threadId` (`email:read`), `emailIds` (`email:read`), `deviceType` | above the messages of an open conversation (the phone conversation view and Mountain View; the default desktop layout opens one message at a time and has no conversation view) |
| `reader-actions` | action, inline | `ui:toolbar` | `emailId` (`email:read`), `accountId` (`email:read`) | buttons in the open message's toolbar (its More menu on phones); `accountId` as on message-row-actions |
| `email-detail-sidebar` | frame | `ui:email-details` | `email` (`email:read`), `selection` (`email:read`), `listSelection` (`email:read`), `focusRequest` | a side panel next to the open message; `selection` is the text selected in the message as the user changes it ({ text }); `listSelection` names the messages ticked in the list when two or more are ({ emails: [{ id, accountId }], total }, at most 50, else null); `focusRequest` counts up when the plugin opened the panel with api.ui.openPanel |
| `email-details-section` | frame | `ui:email-details` | `email` (`email:read`), `category` | a section in the message details |
| `attachment-actions` | frame, inline | `email:read` | `attachment` | buttons on each attachment |
| `reader-selection-menu` | action | `ui:context-menu` or `ui:toolbar` | `emailId` (`email:read`), `selection` (`email:read`) | entries in the right-click menu on selected text in a message (without plugin entries the browser's own menu stays); the click's selection is { text } |
| `attachment-menu` | action | `email:read` | `emailId` (`email:read`), `blobId` (`email:read`), `name` (`email:read`), `type` (`email:read`), `size` (`email:read`) | entries in each attachment's menu (for example "Save to Nextcloud") |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/reader-dark.png"><img src="docs/screenshots/reader-light.png" alt="toolbar-actions, reader-actions, reader-header, reader-below-subject, email-banner, reader-above-quote, email-footer, email-detail-sidebar" width="640"></picture>
<img src="docs/screenshots/reader-phone.png" alt="The same on a phone" width="195">
<br><em>toolbar-actions, reader-actions, reader-header, reader-below-subject, email-banner, reader-above-quote, email-footer, email-detail-sidebar</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/reader-attachment-menu-dark.png"><img src="docs/screenshots/reader-attachment-menu-light.png" alt="attachment-actions and attachment-menu" width="640"></picture>
<img src="docs/screenshots/reader-attachment-menu-phone.png" alt="The same on a phone" width="195">
<br><em>attachment-actions and attachment-menu</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/reader-details-dark.png"><img src="docs/screenshots/reader-details-light.png" alt="email-details-section in the message details" width="640"></picture>
<br><em>email-details-section in the message details</em>
</p>

<p>
<img src="docs/screenshots/reader-actions-phone.png" alt="reader-actions in the phone &quot;More actions&quot; panel" width="195">
<br><em>reader-actions in the phone "More actions" panel</em>
</p>

<p>
<img src="docs/screenshots/reader-thread-phone.png" alt="thread-summary and reader-above-quote in a conversation on a phone" width="195">
<br><em>thread-summary and reader-above-quote in a conversation on a phone</em>
</p>

#### Composer

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `composer-toolbar` | frame, inline | `ui:composer-toolbar` | `insertText` (`compose:open`), `getSelectedText` (`email:send`), `composerId` | the composer's plugin row above its bottom bar, for controls that need their own UI (a button belongs in composer-toolbar-actions) |
| `composer-above-body` | frame | `ui:composer-toolbar` or `ui:composer-sidebar` | `draft` (`email:send`), `selection` (`compose:read`), `insertText` (`compose:open`), `getSelectedText` (`email:send`), `composerId` | between the subject and the message text |
| `composer-below-body` | frame | `ui:composer-toolbar` or `ui:composer-sidebar` | `draft` (`email:send`), `selection` (`compose:read`), `insertText` (`compose:open`), `getSelectedText` (`email:send`), `composerId` | below the message text, above the attachments |
| `composer-sidebar` | frame | `ui:composer-sidebar` | `draft` (`email:send`), `selection` (`compose:read`), `composerId`, `focusRequest` | a panel left of the composer; `selection` is the selected text of the message as the user changes it ({ text, empty }); `focusRequest` counts up when the plugin opened the panel with api.ui.openPanel |
| `composer-sidebar-right` | frame | `ui:composer-sidebar` | `draft` (`email:send`), `selection` (`compose:read`), `composerId`, `focusRequest` | a panel right of the composer, with the same props as composer-sidebar |
| `composer-attachment-source` | frame, inline | `ui:composer-toolbar` or `ui:composer-sidebar` | `onAttach`, `insertText` (`compose:open`), `composerId` | the composer's plugin row, next to composer-toolbar, as a source of files (older plugins; an entry in the Attach menu, composer-attach-menu, with api.composer.attach looks like the app's own) |
| `composer-send-menu` | action | `ui:composer-toolbar` | `draft` (`email:send`), `composerId` | entries in the menu next to Send |
| `composer-attach-menu` | action | `ui:composer-toolbar` | `composerId` | entries in the Attach menu (for example "From Nextcloud"); the click's composerId lets api.composer.attach add files |
| `composer-options-menu` | action | `ui:composer-toolbar` | `composerId` | entries in the composer's Options menu |
| `composer-toolbar-actions` | action, inline | `ui:composer-toolbar` | `composerId` | buttons in the composer's bottom bar, after Attach, Templates and Options; an action's shortcut works while the composer has focus |
| `composer-selection-menu` | action | `ui:composer-toolbar` | `composerId`, `selection` (`compose:read`) | entries in the right-click menu on selected text in the message (without plugin entries the browser's own menu stays); the click's selection is { text } |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/composer-dark.png"><img src="docs/screenshots/composer-light.png" alt="composer-above-body, composer-below-body, composer-toolbar, composer-attachment-source (side panels hidden, see the next picture)" width="640"></picture>
<img src="docs/screenshots/composer-phone.png" alt="The same on a phone" width="195">
<br><em>composer-above-body, composer-below-body, composer-toolbar, composer-attachment-source (side panels hidden, see the next picture)</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/composer-sidebars-dark.png"><img src="docs/screenshots/composer-sidebars-light.png" alt="composer-sidebar and composer-sidebar-right" width="640"></picture>
<br><em>composer-sidebar and composer-sidebar-right</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/composer-send-menu-dark.png"><img src="docs/screenshots/composer-send-menu-light.png" alt="composer-send-menu" width="640"></picture>
<img src="docs/screenshots/composer-send-menu-phone.png" alt="The same on a phone" width="195">
<br><em>composer-send-menu</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/composer-attach-menu-dark.png"><img src="docs/screenshots/composer-attach-menu-light.png" alt="composer-attach-menu" width="640"></picture>
<img src="docs/screenshots/composer-attach-menu-phone.png" alt="The same on a phone" width="195">
<br><em>composer-attach-menu</em>
</p>

#### Calendar

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `calendar-event-actions` | frame, inline | `ui:calendar-action` | `eventData` (`calendar:read`), `setVirtualLocation` | buttons in the event form |
| `calendar-event-detail` | frame | `ui:calendar-action` | `event` (`calendar:read`) | a section in an event's details |
| `calendar-event-form` | frame | `ui:calendar-action` | `event` (`calendar:read`) | a section in the form for a new or edited event |
| `calendar-day-header` | data | `ui:calendar-action` | `date` | a short label under a day's name in the day, week and month views; a dot in the phone month view (api.ui.setDayLabels) |
| `mini-calendar-marks` | data | `ui:calendar-action` | `date` | dots on days in the small month calendar (api.ui.setDayLabels) |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/calendar-dark.png"><img src="docs/screenshots/calendar-light.png" alt="calendar-day-header labels and mini-calendar-marks dots from api.ui.setDayLabels" width="640"></picture>
<img src="docs/screenshots/calendar-phone.png" alt="The same on a phone" width="195">
<br><em>calendar-day-header labels and mini-calendar-marks dots from api.ui.setDayLabels</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/calendar-event-dark.png"><img src="docs/screenshots/calendar-event-light.png" alt="calendar-event-detail" width="640"></picture>
<img src="docs/screenshots/calendar-event-phone.png" alt="The same on a phone" width="195">
<br><em>calendar-event-detail</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/calendar-event-form-dark.png"><img src="docs/screenshots/calendar-event-form-light.png" alt="calendar-event-actions and calendar-event-form" width="640"></picture>
<img src="docs/screenshots/calendar-event-form-phone.png" alt="The same on a phone" width="195">
<br><em>calendar-event-actions and calendar-event-form</em>
</p>

#### Contacts

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `contact-cryptokeys` | frame | `ui:contact-cryptokeys` | `cryptoKeys` (`contacts:read`) | the encryption keys section of a contact |
| `contact-detail-section` | frame | `ui:contacts` | `contact` (`contacts:read`) | a section in a contact's details |
| `contact-list-actions` | action, inline | `ui:contacts` | `contactIds` (`contacts:read`) | buttons in the contact list toolbar |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/contacts-dark.png"><img src="docs/screenshots/contacts-light.png" alt="contact-list-actions, contact-cryptokeys, contact-detail-section" width="640"></picture>
<img src="docs/screenshots/contacts-phone.png" alt="The same on a phone" width="195">
<br><em>contact-list-actions, contact-cryptokeys, contact-detail-section</em>
</p>

#### Tasks

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `task-detail-section` | frame | `ui:tasks` | `task` (`tasks:read`) | a section in a task's details |
| `task-list-actions` | action, inline | `ui:tasks` | `taskIds` (`tasks:read`) | buttons in the task list toolbar |
| `calendar-task-view` | frame | `ui:tasks` | `filter`, `calendarIds` (`tasks:read`) | the calendar's task view (Calendar › Tasks) below its toolbar, in place of Bulwark's task list; the toolbar (filter, new task, task-list-actions) stays; one plugin at a time, the first offering it; `filter` is the toolbar's filter ("all" \| "pending" \| "completed" \| "overdue"), `calendarIds` the calendars ticked in the sidebar; `slots['calendar-task-view'].fill = true` makes the frame as tall as the area below the toolbar, so the plugin scrolls inside it; api.ui.openCalendar({ view: 'tasks' }) opens the view |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/tasks-dark.png"><img src="docs/screenshots/tasks-light.png" alt="task-list-actions and task-detail-section" width="640"></picture>
<img src="docs/screenshots/tasks-phone.png" alt="The same on a phone" width="195">
<br><em>task-list-actions and task-detail-section</em>
</p>

#### Files

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `file-actions` | action | `ui:files` | `files` (`files:read`) | entries in a file's menu and the selection toolbar |
| `file-preview-section` | frame | `ui:files` | `file` (`files:read`) | a section in the file preview |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/files-dark.png"><img src="docs/screenshots/files-light.png" alt="file-actions in the selection toolbar and file-preview-section in the details panel" width="640"></picture>
<img src="docs/screenshots/files-phone.png" alt="The same on a phone" width="195">
<br><em>file-actions in the selection toolbar and file-preview-section in the details panel</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/files-menu-dark.png"><img src="docs/screenshots/files-menu-light.png" alt="file-actions in a file's menu" width="640"></picture>
<img src="docs/screenshots/files-menu-phone.png" alt="The same on a phone" width="195">
<br><em>file-actions in a file's menu</em>
</p>

#### Settings

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `settings-section` | frame | `ui:settings-section` |  | a section on the plugin's own page in Settings (above its settings-page, when it has one: one entry per plugin) |
| `settings-page` | frame | `ui:settings-section` |  | a page of its own in Settings, listed under the plugin's name |

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/settings-dark.png"><img src="docs/screenshots/settings-light.png" alt="settings-section, listed under Apps" width="640"></picture>
<img src="docs/screenshots/settings-phone.png" alt="The same on a phone" width="195">
<br><em>settings-section, listed under Apps</em>
</p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/settings-page-dark.png"><img src="docs/screenshots/settings-page-light.png" alt="settings-page, listed under Plugins" width="640"></picture>
<img src="docs/screenshots/settings-page-phone.png" alt="The same on a phone" width="195">
<br><em>settings-page, listed under Plugins</em>
</p>

#### Admin dashboard

| Surface | Kind | Permission | Props or context | Where |
|---|---|---|---|---|
| `admin-plugin-page` | frame | `ui:admin-page` or `admin:config` |  | the plugin's page in the admin dashboard |

<!-- /generated:surfaces -->

## API reference

`api` is the argument of `activate` and the value of `require('@plugin-host')`.
The permission each method needs is in the [table at the end](#method-permissions).

### api.plugin, api.log, api.i18n

```js
api.plugin.id                       // "my-plugin"
api.plugin.version                  // "1.0.0"
api.plugin.settings                 // the user's settings, defaults filled in, updated in place
api.plugin.onSettingsChange(fn)     // fn(settings); returns an unsubscribe function

api.log.debug(...) / info / warn / error   // console, prefixed with the plugin id

api.i18n.locale                     // "de"
api.i18n.getLocale()
api.i18n.t(key, vars?)              // translated text, or the key itself
api.i18n.has(key)
api.i18n.addTranslations(locale, { key: 'text' })
api.i18n.onLocaleChange(fn)         // fn(locale); returns an unsubscribe function
```

### api.host

Features of Bulwark itself that replace what a plugin did. A plugin that
does the same job should do nothing while one is on, so users aren't warned
or asked twice. No permission is needed, and the object is the same in the
background and in slot frames.

```js
api.host.features.externalSenderLabel       // true while the admin's "External" label on mail
                                             // from outside the organisation is on for this user
api.host.features.externalRecipientWarning  // true while the confirm before sending outside
                                             // the organisation is on for this user
api.host.features.noThirdPartyTraffic       // 1.20 and later: true while "No third-party traffic"
                                             // is on (or not known yet)
api.host.onFeaturesChange(fn)               // fn(features); returns an unsubscribe function
```

From 1.20 `api.host.features` also says which newer host calls and props
the webmail offers, so a plugin can hide what isn't there:

| Flag | What the webmail offers |
| --- | --- |
| `attachmentText` | `api.email.getAttachmentText` |
| `attachmentImages` | `api.email.getAttachmentImage` |
| `threads` | `api.email.getThread` and `api.email.getThreadCount` |
| `listSelection` | The `listSelection` prop of `email-detail-sidebar` |
| `sidePanel` | The `app-side-panel` slot, per plugin: `true` when this plugin may show it, `false` when it lacks `ui:side-panel` (see [The side panel in other views](#the-side-panel-in-other-views)) |
| `answerInvitation` | `api.calendar.respond`, per plugin: `true` only once the plugin holds `calendar:respond` |
| `filterRules` | `api.filters.list`, `create` and `undo`: the mail server has filters (Sieve) |
| `batchMail` | `api.email.batch` and `api.email.undoBatch` |
| `changeSettings` | `api.app.describeSettings`, `setSettings` and `undoSettings`, per plugin: `true` only once the plugin holds `settings:change` |
| `files` | `api.files`: the server has Files for the signed-in account and the admin left Files on (see [api.files](#apifiles)) |
| `keystore` | `api.keystore`, per plugin, in the desktop app: the privileged tier, the `keystore` permission and a shell with the native helper. Absent rather than `false` when off (see [api.keystore](#apikeystore)) |
| `blockExternalContent` | `onRenderEmailBody` may return `blockExternalContent: true`, per plugin with `email:render-takeover`. External content stays off for that body whatever the settings and trusted senders allow, and the reader offers no way to load it, so say why in your own banner. Absent on webmails that ignore the field |

Read each as `=== true` (older webmails don't send them) and check
`typeof api.email.getThread === 'function'` before calling a method.
The flags say what the webmail can do; the method's permission is still
checked on every call. A per-plugin flag stays `false` for a plugin that
was turned on before an update added the permission, until the user turns
it off and on.


`api.host.features` is updated in place, like `api.plugin.settings`, so
`shouldShow` and hooks can read it directly; slot components render again
when it changes. It changes when the admin's policy changes or the user
switches to an account in another domain or group.

The two flags follow the admin's Organisation > Security > External mail
switches (policy.json `organisation.externalMail.senderLabel` and
`recipientWarning`), one each, so a plugin steps back only from the part
Bulwark does. For the retired `external-mail-warning` plugin Bulwark also
skips the handlers itself: `onBeforeEmailSend` while
`externalRecipientWarning` is true, `onNewEmailReceived` and the
`email-banner` slot while `externalSenderLabel` is true.

With `noThirdPartyTraffic` on, the credential proxy reaches only servers the
admin entered on the plugin's admin page (credentials with `originKey`) and
refuses servers fixed in the manifest. A plugin whose only network access is
`http:proxy` with admin credentials, at least one of them with `originKey`,
keeps running in the mode; every other plugin that declares network access
doesn't start. Turn the fixed services off while the flag is on instead of
treating their refusals as errors.

`api.host` is new in Bulwark 1.19. Older versions don't have it, so read a
flag as `api.host?.features?.externalRecipientWarning === true`.

### api.storage

```js
await api.storage.get(key)          // the value, or null
await api.storage.set(key, value)   // any JSON value
await api.storage.remove(key)
await api.storage.keys()
```

Kept in the webmail's `localStorage`, separately for each signed-in account,
and shared by all frames of the plugin. Keys are 1 to 256 characters. A
plugin may keep at most 1 MB per account; `set` rejects past that.

### api.toast, api.notifications

```js
api.toast.success(text) / info / warning / error    // no await needed
await api.notifications.show({ title, body, tag, action })  // 'system' or 'toast'
```

Toasts are cut at 300 characters; past 5 toasts in 10 seconds they are
dropped. `notifications.show` shows a system notification when the user
allowed them, otherwise a toast, and lists it in the notifications panel;
either way it names the plugin. Title up to 120 characters, body up to 300,
one line each; `tag` is 1 to 64 letters, digits or `. _ : -` and replaces an
earlier notification with the same tag. At most 5 a minute. A click calls
the plugin's `onNotificationClick({ tag })` hook.

`action: { label, url }` adds a link: a button on the toast and a link under
the entry in the notifications panel, opened in a new tab. The URL must be
http(s) and on a server the plugin already talks to, one of its
`httpOrigins` or the server of one of its proxy credentials; anything else is
refused. Labels are up to 40 characters.

### api.ui

```js
await api.ui.confirm({ title, message, confirmLabel, cancelLabel, danger })   // true or false
await api.ui.alert({ title, message, confirmLabel })
await api.ui.prompt({ title, message, confirmLabel, cancelLabel,
  fields: [{ name, label, type: 'text' | 'password', placeholder, required }] })  // { name: value } or null
await api.ui.openDialog({ title, slot, extraProps, width, fill })   // the value given to onResult, or null
await api.ui.openExternalUrl(url)       // http(s) only, always a new tab
await api.ui.print({ title, html })     // the browser's print dialog for a page the plugin made
await api.ui.downloadFile({ content, filename, contentType })
await api.ui.setActions(surface, actions)
await api.ui.setDayLabels(labels)
await api.ui.setPages(pages)
await api.ui.setSectionTitle(title)     // the header of the plugin's sidebar-section; null for its name
await api.ui.openPanel(slot, { composerId })   // composer-sidebar(-right), email-detail-sidebar or app-side-panel: true, false or null (no panel on screen)
await api.ui.closePanel(slot, { composerId })
await api.ui.togglePanel(slot, { composerId })
await api.ui.refreshRowBadges()
await api.ui.setListFilters(filters)    // keyword filter chips in the list header, see "List filters"
await api.ui.rerenderEmail()            // run onRenderEmailBody again for the open message
await api.ui.rerenderFetchedEmails()    // run onEmailsFetched again for the list
```

`print` (Bulwark 1.19.1 and later) prints `html` from a hidden frame of the
host's: sanitised like a message body (a `<style>` element is kept, scripts,
forms and frames are not), under the reader's strict CSP, so the page loads
nothing; images have to be `data:` URLs. The user can save a PDF from the
print dialog. Three times a minute; it waits until the dialog closes.

The host draws `confirm`, `alert` and `prompt` dialogs itself and names the
plugin in them. `downloadFile` takes text or bytes the plugin made, and
refuses programs, scripts and documents a browser
would open as a page: `.exe .msi .bat .cmd .com .scr .ps1 .vbs .vbe .js .jse
.wsf .hta .jar .lnk .app .dmg .pkg .sh .command .html .htm .xhtml .shtml .svg
.mhtml .xml` and HTML, SVG, XML and JavaScript content types. The file name
is cleaned of paths and control characters.

### api.composer

The message the user is writing, in the composer that handed the plugin its
`composerId` (the click context of a composer action, or the props of a
composer slot):

```js
await api.composer.getBody(composerId)        // { html, text } of the user's own text   compose:read
await api.composer.getSelection(composerId)   // { html, text, empty }                    compose:read
await api.composer.replaceSelection(composerId, { text } | { html }, { below })   // true  compose:write
await api.composer.replaceBody(composerId, { text } | { html })                   // true  compose:write
await api.composer.attach(composerId, { blobId, name, type, size })               // true  email:blob-write
```

- The user's own text is what they wrote: the signature, a reply's quote
  header and the quoted message are not part of it, and `replaceBody` leaves
  them where they are. Inline images in replaced text are kept.
- `replaceSelection` replaces the selection, or inserts at the caret when
  nothing is selected; `{ below: true }` adds after the selection instead. A
  selection that holds the signature or the quoted message is refused.
- Each change is one step in the editor's history: one Ctrl+Z takes it back.
- `text` becomes one paragraph per line; `html` goes through the same cleaning
  as `compose.open` bodies. At most 60 changes a minute.
- `attach` adds a blob from `api.jmap.uploadBlob` through the composer's usual
  checks (size limit, onBeforeAttachmentUpload).

### Text checkers (Bulwark 1.20 and later)

A plugin with `compose:check` can check what the user writes while they
type. The host sends it the user's own text in paragraphs and draws its
answers as underlines with a popup of suggestions; the issue list, keyboard
access, plain-text mode and the admin's policy are the host's. See
`languagetool/` for a complete checker.

```js
const checker = await api.composer.registerChecker({
  id: 'spell', label: 'My checker', kinds: ['spelling', 'grammar'],
  debounceMs: 800, languages: ['de-DE'], warnBeforeSend: false,
  async check({ composerId, revision, language, full, order, segments, objectReplacement }) {
    return [{ segmentId: segments[0].id, offset: 0, length: 3, kind: 'spelling',
      message: 'Possible spelling mistake.', replacements: ['the'], ruleId: 'TYPO' }];
    // or { annotations, status: 'ok' | 'unavailable' | 'paused', message, retryAfterMs }
  },
  onAction({ composerId, annotation, action }) {},   // ignore | dictionary | disable-rule
});
await checker.update({ warnBeforeSend: true });
await checker.recheck();     // every composer sends all its paragraphs again (full: true)
await checker.dispose();
```

- Register from `activate()`: the host calls `check` in the background frame.
- `segments` holds only paragraphs the checker hasn't seen; `order` lists all
  ids. An id names one exact text, so cache by id. A hard break is `\n`, a
  mention or inline image one `objectReplacement` (U+FFFC) to skip.
- Offsets are UTF-16 units into the segment text (as JavaScript and
  LanguageTool count). Ranges over a line break or an object, through half a
  character, or out of the segment are dropped; at most 300 annotations and 5
  replacements each.
- One request per composer at a time, newest text wins, 15 s timeout, at most
  20,000 characters of new text per request. Errors and timeouts don't count
  as plugin errors: answer `status: 'unavailable'` or `'paused'` with
  `retryAfterMs` instead of throwing.
- Nothing is sent while proofreading is off (user, message or admin, also per
  plugin id), while the policy isn't loaded, for a message that will be
  signed or encrypted, or in the first second after the composer opens.
- A checker that checks only when the user asks registers with
  `mode: 'on-demand'`, needs only `compose:read`, and uses
  `api.composer.getCheckText(composerId, id)` and
  `api.composer.setAnnotations(composerId, id, revision, annotations)` with a
  composer id from a user action (the AI assistant does this).
- Crypto plugins: give the Options entries that sign or encrypt
  `protects: 'sign'` or `'encrypt'` (needs `crypto:full` or
  `email:raw-send`). While one is ticked, nothing is checked. A `crypto:full`
  plugin that publishes no such entries pauses checking everywhere.

### api.email, api.mailboxes, api.drafts, api.compose

```js
await api.email.get(emailId)                 // EmailReadView or null; any message of the account
await api.email.list({ mailboxId, limit, position })   // EmailSummary[]; limit 1-100, default 50
await api.email.search({ text, from, to, subject, after, before, hasAttachment, mailboxId, limit, position })   // EmailSummary[], newest first; limit 1-50
await api.email.move(emailIds, mailboxId)    // at most 100 ids; 20 moves a minute
await api.email.archive(emailIds)
await api.email.getAttachment(emailId, blobId)   // { name, type, size, data: ArrayBuffer }, at most 25 MB
await api.email.getRaw(emailId)              // the RFC 5322 source as ArrayBuffer, at most 25 MB
await api.email.setKeyword(emailId, keyword, accountId?)
await api.email.removeKeyword(emailId, keyword, accountId?)
await api.email.updateKeywords(emailId, { '$assigned:ck': true, '$assigned:cj': false }, accountId?)   // true, or false if a plugin stopped it
await api.mailboxes.list()                   // [{ id, name, role, parentId, totalEmails, unreadEmails }]
await api.drafts.create({ to, cc, bcc, subject, body, isHtml, attachments })   // the draft's email id
await api.compose.open({ to, cc, bcc, subject, body, isHtml, attachments })    // 'opened' or 'navigating'
await api.compose.reply(emailId, { text, all })   // reply to the open message, starting with text; true
await api.email.forward(emailId, { to, text, attachments, accountId })   // forward it, no composer
await api.email.getAttachmentText(emailId, blobId, { maxChars, accountId })          // 1.20: AttachmentTextView
await api.email.getAttachmentImage(emailId, blobId, { maxSide, exif, accountId })    // 1.20: AttachmentImageView
await api.email.getThread(emailId, { accountId })        // 1.20: EmailReadView[], oldest first, at most 50
await api.email.getThreadCount(emailId, { accountId })   // 1.20: how many messages the conversation has
```

`email.forward` (permission `email:forward`, Bulwark 1.19.1 and later) sends
the message to 1 to 10 addresses from the user's default address: the
subject gets the forward prefix, `text` (plain text) comes first, then the
original's From, Date, Subject and To lines and its text. `attachments`
names which of the original's attachments go along, by `blobId`; without
it every attachment that isn't an inline image does. The first forward to
an address asks the user in a dialog Bulwark draws, naming the plugin, the
message and the address; Settings > Add-ons lists the allowed addresses
and takes them back. The forward goes through the same checks as a reply
(the external-recipient question, the organisation's disclaimer, other
plugins' `onBeforeEmailSend`), is held for the user's undo delay, lands in
Sent, and marks the original `$forwarded`. It resolves to `{ sent: true,
emailId, to, scheduledFor }`, or `{ sent: false, reason }` with `declined`
(the user said no) or `stopped` (a check stopped it). 10 a minute; it waits
as long as the user takes to answer. Approvals are kept in the browser, so
a new device asks again.

`EmailReadView` has `id, threadId, mailboxIds, from, to, cc, subject,
receivedAt, isRead, isFlagged, hasAttachment, attachments, preview,
keywords, text, headers, source, auth`. `EmailSummary` is the list view
without body, headers or source.

From 1.20 an inline image in `attachments` also has `cid` (its
Content-ID, without angle brackets) and `alt` (the alt text of the
`<img src="cid:…">` that shows it, else its title, when the sender wrote
one). The `email` prop of the reader slots (`email-detail-sidebar` and
the others) carries `blobsReadable: false` when this login can't read the
open message's attachments, text or conversation through the host: a
message of another connected login in a unified view or a Pro tab. Then
`getAttachment`, `getAttachmentText`, `getAttachmentImage` and `getThread`
fail for it, so offer none. The field is left out otherwise, and views a
host call returns never carry it.

`search` runs a JMAP filter over all mail (or one folder with `mailboxId`):
`text` matches whole words in sender, recipients, subject and body, `from`,
`to` and `subject` their fields, `after` and `before` take dates; give at
least one. The plugin gets summaries and reads one with `get`. From 1.20
`position` (0 to 1,000,000) skips that many results, to page past the
first `limit`.
`getAttachment` only accepts a `blobId` that is an attachment of that
message. Keywords are JMAP keywords such as `$flagged` or `$label:work`
(letters, digits and `$ _ . : -`, up to 128 characters). `setKeyword`,
`removeKeyword` and `updateKeywords` refuse `$draft`, `$junk`,
`$notjunk` and `$phishing`: those change what the app and the server do
with a message, and stay with the app's own actions.

`updateKeywords` (Bulwark 1.19 and later) sets (`true`) and clears
(`false`) up to 20 keywords of a message in one change, so a swap never
leaves both or neither. A message in the open list changes the way the
app's own actions change it: the row shows the new keywords at once, the
keyword hooks run, and a list filter or list order on one of the keywords
loads the list again. `accountId` names the message's account; the click
context of message actions carries it for team and shared mailboxes.

In a team mailbox (a Stalwart group account) keywords are the same for
every member, `$seen` included: whoever opens a message marks it read for
the whole team. Don't use read state for team status.

#### Attachment text and images, conversations (1.20)

These four calls came with the AI assistant 2.2. Check their flags in
`api.host.features` first (see [api.host](#apihost)). Each finds the
message the way `get` does: give `accountId` for shared and group mail
(rows of an open shared folder are found without it). A message it can't
find rejects with `<method>: no message with id "…"`. Past the rate limit
they reject with `<method>: too many reads, try again in a minute`.

**`getAttachmentText(emailId, blobId, { maxChars, accountId })`**
(`email:blob-read`, flag `attachmentText`, 30 a minute). The text of one
attachment, read in the webmail: the plugin never gets the file's bytes
from this call. Like `getAttachment`, it refuses a `blobId` that isn't an
attachment of that message. It resolves to:

```js
{ name, type, size, format, status, text, truncated, pages, sheets }
```

- `format`: `text`, `csv`, `html`, `ics`, `vcf`, `pdf`, `docx`, `xlsx`,
  `pptx`, `odt`, `ods`, `odp` or `other`.
- `status`: `ok`; `too_big` (over 20 MB, or an Office file that unpacks to
  more than 50 MB); `unsupported` (images, archives, the old .doc, .xls
  and .ppt); `no_text` (a scanned PDF, an empty file); `encrypted`;
  `failed`.
- `text` is `''` unless `status` is `ok`. `maxChars` is 1 to 100,000,
  20,000 by default. `truncated` is true when the text was cut there, or
  when a PDF or a spreadsheet had more than was read.
- PDFs: at most 50 pages are read, and `pages` is the page count of the
  file; in a PDF of more than one page each page starts with "Page n". Spreadsheets:
  at most 5 sheets of 2,000 rows each, `sheets` names those read, and each
  starts with "Sheet: <name>" followed by CSV rows. Presentations: "Slide
  n" and its text. Calendar files: one line per event or task (title,
  start, end, location, organiser). Contact files: name, addresses, phones,
  company.

**`getAttachmentImage(emailId, blobId, { maxSide, exif, accountId })`**
(`email:blob-read`, flag `attachmentImages`, 30 a minute). An image
attachment or an inline (`cid:`) image of the message, made smaller in the
webmail. Images the message's HTML loads from the web are never fetched.
It resolves to:

```js
{ name, type, width, height, data, status, alt, exif }
```

- `status`: `ok`; `tracker` (1 or 2 px); `tiny` (a side under 64 px, or
  less than 128 × 128 in area); `too_big` (over 20 MB, more than 50
  megapixels, or still over 1.5 MB at 64 px); `unsupported` (SVG, HEIC,
  TIFF, AVIF, a broken file, not an image); `failed`. The size is read
  from the file's header before anything is decoded, so trackers, tiny and
  too large images are never decoded. Only JPEG, PNG, GIF, WebP and BMP
  headers are read.
- When `ok`: `data` is base64 without a `data:` prefix, at most 1.5 MB.
  `type` is `image/jpeg` (quality 0.85, see-through parts on white) or
  `image/png` for a picture with see-through parts. `width` and `height`
  are the size of `data`. Otherwise `data` is `''` and `type` is the
  attachment's own.
- `maxSide` is the long edge, 64 to 2,576 px, 1,568 by default; images are
  never made larger. EXIF orientation is applied, and an animated image
  gives its first frame.
- `alt` is the alt text the message's HTML gives this inline image.
- `exif: true` adds `exif: { taken, lat, lon }` when the photo has them
  (`taken` like `2026-10-31T14:05:30`, with the offset when the camera
  wrote one). Off unless asked: only ask when the user wants the date or
  place.

**`getThread(emailId, { accountId })`** (`email:read`, flag `threads`, 60
a minute). Every message of the conversation the message belongs to, as
`EmailReadView`s with `accountId`, oldest first. A conversation longer
than 50 gives its newest 50; only those are fetched. A message the server
lists in no conversation comes back alone.

**`getThreadCount(emailId, { accountId })`** (`email:read`, flag
`threads`, 120 a minute, a limit apart from `getThread`'s). How many
messages the conversation has, 1 for a message in none. It reads no
message bodies, so a panel can call it to decide whether to offer a
conversation read.

**`listSelection`** (flag `listSelection`). The `email-detail-sidebar`
slot gets the messages ticked in the list, with `email:read`:
`{ emails: [{ id, accountId }], total }` when two or more are ticked, else
`null`. `emails` names at most 50, `total` counts them all. Rows of
another connected login are counted but not listed. A Pro email tab's
panel always gets `null`, and `app-side-panel` doesn't get the prop.

#### More actions (1.20)

These calls also came with the AI assistant 2.2: answering invitations,
deleting events with undo, filter rules, changing many messages at once
and changing settings. Check their flags in `api.host.features` first
(see [api.host](#apihost)). List `calendar:respond` and `settings:change`
in `optionalPermissions`: both are new and high risk, and older webmails
don't know them.

```js
await api.calendar.respond(emailId, 'accepted' | 'tentative' | 'declined')   // calendar:respond
//   → { status, title, start, organizer }, or null when another plugin stopped it
await api.calendar.deleteEvent(id)           // calendar:write → { undoToken } (null when it can't be undone)
await api.calendar.undoDelete(undoToken)     // calendar:write → { id }

await api.filters.list()                     // filters:read → { supported, editable, rules }
await api.filters.create({ name, match, conditions: [{ field, op, value, headerName }],
  actions: [{ type, mailboxId, tagId }] })   // filters:write → { id, undoToken }
await api.filters.undo(undoToken)            // filters:write

await api.email.batch({ emailIds, action, mailboxId, tagId })   // email:write → { done, failed, undoToken }
await api.email.undoBatch(undoToken)         // email:write

await api.app.describeSettings({ key: value } | [key])   // settings:read → { [key]: SettingDescription }
await api.app.setSettings({ key: value })                // settings:change → { applied, refused, undoToken }
await api.app.undoSettings(undoToken)                    // settings:change → { restored, refused }
```

**Undo tokens.** What an undo needs stays in the host; the plugin gets a
random token, bound to the plugin and the signed-in account, good for 30
minutes. A token is spent once its undo went through; when the undo
failed it stays, so the plugin can try again, one try at a time. A
plugin keeps at most 50 tokens, the oldest go first. Past that, or after
30 minutes, an undo rejects with `<method>: this can't be undone any
more`.

**`calendar.respond(emailId, status)`** (flag `answerInvitation`). Answers
the invitation in a message of the user's own account the way the
reader's invitation banner does: the answer is written with scheduling
on, so the server sends the reply to the organiser, and the calendar
hooks of other plugins run. An event not yet in the calendar is added
first. It can't be undone; answer again to change it. It refuses:

- a message with no invitation, or one that asks for no answer (a reply,
  a cancellation)
- an event the user organises
- an invitation whose sender doesn't match its organiser, unless the
  server verified the sender; this check runs also when From is one of
  the user's own addresses
- mail of a shared or group mailbox (answer those in the reader)
- while reading invitations is switched off in Settings > Calendar, and
  an account without a calendar

`start` is the event's start as the invitation gives it, `organizer` the
organiser's address (both `null` when missing).

**`calendar.deleteEvent(id)`** works as before (an occurrence's id
deletes that occurrence; it never sends cancellations). From 1.20 it
resolves to `{ undoToken }`: a token for a single event of the user's own
calendars, `null` for repeating events, their occurrences and events of
shared calendars. `undoDelete` creates the event again from the host's
copy with the same uid and sends no invitations; it rejects when the
event can't be created.

**`filters.list()`, `filters.create(rule)`, `filters.undo(token)`** (flag
`filterRules`: the server has filters). These work on the rules of
Settings > Filters, which shows a new rule at once. `list` resolves to
`{ supported, editable, rules }`; `editable` is false when the filter
script was edited by hand, and each rule has `id, name, isActive,
editable, match, conditions, actions` (`folder` is a move or copy
target's path, `value` the address of a forwarding rule). `create` checks
the rule the way the rule editor does and puts it at the top:

- a name, `match` `all` (default) or `any`, 1 to 10 conditions and 1 to
  10 actions, and at least one action besides `stop`
- conditions on `from`, `to`, `cc`, `subject`, `body`, `header` (with
  `headerName`), `size` (bytes) or `attachment`, with the operators that
  field takes
- actions `move`, `copy`, `mark_read`, `star`, `add_label` (`tagId`, one
  of the user's tags) and `stop`. Forward, redirect, reject, discard and
  keep are refused by name
- `move` and `copy` only into folders of the filters' own account that
  nobody else shares, never the trash

It refuses a script edited by hand ("add the rule in Settings > Filters")
and resolves to `{ id, undoToken }`. `undo` puts the script back as it
was, and refuses when the filters changed since.

**`email.batch({ emailIds, action, mailboxId, tagId })`** (flag
`batchMail`). One change to 1 to 200 messages of the signed-in account,
through the app's own batch functions: the plugin hooks run and the list
updates. `action` is `archive`, `move` (with `mailboxId`), `read`,
`unread`, `tag` or `untag` (with `tagId`, one of the user's tags).
Archive follows the user's archive mode (one folder, by year, by month)
and makes the Archive folder when there is none; it is refused while the
admin switched archiving off. Move goes only into the account's own
folders, never the trash. Archive and move count as one call against the
move limit (20 a minute). Messages it can't find count as `failed`.

The batch is one entry in the app's undo history, so Ctrl+Z takes it back
too; `undoBatch` and Ctrl+Z run the same undo once. Undo puts every
message back in its folders with its read state, or puts the read state
or tag back on exactly the messages that changed.

**Shared folders.** A batch move or archive, and a filter's move or copy
target, never files mail into a folder shared with other people. The host
asks the server for the folder's sharing (the folder and the folders
above it; for archive the Archive and its year and month folders too). An
answer it can't get counts as shared, so the call is refused.

**`app.describeSettings`, `app.setSettings`, `app.undoSettings`** (flag
`changeSettings`). Each call names 1 to 20 settings, by the names
`getSettings` uses (`language` and `calendarView` included).
`describeSettings` takes changes or just names and resolves to, per key,
`{ key, label, page, pageLabel, current, currentLabel, next, nextLabel,
allowed, reason, options }` in the user's language, so a plugin can show
"Change Time format: 12-hour → 24-hour?" before it asks.

`setSettings` changes only settings on an allow-list of about 150:
appearance, language and formats, message list, reading, composing,
notifications, calendar view, contacts view and accessibility. It never
changes remote content, trusted senders, signature details, the push
relay, download templates, security, identities, sync or debug settings,
and never sets a value that deletes or sends mail or turns off a delete
safety net (`deleteAction` permanent, `readReceiptResponse` always,
`confirmDelete` or `confirmBulkDelete` off, `permanentlyDeleteJunk` on,
`postExportAction` trash). `senderFavicons` and `showAvatarsInJunk` may
only be switched off. At the moment of the change it also refuses a
setting the admin locked or hid, a value outside the admin's restriction,
and a setting a feature gate or no-third-party mode hides.

Each key is checked and written on its own, through the same setters as
the settings pages, so the open page shows the change and it syncs. The
result lists `applied` (`{ old, new }` per key) and `refused` with a
reason: `unknown`, `not_allowed`, `bad_value`, `locked`, `hidden`,
`unavailable` or `stopped` (another plugin's `onBeforeSettingChange` said
no). `undoSettings` writes the exact old values back, but refuses a
setting the admin has locked or hidden since, one a gate now hides, and
an old value the admin's restriction now rules out.

### api.accountData

```js
await api.accountData.get(accountId?)          // { supported, value }; value is null when there is none
await api.accountData.set(accountId, value)    // replaces it; null removes it
```

A small JSON value, at most 4 KB, that the plugin keeps in a mail account's
Inbox (Bulwark 1.19 and later): `get` needs `email:read`, `set`
`email:write`. Everyone who can open the account reads the same value, so
in a team mailbox it is shared by the team. It lives in Stalwart's mailbox
metadata under `org.bulwarkmail.plugin.<plugin id>` and needs Stalwart
1.0 or later; elsewhere `get` answers `{ supported: false, value: null }`
and `set` throws. Only JMAP clients that know the name see it. Without
`accountId` it is the user's own account. At most 30 reads and 20 changes
a minute.

The value counts against the mailbox's metadata room: Stalwart keeps at
most 64 KB of shared metadata per mailbox, which Bulwark's shared tags and
team templates use too. Keep it small, and read it again right before a
change so you don't overwrite what another member wrote.

`compose.open` and `drafts.create` take addresses as `a@example.com` or
`Name <a@example.com>`, at most 100 recipients, a subject up to 998
characters, a body up to 512 KB (HTML is sanitised) and at most 20
attachments uploaded with `api.jmap.uploadBlob` (`{ blobId, name, type,
size }`). Nothing is sent: `compose.open` opens the composer (5 times a
minute; outside the mail page the app first goes there, which reloads the
plugin, and resolves to `'navigating'`), `drafts.create` saves a draft from
the user's default address (10 a minute).

### api.jmap

```js
await api.jmap.getKeywords({ limit })        // keyword counts and provider labels
await api.jmap.setKeywords(emailId, { $seen: true, work: true }, accountId?)   // replaces all keywords
await api.jmap.setKeyword(emailId, keyword, accountId?)
await api.jmap.removeKeyword(emailId, keyword, accountId?)
await api.jmap.uploadBlob(bytes, name, type)   // { blobId, size, type }
// privileged tier only:
await api.jmap.fetchBlob(blobId, { name, type })    // Uint8Array
await api.jmap.sendRaw(rawBytes, identityId, { delayedUntil, envelopeRecipients })
await api.jmap.submitRaw(rawBytes, identityId, opts)   // like sendRaw, without a copy in Sent
await api.jmap.importRaw(rawBytes, mailboxRoles, { keywords, accountId })
```

### api.keywords, api.tabs, api.search

```js
await api.keywords.list()                    // the user's tag definitions
await api.keywords.add([{ id, label, color, visibility }])   // { added, skipped }; never overwrites
await api.keywords.reorder(ids, { caseSensitive })   // ids must be every existing tag
await api.keywords.discover({ limit })       // keywords found on messages
await api.keywords.getCounts(ids?)           // { id: { total, unread } }
await api.keywords.refreshCounts()

await api.tabs.set({ tabs: [...] })          // inbox tabs, at most 8 per plugin
await api.tabs.clear()
await api.tabs.getState()                    // { tabs, activeTabId, tabCounts }
await api.tabs.refreshCounts()
await api.tabs.categorize(emailIds, tabId)   // false when a plugin stopped it

await api.search.run(filter, { label })      // runs a JMAP Email filter as the list search
```

A tab selects its messages with a JMAP `query` filter or a `keyword`; one
tab without either is the default. See `MessageListTabsConfig` in the
webmail's `lib/plugin-types.ts` for the full shape. `search.run` replaces
the user's search and shows a chip with `label` (up to 64 characters,
default the plugin name); the plugin doesn't get the results.

### api.calendar, api.tasks

```js
await api.calendar.listCalendars()
await api.calendar.getEvents({ from, to, calendarIds })   // at most 366 days and 1000 events
await api.calendar.getEvent(id)
await api.calendar.createEvent({ title, start, end | duration, timeZone, isAllDay,
  description, location, calendarId, participants, repeat, uid })   // the event, or null
await api.calendar.updateEvent(id, patch)
await api.calendar.deleteEvent(id)           // an occurrence's id deletes that occurrence; 1.20: { undoToken }
await api.calendar.undoDelete(undoToken)     // 1.20: { id } of the event created again
await api.calendar.respond(emailId, 'accepted' | 'tentative' | 'declined')   // 1.20, calendar:respond

await api.tasks.list({ includeCompleted })   // at most 1000
await api.tasks.get(id)
await api.tasks.create({ title, description, due, priority, calendarId })   // the task, or null
await api.tasks.update(id, patch)
await api.tasks.setComplete(id, complete)
await api.tasks.delete(id)
```

Times are `2026-05-01` (a day), `2026-05-01T09:30` (wall clock in `timeZone`,
default the user's zone) or `2026-05-01T07:30:00Z`. `end` is exclusive.
Titles up to 500 characters, descriptions up to 10,000, locations up to 500,
at most 50 participants. `repeat` is `{ frequency: 'daily' | 'weekly' |
'monthly' | 'yearly', interval, count | until }`. A `uid` you choose is
stored as `<uid>@<plugin id>.plugin.bulwark`, so you can find the event again.
Writes go through the calendar like the user's own edits, so other plugins'
hooks run and may stop them (then `create` resolves to `null`). Nothing
here sends invitations. `respond`, `undoDelete` and the undo token of
`deleteEvent` are described under [More actions](#more-actions-120).

### api.contacts, api.addressBooks

```js
await api.contacts.list(addressBookId?)
await api.contacts.search(query)
await api.contacts.get(id)
await api.contacts.create(card)              // a JSContact card
await api.contacts.update(id, patch)
await api.contacts.remove(id)
await api.addressBooks.list()
await api.addressBooks.create(name)
```

### api.files

New in 1.20, with the AI assistant 2.2: the user's Files (Stalwart's file
storage). Check `api.host.features.files === true` and
`typeof api.files?.find === 'function'` first. The flag is true where the
server has Files for the signed-in account and the admin left Files on,
the same check as the navigation rail; otherwise every call rejects with
`<method>: Files is not available`. The permissions are the existing
`files:read` and `files:write`.

```js
await api.files.find({ text, folderId, kind, modifiedAfter, modifiedBefore, limit })   // files:read → FileInfo[], newest first
await api.files.list(folderId?)              // files:read → FileInfo[], folders first, then by name
await api.files.getText(fileId, { maxChars })            // files:read → as email.getAttachmentText
await api.files.getImage(fileId, { maxSide, exif })      // files:read → as email.getAttachmentImage, without alt
await api.files.attach(fileIds, { composerId } | { newDraft: { to, subject, body } })   // → { attached, refused }
await api.files.saveAttachments(emailId, blobIds, folderId?, { accountId })   // files:write + email:read → { saved, stopped }
await api.files.create({ folderId, name, content, type, replace })            // files:write → { file, kept? }
await api.files.createFolder({ parentId, name })         // files:write → FileInfo
await api.files.move(fileId, folderId | null)            // files:write → { file, previousFolderId }
await api.files.rename(fileId, name)                     // files:write → { file, previousName }
```

There is no call that deletes a file, shares it, makes a public link or
moves it to another account.

**FileInfo** is `{ id, name, path, parentId, kind, mimeType, size,
modified, shared, owner }`. `path` is the folder the item is in, from the
top of its drive (`/` or `/Documents/2026`); `parentId` is null at the
top. `kind` is `file` or `folder`; a folder has `mimeType` `''` and `size`
0. `modified` is ISO 8601, or `''` when the server doesn't say. A file in
a drive someone shared with the user has `shared: true`, `owner` (whose
drive it is) and an id of the form `account:node`; such files can be
found, read and attached, never changed.

**Reading.**

- `find` matches every field given. `text`: words that must all appear in
  the name or path, any case. `folderId`: only below that folder, at any
  depth. `kind`: `document` (PDF, Office and text files), `image`, `pdf`,
  `spreadsheet`, `presentation`, `text` or `folder`. `modifiedAfter`
  (inclusive) and `modifiedBefore` (exclusive) take ISO 8601 dates.
  `limit` is 1 to 50, 20 by default. It covers the user's own drive and
  the drives shared with them, and leaves out the Files trash and what is
  in it, Stalwart 1.0 symlinks, and folders of another account that are
  only the way down to something shared. The listing is kept for 60
  seconds; a change through `api.files` or the Files view drops it.
- `list` returns at most 200 entries. Without a folder: the top of the
  user's drive and the top items others shared with them. A file id is
  refused (`"x" is not a folder`).
- `getText` and `getImage` share a limit of 30 reads a minute and answer
  like `email.getAttachmentText` and `email.getAttachmentImage` (see
  [Attachment text and images](#attachment-text-and-images-conversations-120)).
  The download stops past 20 MB, whatever size the listing gave, and
  answers `too_big`. `getImage` reads a photo's date and place only with
  `exif: true`, and answers `unsupported` for SVG. Files of a shared drive
  are read from their owner's account.

**Attaching.** `attach` takes 1 to 20 files, no folders, and needs
`files:read` plus `compose:write` for `{ composerId }` (the draft open in
the composer, as for `api.composer`) or `compose:open` for `{ newDraft }`.
At most 20 calls a minute. The files go in by blob: nothing is downloaded
or uploaded again, and a file keeps the login that holds it, so a draft
sent from another login copies it over first. Each file passes
`onBeforeAttachmentUpload` and the server's limit for all attachments of
one message: the open composer checks them itself, and for a new draft
the host checks them before it opens the draft. Files turned down are
named in `refused`; when none are left, no draft opens. A new draft goes
through `compose.open`, with its address checks, its limit of 5 a minute
and its question before replacing an open draft.

**Writing.** Writes go only into the user's own drive: never into, out of
or inside a folder shared with others (`shareWith` on it or on a folder
above it), never into a drive someone shared with the user, never into
the Files trash. When a folder above the target is missing from the
listing, the host can't tell whether it is shared and refuses. Every
write counts against a limit of 20 a minute, refused ones too, counted
before the drive is listed. The Files app's hooks run: `onBeforeFileUpload`
(create, replace, saveAttachments), `onBeforeFileMove` and
`onBeforeFileRename` can stop a write (`another plugin stopped this`);
`onAfterFileUpload`, `onDirectoryCreate`, `onFileMove` and `onFileRename`
report it. `onFileMove` reports the item as it was, with its old path, as
the Files app does. An open Files view refreshes after a change.

- `saveAttachments` files 1 to 20 attachments of a message into a folder
  (`null`: the top of the drive), copying them from a shared or group
  mailbox's account first. Each blob must be an attachment of that
  message, found as `email.get` finds it. A name that is taken becomes
  "name (2).ext". It resolves to the saved files and the names another
  plugin stopped. The reader's Save to Files dialog uses the same code.
- `create` writes a `text/markdown` or `text/plain` file of up to 512 KB.
  A new file needs a `name`, checked against the server's naming rules
  first (reserved names, `:`, control characters, length); a name that is
  taken becomes "name (2).md", so nothing is overwritten. With `replace:
  fileId` it gives a text or Markdown file of the user's own drive new
  content: the old version first goes into the Files trash, in a folder
  of its own, where Restore brings it back next to the new one, and
  `kept` names it. Other kinds of files are refused. When the server
  refuses the new content, the copy is taken out of the trash again.
- `createFolder` uses the same name checks and Stalwart 1.0's depth limit
  of 64 levels.
- `move` works within the user's own drive: not into the folder itself,
  not into the trash, not where something already has that name. Move it
  back to `previousFolderId` to undo.
- `rename` refuses a name the folder already holds. Rename back to
  `previousName` to undo.

### api.templates, api.identities, api.vacation, api.user, api.app

```js
await api.templates.list() / get(id)
await api.templates.create({ name, subject, body, isHTML, category })   // at most 500 templates
await api.templates.update(id, patch) / delete(id)
await api.identities.update(id, { name, replyTo, textSignature, htmlSignature })   // or null if stopped
await api.vacation.get()          // 1.20 adds forwardActive: true, false or null
await api.vacation.set({ isEnabled, subject, textBody, htmlBody, fromDate, toDate })   // or null if stopped
await api.user.getAccounts()      // [{ id, label, serverUrl, username, displayName, email, avatarColor, isConnected, isDefault, isActive }]
await api.user.getSelf()          // { accountId, email, name }
await api.user.getMailAccounts()  // [{ accountId, name, kind: 'personal' | 'group' | 'shared', isReadOnly, isOpen }]
await api.user.findPeople({ text, ids, accountId })   // { people: [{ id, type, name, email }], complete }
await api.user.getIdentities()    // the user's sender identities
await api.user.logout()
await api.app.getInfo()           // { product: 'Bulwark Mail', name, version, edition: 'full' | 'lite', stalwartFeatures, demoMode }
await api.app.searchSettings('undo send', { limit })   // [{ pageId, page, label, description }], in the user's language
await api.app.getSettings()       // { mailLayout: 'focus', sendDelaySeconds: 10, markAsReadDelay: 0, theme, language, ... }
await api.app.describeSettings({ key: value } | [key])   // 1.20, settings:read
await api.app.setSettings({ key: value })                // 1.20, settings:change
await api.app.undoSettings(undoToken)                    // 1.20, settings:change
```

From 1.20 `vacation.set` refuses, for every plugin, `isEnabled: true`
while the out-of-office forwards mail to another address (set in
Settings > Out of office) or while that can't be read: switching it on would start
sending the user's mail elsewhere. Switching it off and changing the text
still work. `vacation.get` says which with `forwardActive` (`null` when
the account has filters but they couldn't be read). The settings calls
are described under [More actions](#more-actions-120); from 1.20
`getSettings` also returns every setting `setSettings` may change, and
`calendarView`.

`getSelf` and `getMailAccounts` need `account:read`, `findPeople`
`directory:read`; all three are new in Bulwark 1.19. `getSelf().accountId` is the user's own JMAP account
id, which Stalwart also uses as their principal id: it names the user the
same way for every member of a team mailbox, so it can go in a keyword
(`$assigned:<accountId>`) where an address can't. `getMailAccounts` lists
the mail accounts of the signed-in login: the user's own (`personal`),
team mailboxes they are a member of (`group`, a Stalwart group account)
and mailboxes another person shared with them (`shared`); `isOpen` marks
the account of the open folder. An account is `group` only when the
server confirmed it is a group principal; when it can't say, the account
is `shared`. The call waits for that answer.

`findPeople` looks people up in the server's directory as the account
named in the query (`{ text, accountId }`; the user's own without it): by a
part of their name or address, 3 characters or more, or by principal id, at
most 20 ids. It returns at most 20 people, and a plugin may look up 10
times a minute. With directory lookups off, which is Stalwart 1.0's default, `complete` is false and only
the people the user shares an account with are found (themselves and their
groups); an administrator turns lookups on in Stalwart. Bulwark notifies
nobody: a plugin can't send push notifications to other users.

`api.app.getInfo` needs no permission: `name` is what the administrator
called this installation (`APP_NAME`), `version` the app's version. It is
new in Bulwark 1.17.0; on older versions the call fails with an unknown
method, so catch it when the plugin supports those.

`api.app.searchSettings` searches the same index as the search box in
Settings, in the user's language; the query may also be in English. It
lists only the pages this user has (filters and automatic replies only
where the server supports them). `api.app.getSettings` needs
`settings:read` and returns a fixed list of preferences as plain values;
nothing about other people (trusted senders, mutes) and no server
addresses.

Template names up to 200 characters, subjects 998, bodies 100,000. Identity
names up to 256 characters, at most 10 reply-to addresses, text signatures
up to 20,000 characters and HTML signatures up to 100,000; the address can't
be changed. Vacation subjects up to 500 characters, bodies up to 64,000;
dates carry a zone (`...Z`) or are `null`. HTML is sanitised like HTML typed
into Settings.

### api.http, api.oauth

```js
await api.http.fetch(url, { method, headers, body })
// { ok, status, statusText, headers, bodyText, bodyBytes }
await api.http.post('/api/my-route', { any: 'json' })           // { ok, status, data }
await api.http.post('/api/my-route', blob, { headers: { 'X-Plugin-Name': 'a.pdf' }, progressFileId })
await api.oauth.createState()       // put it in the authorize URL
await api.oauth.getRedirectUri()
```

`http.fetch` runs in the webmail page with `credentials: 'omit'` and CORS, so
the other site must allow the webmail's origin. The URL must be https and
match `httpOrigins`, also after redirects. `Cookie` and `X-JMAP-Username`
headers are dropped. Responses over 25 MB are refused.

`http.post` sends JSON, or a `Blob` as a binary body with `Content-Type`
and `X-Plugin-*` headers only, to a path in `apiPostPaths`. The host adds
the user's login, so the route can act for the user. `progressFileId` (the
file id from `onBeforeBlobUpload`) shows upload progress on the
attachment in the composer.

For OAuth, open the provider's authorize URL with `createState()` as `state`
and `getRedirectUri()` as the redirect; the code comes back to the plugin
through the `onOAuthCallback` hook.

### api.config, api.admin

```js
await api.config.get()                 // the admin's non-secret settings (configSchema)
await api.admin.getConfig(key) / getAllConfig()
await api.admin.setConfig(key, value) / deleteConfig(key)
```

`api.config.get()` and `api.admin.getConfig` / `getAllConfig` return the
same thing: every setting except `secret` fields, for any signed-in user.
From 1.20 that holds when the user is also signed in to the admin console;
before, `api.admin.get*` returned the secrets then. Secrets are only for the
credential proxy (`api.proxy`), which adds them on the server. `set*` and
`deleteConfig` need an admin session and reject otherwise.

### api.sieve

```js
await api.sieve.isSupported()
await api.sieve.getActiveScript()      // { id, name, content } or null
await api.sieve.validateScript(content)   // { isValid, errors }
await api.sieve.regenerate()           // rebuild the active script, running onSieveScriptGenerate
```

Plugins don't write Sieve scripts directly. Add a section in the
`onSieveScriptGenerate` transform hook and call `regenerate()`, so the
user's own filter rules and every plugin's sections live side by side.

### api.proxy

See [Accounts and API keys](#accounts-and-api-keys).

### api.upfiles, api.crypto

```js
await api.upfiles.get(fileId)          // a File the user just attached (email:blob-read)
await api.upfiles.save(oldId, file)    // replace it before upload; privileged tier only
// privileged tier only, all need crypto:full:
await api.crypto.getPublicKeys() / createPublicKey(input) / removePublicKey(keyId)
await api.crypto.getEncryptionAtRest() / setEncryptionAtRest(config)
await api.crypto.getWebAuthn(credentialIdBytes) / createWebAuthn(name, displayName)
await api.crypto.getPublicKeyFromWKD(email)
```

These exist for encryption plugins such as `smime`. The WebAuthn PRF salt
comes from the plugin id, so one plugin can't derive another plugin's key.

### api.keystore

Certificates in the operating system's store, in the desktop app: Windows
`CurrentUser\My` with smart cards through their minidriver, and the macOS
keychain. Signing and unwrapping happen in the OS. The private key never
reaches the plugin. Privileged tier only, with the `keystore` permission.
List it in `optionalPermissions`, as an older webmail refuses the install if
it's in `permissions`, and read the flag as
`api.host?.features?.keystore === true`: it's absent, not `false`, when off.

```js
const certificates = await api.keystore.list();
// [{ id, certificate, chain, subject, issuer, serial, notBefore, notAfter, usages,
//    extendedUsages, algorithm, keyType, curve, keyBits, source, signSchemes,
//    decryptSchemes, canAgree, askEachUse }]
// certificate and chain are DER. chain leaves out the leaf and the root.

// The DER of a CMS message's signed attributes, as a SET. RSA gives the raw signature, ECDSA DER.
await api.keystore.sign(id, signedAttributes, { scheme: 'rsa-pkcs1', hash: 'SHA-256' }); // or rsa-pss, ecdsa
// A wrapped content key. rsa-oaep also takes label; MGF1 uses the same hash.
await api.keystore.decrypt(id, data, { scheme: 'rsa-oaep', hash: 'SHA-1' });   // or { scheme: 'rsa-pkcs1' }
// ECDH: the raw shared secret, big-endian, from the peer's SubjectPublicKeyInfo.
await api.keystore.agree(id, peerPublicKeySpki);
// list, decrypt and agree take { quiet: true } last: no dialog, see below.
await api.keystore.decrypt(id, data, scheme, { quiet: true });
```

- **Signing is for mail, and asks each time.** The shell takes the signed attributes
  of a CMS message: content type `id-data`, a message digest as long as the hash, a
  signing time within 10 minutes of now, and optionally `smimeCapabilities`, ESS
  `signingCertificateV2` and the key preference attributes, in DER order. It checks
  them and hashes them itself, so no other digest can be signed. Anything else is
  `keystore:invalid`.
- **Every call can ask the user.** The shell shows a native dialog by origin,
  certificate and use, and the OS may show a card's PIN prompt after it. Signing
  offers Allow once and Deny. Unwrapping offers Allow for 15 minutes, which each use
  renews and a lock ends, Allow once and Deny. It's not the plugin's to skip, and a
  same-origin frame can't go around it either. Don't list when the plugin
  starts: list when the user opens the plugin's settings or asks for a key.
- **Don't ask for what the user didn't ask for.** Opening a message isn't asking: it
  can be from anyone. Use `{ quiet: true }` there. It answers from what's already
  allowed, or with `keystore:ask-first`, and then show a button that makes the same call
  without it.
- **Errors are bare codes in `err.message`:** `keystore:cancelled` (Deny, or a
  PIN prompt closed. A Deny on a list lasts until the app quits, one on an unwrap for
  that message, and one on a signature for that send. Three in a row pause that key
  for 5 minutes), `keystore:ask-first` (a quiet call found nothing allowed), `keystore:not-found`
  (the certificate is gone: list again), `keystore:unsupported`,
  `keystore:locked` (card missing or locked, or busy), `keystore:failed`, `keystore:invalid`
  (bad input). What's bad on a signature is the plugin's bug, so don't fall back
  to something else over it. On `decrypt` and `agree` the bytes come from a
  message, so treat it as a failure like any other. `keystore:locked` is also
  what a card left out of its reader looks like, so move on to another key if
  there is one. Handle them all: don't let one escape from a hook, since three
  errors in a minute switch a plugin off.
- **Time.** `sign`, `decrypt` and `agree` have no timeout, and while one runs
  the calling hook's timer waits as it does for a plugin's own dialog, up to 10
  minutes from the hook's start. `list` never touches a card, has the usual
  30 s timeout and holds no timer. So a hook with a short budget, such as
  `onRenderEmailBody`, can't wait for the consent dialog over a list: race it
  and call `api.ui.rerenderEmail()` when the answer comes. If a dialog outlasts
  the timeout the call rejects with a timeout error and no code, but the answer
  still counts: list again and it joins the dialog that's up.
- **What's refused.** SHA-1 signatures (`keystore:unsupported`). A digest of the
  wrong length (`keystore:invalid`). `decrypt` answers only with up to 64 bytes
  for OAEP and 16, 24 or 32 for PKCS#1 v1.5, and every failure there reads
  `keystore:failed`, so it's no padding oracle. `rsa-pss` uses a salt as long as
  the hash. macOS has no OAEP label, and a card may have no OAEP at all:
  `keystore:unsupported`.
- **`signSchemes`, `decryptSchemes` and `canAgree`** are best effort for a key
  on a token, until tried. Only certificates fit for mail are listed. No CA is.
- **One render, one question.** `onRenderEmailBody` runs once per message and
  blob, and again for `api.ui.rerenderEmail()`. Older webmails also run it again
  when mark-read replaces the message, so share a result per message for a moment
  if a render asks the OS, and go past that on a retry.
- **Grants** clear at sign-out and account switch, and when the screen locks, so
  the next call may ask again. Forget your list then too.
- **Keep nothing.** Hold the list in memory. An id is the SHA-256 of the
  certificate, and calls only accept ids from the last list.

### Method permissions

<!-- generated:api-permissions -->
<!-- Generated by scripts/gen-docs.mjs; edit the webmail catalogues, not this table. -->

| Method | Permission |
|---|---|
| `api.email.getAttachmentText` | `email:blob-read` |
| `api.email.getAttachmentImage` | `email:blob-read` |
| `api.email.getThread` | `email:read` |
| `api.email.getThreadCount` | `email:read` |
| `api.calendar.respond` | `calendar:respond` |
| `api.calendar.deleteEvent` | `calendar:write` |
| `api.calendar.undoDelete` | `calendar:write` |
| `api.filters.list` | `filters:read` |
| `api.filters.create` | `filters:write` |
| `api.filters.undo` | `filters:write` |
| `api.email.batch` | `email:write` |
| `api.email.undoBatch` | `email:write` |
| `api.vacation.get` | `vacation:read` |
| `api.vacation.set` | `vacation:write` |
| `api.app.describeSettings` | `settings:read` |
| `api.app.setSettings` | `settings:change` |
| `api.app.undoSettings` | `settings:change` |
| `api.files.find` | `files:read` |
| `api.files.list` | `files:read` |
| `api.files.getText` | `files:read` |
| `api.files.getImage` | `files:read` |
| `api.files.attach` | `files:read` |
| `api.files.saveAttachments` | `files:write` |
| `api.files.create` | `files:write` |
| `api.files.createFolder` | `files:write` |
| `api.files.move` | `files:write` |
| `api.files.rename` | `files:write` |
| `api.storage.get` | none |
| `api.storage.set` | none |
| `api.storage.remove` | none |
| `api.storage.keys` | none |
| `api.toast.success` | none |
| `api.toast.error` | none |
| `api.toast.info` | none |
| `api.toast.warning` | none |
| `api.toast.progress` | none |
| `api.toast.dismiss` | none |
| `api.http.post` | `http:post` |
| `api.http.fetch` | `http:fetch` |
| `api.jmap.fetchBlob` | `email:blob-read` |
| `api.jmap.uploadBlob` | `email:blob-write` |
| `api.jmap.sendRaw` | `email:raw-send` |
| `api.jmap.submitRaw` | `email:raw-send` |
| `api.jmap.importRaw` | `email:raw-send` |
| `api.jmap.getKeywords` | `email:read` |
| `api.jmap.setKeywords` | `email:write` |
| `api.jmap.setKeyword` | `email:write` |
| `api.jmap.removeKeyword` | `email:write` |
| `api.upfiles.get` | `email:blob-read` |
| `api.upfiles.save` | `email:blob-write` |
| `api.crypto.getWebAuthn` | `crypto:full` |
| `api.crypto.createWebAuthn` | `crypto:full` |
| `api.crypto.getPublicKeys` | `crypto:full` |
| `api.crypto.createPublicKey` | `crypto:full` |
| `api.crypto.removePublicKey` | `crypto:full` |
| `api.crypto.getEncryptionAtRest` | `crypto:full` |
| `api.crypto.setEncryptionAtRest` | `crypto:full` |
| `api.crypto.getPublicKeyFromWKD` | `crypto:full` |
| `api.contacts.get` | `contacts:read` |
| `api.contacts.update` | `contacts:write` |
| `api.contacts.create` | `contacts:write` |
| `api.contacts.search` | `contacts:read` |
| `api.contacts.list` | `contacts:read` |
| `api.contacts.remove` | `contacts:write` |
| `api.addressBooks.list` | `contacts:read` |
| `api.addressBooks.create` | `contacts:write` |
| `api.user.getAccounts` | `account:read` |
| `api.user.getSelf` | `account:read` |
| `api.user.getMailAccounts` | `account:read` |
| `api.user.findPeople` | `directory:read` |
| `api.accountData.get` | `email:read` |
| `api.accountData.set` | `email:write` |
| `api.user.getIdentities` | `identity:read` |
| `api.user.getTimeZone` | none |
| `api.app.getInfo` | none |
| `api.app.searchSettings` | none |
| `api.app.getSettings` | `settings:read` |
| `api.user.logout` | `auth:emit` |
| `api.admin.getConfig` | `admin:config` |
| `api.admin.getAllConfig` | `admin:config` |
| `api.admin.setConfig` | `admin:config` |
| `api.admin.deleteConfig` | `admin:config` |
| `api.config.get` | none |
| `api.ui.confirm` | none |
| `api.ui.alert` | none |
| `api.ui.prompt` | none |
| `api.ui.openDialog` | none |
| `api.ui.rerenderEmail` | none |
| `api.ui.rerenderFetchedEmails` | none |
| `api.ui.openExternalUrl` | none |
| `api.ui.print` | none |
| `api.ui.downloadFile` | `ui:download-file` |
| `api.email.setKeyword` | `email:write` |
| `api.email.removeKeyword` | `email:write` |
| `api.email.updateKeywords` | `email:write` |
| `api.keywords.list` | `settings:read` |
| `api.keywords.add` | `settings:write` |
| `api.keywords.update` | `settings:write` |
| `api.keywords.remove` | `settings:write` |
| `api.keywords.reorder` | `settings:write` |
| `api.keywords.discover` | `email:read` |
| `api.keywords.getCounts` | `email:read` |
| `api.keywords.refreshCounts` | `email:read` |
| `api.tabs.set` | `ui:message-list-tabs` |
| `api.tabs.clear` | `ui:message-list-tabs` |
| `api.tabs.getState` | `ui:message-list-tabs` |
| `api.tabs.refreshCounts` | `ui:message-list-tabs` |
| `api.tabs.categorize` | `email:write` |
| `api.search.run` | `email:read` |
| `api.oauth.createState` | `http:fetch` |
| `api.oauth.getRedirectUri` | `http:fetch` |
| `api.proxy.fetch` | `http:proxy` |
| `api.proxy.connect` | `http:proxy` |
| `api.proxy.accounts` | `http:proxy` |
| `api.proxy.disconnect` | `http:proxy` |
| `api.ui.setActions` | none |
| `api.ui.refreshRowBadges` | none |
| `api.ui.setListFilters` | `ui:message-list` |
| `api.ui.setDayLabels` | `ui:calendar-action` |
| `api.ui.setPages` | `ui:app-page` |
| `api.ui.openPage` | `ui:app-page` |
| `api.ui.openCalendar` | none |
| `api.ui.openTask` | none |
| `api.ui.openEmail` | `email:read` |
| `api.ui.setSectionTitle` | `ui:sidebar-widget` |
| `api.ui.setSidePanel` | `ui:sidebar-widget` |
| `api.ui.setPanel` | none |
| `api.sieve.isSupported` | `filters:read` |
| `api.sieve.getActiveScript` | `filters:read` |
| `api.sieve.validateScript` | `filters:write` |
| `api.sieve.regenerate` | `filters:write` |
| `api.calendar.listCalendars` | `calendar:read` |
| `api.calendar.getEvents` | `calendar:read` |
| `api.calendar.getEvent` | `calendar:read` |
| `api.calendar.createEvent` | `calendar:write` |
| `api.calendar.updateEvent` | `calendar:write` |
| `api.tasks.list` | `tasks:read` |
| `api.tasks.get` | `tasks:read` |
| `api.tasks.create` | `tasks:write` |
| `api.tasks.update` | `tasks:write` |
| `api.tasks.setComplete` | `tasks:write` |
| `api.tasks.acknowledgeAlert` | `tasks:write` |
| `api.tasks.delete` | `tasks:write` |
| `api.templates.list` | `templates:read` |
| `api.templates.get` | `templates:read` |
| `api.templates.create` | `templates:write` |
| `api.templates.update` | `templates:write` |
| `api.templates.delete` | `templates:write` |
| `api.identities.update` | `identity:write` |
| `api.email.get` | `email:read` |
| `api.email.list` | `email:read` |
| `api.email.search` | `email:read` |
| `api.mailboxes.list` | `email:read` |
| `api.email.getAttachment` | `email:blob-read` |
| `api.email.getRaw` | `email:blob-read` |
| `api.email.move` | `email:write` |
| `api.email.archive` | `email:write` |
| `api.email.forward` | `email:forward` |
| `api.compose.open` | `compose:open` |
| `api.compose.reply` | `compose:open` |
| `api.drafts.create` | `email:write` |
| `api.notifications.show` | `ui:notifications` |
| `api.composer.getBody` | `compose:read` |
| `api.composer.getSnapshot` | `compose:read` |
| `api.composer.readAttachment` | `email:blob-read` |
| `api.composer.getSelection` | `compose:read` |
| `api.composer.replaceSelection` | `compose:write` |
| `api.composer.replaceBody` | `compose:write` |
| `api.composer.attach` | `email:blob-write` |
| `api.composer.registerChecker` | `compose:check`, or `compose:read` for an on-demand checker |
| `api.composer.updateChecker` | `compose:check`, or `compose:read` for an on-demand checker |
| `api.composer.recheck` | `compose:check`, or `compose:read` for an on-demand checker |
| `api.composer.unregisterChecker` | `compose:check`, or `compose:read` for an on-demand checker |
| `api.composer.getCheckText` | `compose:check`, or `compose:read` for an on-demand checker |
| `api.composer.setAnnotations` | `compose:check`, or `compose:read` for an on-demand checker |

<!-- /generated:api-permissions -->

## Accounts and API keys

A plugin that talks to another service with a password or an API key uses
the secret proxy. The secret stays on the webmail server; the plugin names a
credential, and the server adds the secret to the request and only sends it
to the credential's origin.

```json
"credentials": {
  "nextcloud": { "label": "Nextcloud", "scope": "user", "inject": { "type": "basic" } },
  "openai": {
    "label": "OpenAI", "scope": "admin", "inject": { "type": "bearer" },
    "secretKey": "apiKey", "originKey": "baseUrl"
  }
}
```

- `scope: "user"`: each user connects their own account in a dialog the host
  draws. `origin` fixes the server; without it the user enters the address.
- `scope: "admin"`: the admin enters the secret in a `configSchema` field of
  type `secret` (`secretKey`). The origin is fixed (`origin`) or read from
  another config field (`originKey`); `usernameKey` names the field with a
  user name for basic auth.
- `inject`: `bearer` (`Authorization: Bearer <secret>`), `basic`
  (`Authorization: Basic` with the user name), `header` (`{ "type": "header",
  "name": "x-api-key", "prefix": "" }`) or `none`.

At most 8 credentials; ids are lowercase letters, digits and hyphens starting
with a letter (up to 40), labels up to 80 characters. Origins must be
https. The `http:proxy` permission covers all of it.

```js
// let the user connect an account (user scope)
const { connected, origin } = await api.proxy.connect('nextcloud', { mode: 'password', server: 'https://cloud.example.com' });
await api.proxy.accounts()
// [{ credentialId, scope: 'user', origin, username, connected },
//  { credentialId, scope: 'admin', connected }]   admin: set up or not, no address
await api.proxy.disconnect('nextcloud')

// make a request
const res = await api.proxy.fetch('openai', 'https://api.openai.com/v1/models', { responseType: 'json' });
// { status, ok, headers, body }

// stream an answer, with upload progress and a way to stop
const ctrl = new AbortController();
const stream = await api.proxy.fetch('openai', url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
  responseType: 'stream', signal: ctrl.signal,
  onProgress: (loaded, total) => {},
});
const reader = stream.body.getReader();
```

- `responseType` is `text` (default), `json`, `arraybuffer` or `stream`.
  Buffered answers are limited to 25 MB; use `stream` for more (downloads
  up to 2 GB pass through).
- Request bodies (string, `ArrayBuffer`, `Uint8Array` or `Blob`) are limited
  to 100 MB; upload larger files in chunks. `onProgress` reports upload
  progress.
- Methods: `GET HEAD POST PUT PATCH DELETE` and the WebDAV methods
  `PROPFIND PROPPATCH MKCOL COPY MOVE REPORT SEARCH LOCK UNLOCK`.
- The proxy sets authentication, cookies, `Origin` and the transport
  headers itself; a plugin can't set them. It passes back
  `content-type`, `etag`, `retry-after`, rate limit headers and a few more.
- Limits: 300 requests a minute per user and plugin, 8 at once per user, 10
  minutes per request, 3 redirects. Redirects are followed only on the
  credential's own server (with the body for 307/308); when one happened,
  `res.headers['x-bulwark-url']` is where the request ended up, which CalDAV
  discovery needs. A redirect to another server is refused. `res.proxyError` is set when the proxy
  itself refused the request (for example a rate limit or a blocked
  address).
- The proxy only reaches public addresses. To reach a server on the local
  network (a Nextcloud on the LAN), the admin lists its origin in
  `PLUGIN_PROXY_PRIVATE_ORIGINS` (comma separated, e.g.
  `http://nextcloud.lan:8080`); those may also be plain http.

**Sign-in flows.** For services that hand out an app password through a
browser login (Nextcloud Login Flow v2), connect with `mode: 'signin'`: the
user only approves the server in the host dialog. Then poll the service
through the proxy with `capture: { secret: 'appPassword', username: 'loginName' }`:
when the answer contains those JSON fields, the proxy stores them as the
credential and returns the rest of the answer with `captured: true`. The
plugin never sees the password. See `nextcloud/src/lib/connection.js`.

## Testing

**Unit tests.** Keep logic in plain modules under `src/lib/` and test them
with Vitest (`<plugin>/test/*.test.mjs`, run with `npm test`). For code that
calls `api`, use the fake in `test-utils/fake-api.mjs`:

```js
import { fakeApi } from '../../test-utils/fake-api.mjs';
const api = fakeApi({
  settings: { folder: '/Mail' },
  handlers: { 'proxy.fetch': async () => ({ status: 200, ok: true, headers: {}, body: '[]' }) },
});
await plugin.activate(api);
expect(api.calls('ui.setActions')).toHaveLength(1);
```

Every namespace exists on the fake; a call is recorded and returns what the
matching handler returns. `storage`, `i18n` and `plugin.settings` work for
real, and `api.setLocale()` and `api.changeSettings()` fire the listeners.

**End-to-end tests.** `e2e/helpers.mjs` drives a running webmail with
Playwright: `adminApi()` signs in to the admin API (set
`BULWARK_ADMIN_PASSWORD`), `installPlugin(api, id)` uploads `<id>/<id>.zip`
and turns it on for everyone, `preparePage`, `signIn` and
`waitForPlugin(page, id)` get a page ready, and `uninstallPlugin` cleans up.
Specs live in `<plugin>/e2e/` and run with `npm run test:e2e`.
`BULWARK_URL` (default `http://localhost:3100`), `BULWARK_USER` and
`BULWARK_PASSWORD` point it at your setup.

**Test services.** `test-env/` starts Stalwart (mail, calendar, contacts,
files), Nextcloud, Paperless-ngx, Vikunja, a mock server for paid APIs and,
optionally, Ollama in Docker, seeded with test data. See
[test-env/README.md](test-env/README.md).

## Security notes

What a plugin can do is what its permissions and the host API allow, and
nothing more:

- It can't read the webmail's cookies, storage or page, or the user's
  password. It never gets the JMAP session.
- It can't reach the network except through `api.http.fetch` (listed
  origins), `api.http.post` (listed webmail routes) and `api.proxy`
  (declared credentials).
- Forms can't be submitted from a plugin frame, and links open through
  `api.ui.openExternalUrl` in a new tab only.
- HTML a plugin hands the host (message bodies, signatures, templates,
  compose bodies) is sanitised.
- Mail content is behind `email:read`, which covers every message in the
  account, not only the open one. Ask for what you need and say why in your
  description.

Never put a secret in `settingsSchema` or `api.storage`. Both are kept
unencrypted in the browser, where anyone with access to the device can read
them, and the plugin would hand the secret to whatever it calls. Use a
credential instead: the secret stays on the server and only reaches its own
origin.

**The privileged tier** exists for end-to-end encryption plugins that must
run WebCrypto and IndexedDB in their own frame. A plugin asks for it with
`"tier": "privileged"` and the `crypto:full` permission, and gets it only
when an admin installed it; the bundle is signed at install time and checked
on every download. A user upload is never privileged, and a privileged
request that fails a check is refused, not downgraded. The frame is then
same-origin with the webmail, which is the same as full access, so only
install audited code this way. `api.jmap.fetchBlob`, `sendRaw`, `submitRaw`,
`importRaw`, `api.upfiles.save` and `api.crypto.*` work only in this tier.
