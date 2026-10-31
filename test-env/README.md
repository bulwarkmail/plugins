# Plugin test environment

Local Docker services for testing the Bulwark plugins end to end: Stalwart for
mail, JMAP and CalDAV, Nextcloud, Paperless-ngx, Vikunja, Donetick, a mock
server for the paid APIs (Anthropic, OpenAI, Todoist, 17TRACK, DHL) and,
optionally, Ollama.
Everything runs on your machine.

## Start and stop

```
# Windows PowerShell
.\test-env\up.ps1            # everything except Ollama
.\test-env\up.ps1 -WithAI    # plus Ollama and the qwen2.5:0.5b model
.\test-env\down.ps1          # stop, keep the data
.\test-env\down.ps1 -Reset   # stop and delete all volumes and .secrets

# bash
./test-env/up.sh [--with-ai]
./test-env/down.sh [--reset]
```

`up` builds the Stalwart image, starts the containers, waits until they are
healthy, runs every seed script and prints the URLs and credentials. It is
safe to run again: the seeds look for what already exists and don't create
duplicates. To only re-seed, run `python test-env/seed/seed_all.py [--with-ai]`.

You need Docker with Compose v2 and Python 3.8 or newer (standard library only)
on the host. The first `up` fetches `stalwart/stalwart-cli` with
`stalwart/prepare-stalwart-cli.sh`, so on Windows `bash` (Git Bash) must be on
the PATH.

Tokens and app passwords are generated at seed time and written to
`test-env/.secrets/<service>.json` (gitignored). `-Reset` / `--reset` deletes
them together with the volumes.

## Services

| Service | URL | Image | Users | Secrets file |
| --- | --- | --- | --- | --- |
| Stalwart (JMAP, CalDAV, SMTP) | http://localhost:18025, SMTP submission `localhost:11587` | built from `stalwart/` (`stalwartlabs/stalwart:v0.16`) | `alice@example.org`, `bob@example.org`, `carol@example.org`, password `test-pass-123` | `caldav.json` |
| Nextcloud | http://localhost:18080 | `nextcloud:34.0.4-apache` | `admin` / `admin-pass-123`, `alice` / `alice-pass-123` plus an app password | `nextcloud.json` |
| Paperless-ngx | http://localhost:18010 | `ghcr.io/paperless-ngx/paperless-ngx:3.2.1`, `redis:8.2.10-alpine` | `admin` / `admin-pass-123` plus an API token | `paperless.json` |
| Vikunja | http://localhost:18456 | `vikunja/vikunja:2.6.0` | `alice` / `alice-pass-123` plus an API token | `vikunja.json` |
| Donetick | http://localhost:18021 | `donetick/donetick:v0.1.85` | `alice` / `alice-pass-123` plus an access token | `donetick.json` |
| Mock APIs | http://localhost:18099 | `python:3.13.16-alpine` | fixed keys, see [mocks/README.md](mocks/README.md) | none |
| Ollama (profile `ai`) | http://localhost:11434 | `ollama/ollama:0.40.3` | no auth | `ollama.json` |

All containers are named `bpt-<service>` and share the compose network
`bulwark-plugins-test_default`.

### Stalwart

Built from `stalwart/`. On first start it creates the domain `example.org`, the
accounts above and a `team` group that carol belongs to. `seed/seed_mail.py`
sends alice a few test messages over SMTP submission: an invoice with a PDF,
a meeting request, a shipping notice with tracking numbers (one DHL, one UPS,
both known to the mock server), a newsletter with `List-Unsubscribe`, and a
German mail.

### CalDAV tasks (VTODO)

Stalwart's CalDAV accepts VTODO, so there is no separate CalDAV server.
`seed/seed_caldav.py` creates a VTODO-only calendar called "Tasks" for alice
with three tasks (two open, one completed):

- task list: http://localhost:18025/dav/cal/alice%40example.org/tasks/
- calendar home: http://localhost:18025/dav/cal/alice%40example.org/
- principal: http://localhost:18025/dav/pal/alice%40example.org/
- discovery: http://localhost:18025/.well-known/caldav

Log in with Basic auth as `alice@example.org` / `test-pass-123`. The default
calendar (`.../default/`) accepts VTODO as well.

Stalwart v0.16 does not offer the JMAP Tasks capability
(`urn:ietf:params:jmap:tasks`), so a "Bulwark tasks over JMAP" target can't be
tested against it. Use the CalDAV list instead.

### Nextcloud

SQLite, installed automatically on first start. `trusted_domains` contains
`localhost`, `localhost:18080`, `127.0.0.1`, `127.0.0.1:18080`, `bpt-nextcloud`
and `nextcloud`, so both the host and other containers can reach it.

Seeded for alice:

- `Documents/Welcome.txt`, `Documents/Report 2026.pdf`, `Documents/Invoices/invoice-2026-10.pdf`
- `Photos/blue.png`, `Photos/orange.png`
- `Projects/Bulwark/notes.txt` (UTF-8 umlauts), `Projects/Bulwark/plan.md`
- `Large/random-60mb.bin`, 60 MB of random data for chunked transfer tests
- a public share link on `Documents/Report 2026.pdf` (URL in `nextcloud.json`)
- an app password, used as Basic auth password with user `alice`

