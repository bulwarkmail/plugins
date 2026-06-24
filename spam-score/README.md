# Spam Score

Adds a **Spam Analysis** section to a message's **More details** panel, built
entirely from the message's own spam-filter headers.

When you expand *More details* on a message that was scored by a spam filter,
this plugin shows a colour-coded breakdown:

- **Verdict** — Clean / Suspicious / Spam
- **Score** — the filter score and the spam threshold (e.g. `1.50 / 5.00`)
- **Level** — SpamAssassin's `★` level
- **Action** — the Rspamd action, when present (e.g. *add header*, *reject*)
- **AI verdict** — the `X-Spam-LLM` verdict and explanation, when present
- **Header** — the exact raw header line the score was read from

## How it works

The plugin demonstrates two extension points:

### 1. The `email-details-section` slot

The host mounts this slot under every category of the expanded *More details*
panel, and once more as a brand-new bottom category. Each mount passes a
`category` prop:

`recipients_routing`, `authentication_security`, `identifiers_threading`,
`message_properties`, `mailing_list`, or `null` for the dedicated bottom
section.

The plugin's `shouldShow` returns `true` for exactly **one** of those, so the
section renders in a single place. By default that's its own new section; set
**Show under "Authentication & Security"** to tuck it under the existing
security category instead.

### 2. Reading raw headers

The `EmailReadView` handed to email slots now carries:

- `headers` — the parsed header map (`Record<string, string | string[]>`)
- `source` — the full message source (same text as *View source*)

This plugin reads the spam headers straight off `email.headers`
(`X-Spam-Status`, `X-Spam-Score`, `X-Spam-Level`, `X-Spam-Flag`,
`X-Rspamd-Score`, `X-Spamd-Result`, `X-Spam-LLM`) — no host-side spam parsing
required. The same data could be parsed out of `email.source`.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Show under "Authentication & Security" | off | Render beneath the existing security category instead of as its own section. Falls back to its own section on messages that have no auth results. |
| Show for clean mail too | on | Show the section even when the message scored below the threshold. Turn off to only surface spam / suspicious mail. |

## Permissions

- `email:read` — to read the message headers
- `ui:email-details` — to render in the *More details* panel

## Build

```bash
npm install
npm run build      # bundles src/index.js → dist/index.js
npm run package    # build + zip manifest.json + index.js → spam-score.zip
```
