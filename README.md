# Bulwark plugins

Plugins for the [Bulwark webmail](https://github.com/bulwarkmail/webmail),
with the tools to build and test them:

- one folder per plugin, each with its manifest, source, tests and a built ZIP;
- `scripts/build.mjs`, which bundles and packages a plugin;
- `scripts/gen-docs.mjs`, which refreshes the reference tables in the guide;
- `test-utils/` and `e2e/`, helpers for unit and end-to-end tests;
- `test-env/`, Docker services to test against (Stalwart, Nextcloud,
  Paperless-ngx, Vikunja, mock APIs, Ollama);
- [WRITING_PLUGINS.md](WRITING_PLUGINS.md), the guide for plugin authors, with
  screenshots of every place a plugin can show something in `docs/screenshots/`.

## Plugins

| Plugin | What it does | Permissions |
|---|---|---|
| [ai-assistant](ai-assistant/) | Writes, rewrites, translates and proofreads mail and summarises messages with an OpenAI-compatible service or Anthropic; text is only sent when you click | `email:read` `http:proxy` `admin:config` `ui:email-banner` `ui:composer-toolbar` `ui:settings-section` |
| [auto-tag](auto-tag/) | Tags incoming mail by rules (newsletters, invoices, GitHub notifications, your own) | `email:read` `email:write` |
| [birthdays](birthdays/) | Upcoming birthdays from your contacts in the sidebar, with reminders, a quick greeting and optional calendar events | `contacts:read` `ui:sidebar-widget` `ui:notifications` `compose:open` `calendar:read` `calendar:write` |
| [calendar-agenda](calendar-agenda/) | An agenda of your next events in the sidebar | `calendar:read` `ui:sidebar-widget` `ui:email-details` `ui:app-top-banner` |
| [email-stats](email-stats/) | Counts the mail you open and send during a session, in the sidebar | `email:read` `ui:sidebar-widget` |
| [email-to-task](email-to-task/) | Turns a message into a task in Bulwark, Vikunja, Todoist or a CalDAV list, with a link back and a due date from the text | `email:read` `email:write` `email:render-takeover` `tasks:read` `tasks:write` `http:proxy` `ui:message-list` `ui:toolbar` `ui:observe` `ui:keyboard` `admin:config` |
| [external-link-warning](external-link-warning/) | Asks before opening links to domains that aren't on a trusted list | `admin:config` |
| [external-mail-warning](external-mail-warning/) | Retired: Bulwark 1.19 does this itself (Organisation > Security). On older versions, asks before sending outside your safe domains and marks mail from outside with a banner | `email:read` `email:send` `identity:read` `ui:email-banner` `admin:config` |
| [gravatar](gravatar/) | Sender pictures from Gravatar | `email:read` `http:fetch` |
| [hello-world](hello-world/) | The smallest example: logs app and mail events to the console | `email:read` |
| [impersonation-notice](impersonation-notice/) | A banner while an admin is signed in as another user (Stalwart master user), with a way back | `account:read` `auth:emit` `ui:app-top-banner` `admin:config` |
| [jitsi-meet](jitsi-meet/) | An "Add Jitsi Meeting" button in the event form | `calendar:read` `calendar:write` `ui:calendar-action` `http:post` |
| [libravatar](libravatar/) | Sender pictures from Libravatar | `email:read` `http:fetch` |
| [nextcloud](nextcloud/) | Attach files from Nextcloud, send large files as share links, save attachments and messages there | `http:proxy` `ui:settings-section` `ui:composer-toolbar` `email:read` `email:send` `email:blob-write` `email:blob-read` `ui:toolbar` `ui:app-page` `compose:open` `ui:download-file` |
| [outlook-style-headers](outlook-style-headers/) | Outlook-style From / Sent / To / Subject block above quoted replies and forwards | `email:send` |
| [paperless](paperless/) | Send attachments and messages to Paperless-ngx, find documents there and attach them to new mail | `http:proxy` `admin:config` `email:read` `email:blob-read` `email:blob-write` `compose:open` `ui:message-list` `ui:toolbar` `ui:app-page` `ui:settings-section` `ui:notifications` `ui:download-file` |
| [plugin-template](plugin-template/) | A starting point for a new plugin | `email:read` `ui:sidebar-widget` |
| [quick-notes](quick-notes/) | Notes per message, shown again when you open it | `email:read` `ui:email-banner` `ui:email-details` |
| [reply-all-guardrail](reply-all-guardrail/) | Asks before a reply-all (or any send) to more recipients than a limit | `email:read` `email:send` `admin:config` |
| [slot-showcase](slot-showcase/) | For plugin authors: a labelled box in every UI slot and a button on every action surface | every `ui:*` permission, plus `account:read` `email:read` `email:send` `compose:open` `calendar:read` `contacts:read` `tasks:read` `files:read` |
| [smime](smime/) | S/MIME signing and encryption, verifying and decrypting, with keys kept in the browser (privileged tier) | `crypto:full` `email:blob-read` `email:raw-send` `email:render-takeover` `email:read` `email:send` `smime:read` `ui:composer-toolbar` `ui:email-banner` `ui:settings-section` `app:lifecycle` |
| [spam-score](spam-score/) | A spam analysis section in the message details, from the spam filter's headers | `email:read` `ui:email-details` |
| [translate](translate/) | Translates received mail with MyMemory or LibreTranslate | `email:read` `ui:email-banner` `http:post` |

What each permission allows is listed in
[WRITING_PLUGINS.md](WRITING_PLUGINS.md#permissions).

## Build

Install the development tools once with `npm ci` (esbuild, JSZip, Vitest,
React Testing Library, jsdom, Playwright). Plugins are written as ES modules in `<plugin>/src/`
and bundled into one CommonJS file with React and the host API left
external. From the repository root:

```
node scripts/build.mjs                  # every plugin
node scripts/build.mjs nextcloud smime  # some plugins
node scripts/build.mjs --check          # fail if a committed ZIP is out of date
```

Each build writes `<plugin>/<plugin>.zip` with `manifest.json` and `index.js`
at its root. That ZIP is what the admin upload and the user upload take.

The extension directory doesn't take the ZIP. It builds each plugin from its
folder alone with `npm ci --ignore-scripts` and `npm run build`, so a
plugin's own package.json needs a build script that works without the rest
of the repository and writes `dist/index.js`. CI checks both:

```
npm run check                           # manifests, versions, lockfiles and publish.json
npm run build:isolated                  # each plugin on its own, as the directory builds it
```

## Test

```
npm test                                # unit tests (Vitest): <plugin>/test/*.test.mjs
npm run test:e2e                        # Playwright: <plugin>/e2e/*.spec.mjs and e2e/*.spec.mjs
./test-env/up.sh                        # or .\test-env\up.ps1: the Docker test services
```

Unit tests import a plugin's logic directly and use
`test-utils/fake-api.mjs` for the `api` object. End-to-end tests need a
running webmail (default `http://localhost:3100`, set `BULWARK_URL`) signed
in to the Stalwart from `test-env`, and the admin password in
`BULWARK_ADMIN_PASSWORD`; they install the plugin's ZIP through the admin
API. See [test-env/README.md](test-env/README.md) for the services, users
and the `PLUGIN_PROXY_PRIVATE_ORIGINS` value the webmail needs to reach them.

## Install

- **Admin:** turn on plugins in the webmail's admin dashboard and upload the
  ZIP under Plugins. Choose whether it is on for everyone or each user turns
  it on in Settings > Plugins.
- **User:** upload the ZIP in Settings > Plugins, if the admin allows it. The
  webmail asks to confirm the plugin's permissions, and may wait for the
  admin to approve it.
- **Development:** start the webmail with `PLUGIN_DEV_DIR` set to this
  repository. It loads every plugin folder from source and rebuilds it on
  each page load.

## Releasing

Plugins reach the [extension directory](https://extensions.bulwarkmail.org)
through a tag `<plugin>@<version>`. The directory builds the plugin from the
tagged commit, and a reviewer approves each version before it is published.

1. Merge the changes into main.
2. On main, raise the version, commit and tag:

   ```
   npm run release -- smime 1.4.0                # or smime minor, smime patch
   npm run release -- smime minor gravatar patch # several at once
   ```

   This sets the version in manifest.json, package.json and
   package-lock.json, rebuilds the ZIP, runs the checks, commits
   `chore: release smime 1.4.0` and tags it `smime@1.4.0`. It pushes nothing.
3. Push main, then each tag it printed on its own. GitHub starts no workflow
   when a push brings more than three tags.

   ```
   git push origin main
   git push origin smime@1.4.0
   ```

The Publish workflow then checks that the plugin is in publish.json, that the
manifest has the tag's version and that the commit is on main, runs the
plugin's tests and build, and submits it. The job fails when the directory's
build or checks fail. When a submission fails, fix it and release the next
patch version rather than moving the tag.

publish.json lists the folders that are published and the ones that are not,
with the reason. A new plugin goes into one of the two, or CI fails. Before
its first release, a directory admin adds a trusted publisher for it:
repository bulwarkmail/plugins, workflow `.github/workflows/publish.yml`,
environment `extensions`, the folder name as subpath, tags only.

A plugin that uses the UI kit (`@plugin-host/ui`), the composer API or the
other plugin features of webmail 1.15.0 needs `"minAppVersion": "1.15.0"`
or later; the check fails otherwise.

## Writing a plugin

Start from `plugin-template/` or `hello-world/` and read
[WRITING_PLUGINS.md](WRITING_PLUGINS.md). After the webmail's hook or slot
catalogue changed, refresh the tables in the guide:

```
node scripts/gen-docs.mjs               # set BULWARK_WEBMAIL if the webmail isn't in ../jmap-webmail-plugins
```

## License

All plugins in this repository are released under the
[GNU Affero General Public License v3](LICENSE).
