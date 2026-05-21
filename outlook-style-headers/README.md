# Outlook-style Quote Headers

Replaces the default reply/forward header in the Bulwark Mail composer with
the layout Outlook uses, including `To` and `Cc` and a long-form localized
`Sent:` datetime.

## Before

Reply / Reply-all:
```
On May 16, 2026, John Smith <john@example.com> wrote:
> Quoted message
```

Forward:
```
---------- Forwarded message ----------
From: John Smith <john@example.com>
Date: May 16, 2026
Subject: Headers

> Quoted message
```

## After

```
─────────────────────────────────────────────
From:    John Smith <john@example.com>
Sent:    Friday, May 16, 2026 2:30 PM
To:      Linus <linus@example.com>
Cc:      Others <others@example.com>
Subject: Headers

<original message follows, no blockquote indent>
```

## Settings

- **Apply to** — `reply` / `forward` / `both` (default `both`).
- **Bold field labels** — render `From / Sent / To / Cc / Subject` in bold.
- **Thin rule above the header** — adds a `<hr>` above the block.

## How it works

The host fires the `onBuildQuoteHeader` transform hook when a reply/forward
composer is opened. This plugin returns a `{html, text, wrapInBlockquote: false}`
that replaces the host's default header. The original message is then spliced
in directly after, without a blockquote.

## Build

```
npm install
npm run build
```

The bundled plugin lives in `dist/index.js`.
