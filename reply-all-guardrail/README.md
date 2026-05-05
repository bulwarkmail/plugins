# Reply-All Guardrail

Asks for confirmation before reply-all (and optionally before any send) when
the recipient count crosses a threshold. Catches the classic "I meant to reply
to one person, not the entire mailing list" mistake.

## Threshold sources

Two sources are merged; the **smaller value wins** so admins can only tighten
the floor:

1. **Admin-managed `forceThreshold`** — written via:
   ```
   PUT /api/admin/plugins/reply-all-guardrail/config
   { "key": "forceThreshold", "value": 5 }
   ```
   Set to `0` (or leave blank) to disable the floor.
2. **Per-user `threshold`** — set in the plugin's settings panel. Defaults to
   `5`.

## Settings

| Key            | Default | Effect                                                         |
| -------------- | ------- | -------------------------------------------------------------- |
| `threshold`    | `5`     | Recipient count that triggers the prompt.                      |
| `warnOnSend`   | `true`  | Apply the same threshold to every outgoing send, not only reply-all. |
| `excludeSelf`  | `true`  | Exclude addresses you have sent from in the past.              |

## Permissions

- `email:read`   — required by `onBeforeReplyAll`.
- `email:send`   — required by `onBeforeEmailSend`.
- `admin:config` — read the org-wide `forceThreshold`.

## Hooks used

- `onBeforeReplyAll` — counts `From + To + Cc` on the original message and
  prompts before the composer opens. Returning `false` cancels.
- `onBeforeEmailSend` — counts `To + Cc + Bcc` on the outgoing email and
  prompts before the JMAP / S/MIME pipeline. Returning `false` cancels.

## Behaviour

The plugin captures the active sender address from outgoing sends and stores
it under `plugin:reply-all-guardrail:myAddresses` in localStorage. When
`excludeSelf` is on, those addresses are not counted toward the threshold so
the dialog reflects the number of *other* people who would receive the
message.

The host enforces a 5 s timeout on intercept hooks. The dialog therefore
auto-cancels at 4.5 s if the user does not respond — fail-closed behaviour
appropriate for a guardrail. The user can simply click Reply All / Send again.

When `warnOnSend` is on alongside the reply-all gate, a fresh reply-all that
exceeds the threshold may show **two** dialogs (one before the composer,
one before send). This is intentional: the first prompt protects against
accidental reply-all on a large thread, the second protects against
recipients added inside the composer. Disable `warnOnSend` if you only want
the first.

## Build & install

```bash
npm install
npm run build
cp manifest.json dist/
cd dist && zip -r ../reply-all-guardrail.zip manifest.json index.js
```

Upload `reply-all-guardrail.zip` via Admin → Plugins.

## Notes

- Pure DOM dialog — no React, no runtime dependencies.
- Dark mode is detected via the host's `.dark` class on `<html>` plus a
  luminance fallback so third-party themes are also covered.
- **Cancel** is the default focus target; **Esc** or clicking the overlay
  cancels; **Enter** confirms.
- `i18n` ships English and German out of the box.