Useful endpoints:

- WebDAV: `http://localhost:18080/remote.php/dav/files/alice/`
- Login Flow v2: `POST http://localhost:18080/index.php/login/v2`
- OCS shares: `http://localhost:18080/ocs/v2.php/apps/files_sharing/api/v1/shares` (header `OCS-APIRequest: true`)

The webmail calls Nextcloud through its own server-side proxy, so Nextcloud
needs no CORS setup.

### Paperless-ngx

SQLite, Redis for the task queue, OCR set to `skip` so the seeded PDFs, which
already have a text layer, are consumed in seconds. Seeded:

- tags Invoice, Contract, Tax, Inbox, Bulwark test
- correspondents ACME Hosting, Stadtwerke Hildesheim, Finanzamt, Bob Example
- document types Invoice, Contract, Letter, Receipt
- storage path "By correspondent"
- six documents, uploaded through `POST /api/documents/post_document/`. The
  seed waits until they are consumed.

The API token goes in the header `Authorization: Token <token>`.

### Vikunja

SQLite. Registration is open. Seeded: user alice, an API token with every
permission (`Authorization: Bearer tk_...`), the project "Bulwark inbox" with
one task. The API is at `http://localhost:18456/api/v1`.

### Donetick

SQLite, sign-up open. Seeded: user alice, an access token and one chore. The
external API is at `http://localhost:18021/eapi/v1` and takes the token in the
header `secretkey: dt_...`; it can list and create chores but has no projects
and no priority.

### Mock APIs

One Python file, `mocks/server.py`. It serves the Anthropic Messages API, an
OpenAI-compatible chat API, Todoist API v1, 17TRACK v2.2 and the DHL Unified
Tracking API, with fixed data and a tracking number whose status changes with
every poll. Routes, keys and data are in [mocks/README.md](mocks/README.md).
Base URLs for plugin settings:

- Anthropic: `http://localhost:18099/anthropic` (key `test-anthropic-key`)
- OpenAI-compatible: `http://localhost:18099/openai/v1` (key `test-openai-key`)
- Todoist: `http://localhost:18099/todoist/api/v1` (token `test-todoist-token`)
- 17TRACK: `http://localhost:18099/17track/track/v2.2` (token `test-17track-token`)
- DHL: `http://localhost:18099/dhl/track/shipments` (key `test-dhl-key`)

### Ollama (optional)

Only started with `-WithAI` / `--with-ai` (compose profile `ai`). The image is
large (about 9 GB, it ships the GPU runtimes), and the seed pulls
`qwen2.5:0.5b` (about 400 MB) into the `ollama-models` volume. The
OpenAI-compatible endpoint is `http://localhost:11434/v1/chat/completions`.
Any API key works. Set `OLLAMA_PORT` to use a different host port if a local
Ollama already listens on 11434, and `OLLAMA_MODEL` to seed another model.

## Reaching the services from the webmail

Plugins don't call these services from the browser. They go through the
webmail's plugin proxy, which only connects to private addresses (localhost
included) when the exact origin is listed in `PLUGIN_PROXY_PRIVATE_ORIGINS`.
For a webmail running on the host (for example `npm run dev`), put this in its
`.env.local`:

```
PLUGIN_PROXY_PRIVATE_ORIGINS=http://localhost:18025,http://localhost:18080,http://localhost:18010,http://localhost:18456,http://localhost:18021,http://localhost:18099,http://localhost:11434
```

The value is compared by origin, so use exactly the URLs you enter in the
plugin settings: `http://127.0.0.1:18080` is not the same origin as
`http://localhost:18080`. If the webmail runs in a container on the
`bulwark-plugins-test_default` network, use the container names instead
(`http://bpt-nextcloud`, `http://bpt-paperless:8000`, `http://bpt-vikunja:3456`,
`http://bpt-donetick:2021`, `http://bpt-mocks:18099`, `http://bpt-ollama:11434`,
`http://bpt-stalwart:8080`)
both in the plugin settings and in `PLUGIN_PROXY_PRIVATE_ORIGINS`.

## Resetting

- Everything: `down -Reset` / `down --reset`, then `up` again.
- Mock server state only (Todoist tasks, tracking registrations and poll
  counters): `curl -X POST http://localhost:18099/__reset`, or restart
  `bpt-mocks`.
- One service: `docker compose -f test-env/docker-compose.yml rm -sf <service>`,
  remove its volumes (`docker volume ls | grep bulwark-plugins-test`), delete
  its file in `.secrets/`, then `up`.

## Ports

18025 (Stalwart HTTP), 11587 (Stalwart SMTP submission), 18080 (Nextcloud),
18010 (Paperless), 18456 (Vikunja), 18021 (Donetick), 18099 (mocks), 11434
(Ollama). They stay clear of 3000, 3100, 5432 and 8080.
