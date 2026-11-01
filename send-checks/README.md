# Send Checks

Checks a message before it is sent and warns or stops the send when it
contains something your organisation doesn't want to leave by mail: bank
account numbers (IBAN), payment card numbers, keywords, your own patterns,
or attachments of a type or size you don't allow.

Needs Bulwark 1.20 or later. Plugins don't run in Bulwark Lite.

## What users see

- **Warn**: a dialog "Check before sending" lists what was found, and the
  user picks **Send anyway** or **Go back**.
- **Block**: a dialog "This message can't be sent" lists what was found;
  the message stays in the composer. When a blocking rule and a warning
  match at once, the alert lists both.
- A match is shown with its rule and masked: "IBAN DE89 … 3000",
  "Card number ending 4242", "The word “confidential”", "Customer number:
  KD…56", "setup.pdf: file type not allowed (application/x-msdownload)".
  The full number is never shown.
- When a rule counted only because a recipient is outside the
  organisation, the dialog says so.
- A blocked file type or a file over the size limit is refused as soon as
  it is attached ("This file can't be attached"), when the attachment rule
  blocks and doesn't depend on the recipients. Otherwise it is checked at
  Send.

The dialogs are in English and German.

## What is checked

- the subject;
- the text the user wrote, without the quoted original of a reply or
  forward and without the signature (so an IBAN in the message being
  answered doesn't warn on every reply);
- attachment names;
- the text of text attachments (txt, csv, json, xml, ics, vcf, md, log, html
  and other `text/*` files), the first 1 MB of each;
- each attachment's type, by its extension and by its content, and its
  size. Images pasted into the text count for the size limit only.

It runs for every send of a user's mail in Bulwark: the composer (also for
scheduled sends and with undo send), quick reply, and plugins that forward
a message (`api.email.forward`). S/MIME and PGP sends are checked too: the
composer runs the check before the crypto plugin takes the send over.

## What isn't checked

- Mail sent from other mail programs over IMAP and SMTP (Outlook,
  Thunderbird, phones). The check runs in Bulwark, not on the mail server.
- Calendar invitations and replies to them: the mail server sends those
  when an event is saved.
- Read receipts, List-Unsubscribe mails and phishing reports, which
  Bulwark sends on its own.
- Messages a plugin builds and sends itself with `api.jmap.sendRaw` outside
  the composer.
- The quoted original of a reply or forward.

## Settings (admin)

Set them on the plugin's page in the admin dashboard (Extensions >
Plugins > Send Checks). They apply to every user; they can't be set per
domain or group.

| Key | Default | Effect |
| --- | --- | --- |
| `ibanAction` | `warn` | IBANs that pass the mod-97 check digit test (with the right length for the country): `off`, `warn` or `block`. |
| `ibanExternalOnly` | `true` | Check IBANs only when a recipient is outside the organisation. |
| `cardAction` | `warn` | Card numbers: 13 to 19 digits, together or grouped with spaces or dashes, that pass the Luhn check and start like a card network's number: `off`, `warn` or `block`. |
| `cardExternalOnly` | `true` | Check card numbers only when a recipient is outside the organisation. |
| `keywords` | empty | One word or phrase per line, any case. A keyword that starts and ends with a letter or digit matches whole words only ("secret" doesn't match "secretary"). Lines starting with `#` are ignored. |
| `keywordAction` | `warn` | `warn` or `block`. |
| `keywordExternalOnly` | `false` | Only outside the organisation. |
| `patterns` | empty | One regular expression per line: `Name: pattern` or `Name: /pattern/flags` (flags `i`, `m`, `s`, `u`). Without flags a pattern ignores case. The warning shows the name and the match with only its first and last characters. |
| `patternAction` | `warn` | `warn` or `block`. |
| `patternExternalOnly` | `false` | Only outside the organisation. |
| `blockedTypes` | empty | Extensions and MIME types, e.g. `exe, bat, cmd, scr, js, vbs, ps1, msi`. A program extension (exe, dll, scr, com, sh...) also catches a renamed program by its content. `image/*` style wildcards work for MIME types. |
| `allowedTypes` | empty | When set, only these extensions or MIME types may be attached, e.g. `pdf, docx, xlsx, image/*`. A program renamed to an allowed name is still refused. |
| `maxSizeMb` | `0` | Largest file in MB, per file. `0`: no limit. |
| `attachmentAction` | `block` | `warn` or `block` for the type and size rules. |
| `attachmentExternalOnly` | `false` | Only outside the organisation. |

With the defaults the plugin warns about IBANs and card numbers in mail
that goes outside the organisation, and does nothing else until you fill
in the lists.

### Outside the organisation

Bulwark decides which recipients are outside, with the same domains as its
own external mail warning: the domains in Organisation > Security >
External mail, and the domains of the sending account's own addresses. It
does this for the account the message goes out from, also when the user
has several accounts. The plugin learns only which recipients are outside,
not the domain list. Bcc recipients count too.

### Patterns that are refused

A slow regular expression would freeze the user's browser when they press
Send, so these lines are skipped (the browser console names the line and
the reason):

- longer than 200 characters;
- a repeated group with a repeat inside it, such as `(a+)+` or `(\w*)*`;
- a repeated group with alternatives, such as `(a|b)+`: write `[ab]+`
  instead, or put each alternative on its own line;
- back references (`\1`, `\k<name>`).

At most 50 pattern lines are used, and all patterns together get 250 ms
per message; after that the rest isn't checked for this message.

### File types by content

Bulwark reads the first bytes of each file it attaches and tells the
plugin what they look like (a Windows or Linux program, a script, ZIP,
RAR, 7z, gzip, PDF, common images). A Word or Excel file is a ZIP inside;
that doesn't count as a `.zip`. Files the browser no longer has (an
attachment of a forwarded message) are checked by name only when Bulwark
can't read them.

## Permissions

- `email:send`: to check a message before it is sent and stop it.
- `email:read`: to check a file when it is attached.
- `email:blob-read`: to read the text of text attachments. Without it the
  plugin checks names, types and sizes only.

## Notes for admins

- The check is part of Bulwark, so a user who uses another mail program, or
  turns the plugin off where they can, isn't checked. Force-enable the
  plugin for everyone in the admin dashboard. While a force-enabled check
  is loading or has stopped after errors, Bulwark 1.20 holds sends with
  "A required check isn't running".
- The plugin's checks are a safety net against mistakes, not data loss
  prevention: someone who wants to get around them can write the number
  differently.
- Publishing this plugin to the extension directory needs a trusted
  publisher for its folder in the directory.
