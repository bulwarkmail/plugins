# S/MIME plugin

End-to-end S/MIME (CMS / PKCS#7) for Bulwark Webmail, implemented as a
**privileged** (same-origin) plugin. All cryptography runs locally in the
browser using a bundled `pkijs` / `asn1js` / `webcrypto-liner` stack, with no key
material ever leaves the device.

## What it does

| Capability | How |
|---|---|
| **Sign** outgoing mail | `onComposeSend` builds the MIME and signs it with CMS `SignedData`, then submits via `api.jmap.sendRaw`. The *Signature format* setting picks detached (`multipart/signed`, readable without S/MIME; the default) or opaque (`application/pkcs7-mime`). |
| **Encrypt** outgoing mail | `onComposeSend` builds CMS `EnvelopedData` to every recipient (AES-256-GCM by default; AES-128 optional) plus the sender, then submits raw. Sign + Encrypt does proper sign-then-encrypt. Which certificate a recipient gets: see *Recipient certificates* below. |
| **Verify** incoming signatures | `onRenderEmailBody` fetches the raw message (`api.jmap.fetchBlob`), so the signed part is checked byte-for-byte, checks the signature and the certificate's validity dates, and renders the inner body. The banner names the signer as verified (green, "Valid signature by …") only when the certificate chains to a trusted issuer or is a certificate the user trusts, may sign mail, the digest is not SHA-1 or MD5, and the From address is one of the certificate's addresses (see *Trust* below). Any other intact signature reads "Signature matches, signer not verified", with the reason in the details. Only a message signed as a whole counts: its own top-level type is `multipart/signed` (with exactly the signed part and the signature) or `application/pkcs7-mime`, in a header every parser reads the same way (one Content-Type field, each parameter once), with the boundary only on its delimiter lines, and the mail server has to read the parts the plugin verifies: the same tree of parts with the same names and sizes, and no attachment outside the signed part. Anything else reads as a damaged signed message. A signed part inside another message is not verified; the banner says that part of the message is signed. |
| **Decrypt** incoming mail | `onRenderEmailBody` decrypts with your unlocked key: `EnvelopedData` with AES-CBC (128/192/256), 3DES or DES, and `AuthEnvelopedData` with AES-GCM (128/256) or ChaCha20-Poly1305. That covers Thunderbird, Outlook and all four modes of Stalwart's encryption at rest. The content key can be wrapped with RSAES-PKCS1-v1_5, RSA-OAEP (SHA-256 in `EnvelopedData`, or any of these with an OS key; SHA-1, SHA-256, SHA-384 or SHA-512 in `AuthEnvelopedData`), or ECDH-ES on P-256, P-384 or P-521 with AES key wrap. Mail in anything else, such as RC2, gets a banner that names the algorithm. |
| **Key management** | `settings-section` slot: import PKCS#12 (`.p12`/`.pfx`), unlock/lock, delete, import recipient certificates and trusted issuers, set sign/encrypt defaults. |
| **Keys in the OS** | In the desktop app, certificates from the Windows store, the macOS keychain and smart cards show up next to imported keys, marked as from the system store. They sign and decrypt without an import, through the optional `keystore` permission. Without it, everything runs on the PKCS#12 import as before. |
| **Status** | `email-banner` slot shows signature / encryption state as reader info bars; Sign and Encrypt are check items in the composer's Options menu, per message, starting from the defaults in Settings. |

## Security model

- **Trust.** A browser gives a page no access to the system's trusted roots, so
  the plugin keeps its own list. Trusted issuers are certificate authorities the
  user imports under *Trusted issuers*, plus the PEM certificates an admin puts
  into the plugin's admin setting `trustedIssuers` (read with `api.config.get`).
  Trusted signer certificates are single certificates the user trusted from the
  signature details ("Trust this certificate"), kept by fingerprint, and
  recipient certificates the user imported by hand. A path from the signer to a
  trusted issuer is built from the certificates in the message; each link needs
  a valid signature, its validity dates, the CA flag and certificate signing in
  its key usage (and a fitting path length). A CA that carries name constraints,
  critical or not, never counts: they aren't checked, and importing such a CA is
  refused. The search is bounded: duplicates (same subject, issuer and key) are
  dropped, a certificate that led nowhere isn't tried again, a path has at most
  8 certificates, one verification makes at most 64 signature checks, and only
  the first 32 certificates of a message are looked at; reaching a bound reads
  "signer not verified" with the reason. A key under RSA 2048 bits or an
  elliptic curve under 256 bits anywhere on the path, and a SHA-1 or MD5 hash
  in any signature (RSA-PSS parameters included), also read "not verified".
  No root list is bundled, so mail
  signed under a public CA reads "signer not verified" until the user or the
  admin adds that CA. Revocation is not checked (nothing is fetched), and the
  details say so.
- **Recipient certificates.** Opening a signed message stores the signer's
  certificate for the From address only when the signer is verified and the
  certificate may encrypt (*Auto-save signer certificates*). At send time a
  certificate the user imported comes before one from a signed message, and an
  expired one, one that may not encrypt, or one from a signed message that no
  trusted issuer or trusted certificate vouches for today is not used: the send
  stops and names the recipient. With more than one candidate, or the first time
  a certificate from a signed message is used, the user chooses, with issuer,
  fingerprint, validity and source shown; the answer is kept per address until
  another candidate turns up. Certificates versions 1.0 to 1.5 stored from
  signed mail without any check stay in the list, marked "not verified", with
  one button to remove them all. The sender's own address needs no stored
  certificate: the own copy is encrypted to the sender's certificate.
- **Accounts.** The stores belong to the webmail's origin, so keys, recipient
  certificates, trusted issuers, trusted certificates and certificate choices
  carry the account they belong to: the host's account id with its server, from
  `api.user.getAccounts` (permission `account:read`). Each account sees and
  removes only its own. A record an older version wrote without an account goes
  to the first account that reads it, once. If the host names no account, the
  stores stay shared as before.
- **Privileged tier.** Declares `tier: "privileged"` + `crypto:full`. Per
  `resolvePluginTier`, the same-origin tier is only granted to a **signed,
  admin-approved (managed)** bundle after high-risk consent. A self-uploaded
  copy is refused rather than downgraded; sign and ship it through the admin channel.
- **Keys at rest.** Private keys are imported from PKCS#12 and re-wrapped with
  AES-256-GCM under a PBKDF2(SHA-256, 600 000) key derived from a passphrase
  you choose. Stored in IndexedDB; the raw key bytes are never persisted.
- **Keys in use.** Unlocking imports the key as a **non-extractable**
  `CryptoKey`. Because the background (hooks) iframe and the visible slot
  iframes are same-origin, the unlocked handle is shared through a session
  IndexedDB store. It stays non-extractable and is **wiped on app boot, when
  the page goes away (`pagehide`: closing the tab, reloading, leaving), and on
  logout / account switch** (the last two configurable). A key not used for
  30 minutes locks, also while the page stays open. The store is shared by the
  webmail's tabs, so closing one tab locks the keys in the others too. An
  unlocked key is protected by the device, not by its passphrase; the settings
  page says so.
- **RSA PKCS#1 v1.5.** WebCrypto can't decrypt RSAES-PKCS1-v1_5, so that runs
  in JavaScript (webcrypto-liner) and needs the key bytes. For RSA keys the
  session entry also holds the PKCS#8 key, encrypted with a fresh
  non-extractable AES-GCM key made at unlock. The decrypt path rebuilds the
  liner key from it and keeps it in memory until the iframe goes away. Code
  running in the plugin's origin can recover the key while it is unlocked;
  it is wiped with the rest of the session entry.
- **Keys in the OS.** `api.keystore` signs and unwraps in the OS. The plugin
  never sees the private key, and holds the certificate list in memory only,
  per frame. The shell asks in a native dialog at every signature, and before a
  certificate unwraps anything. Opening a message never brings up a dialog: if
  nothing is allowed yet, the banner offers a button. The list is only asked for
  when the settings page opens or the user asks for a key, not at start. An OS
  key comes before an imported one, except that
  a key already unlocked opens mail without a question. If the OS can't do it
  (`keystore:unsupported`, a key that's gone, a missing card, a failure) the
  imported key takes over. A No or a cancelled PIN stops the send, which keeps
  the draft, and shows in the banner on read with a way to try again. A later try
  skips to an imported key if there is one, and says so. A valid certificate
  comes before one outside its dates, and a toast warns when signing with one of
  those, or when the sender's own copy will be unreadable. RSA signs PKCS#1 v1.5,
  which Outlook needs, and PSS only if the key has nothing else. An EC key without
  key agreement is sign-only, and the settings page says so.
- **Rendering once.** A render that used the OS is shared for 15 seconds per
  message, as an older webmail renders again on mark-read and two PIN cancels in a
  row lock the key. Try again and Unlock go past that. Decrypted text is held in
  memory for that long, and dropped at sign-out.
- **ECDH points** are checked to be on the certificate's curve before the OS or
  WebCrypto sees them.
- **EFAIL.** CBC mail has no integrity protection: an attacker can reshape the
  plaintext into something that loads a URL carrying the rest of the mail away.
  So for decrypted AES-CBC, 3DES or DES mail without a verified signature inside,
  the plugin tells the host to keep external content off, whatever the settings
  or trusted senders allow, and the banner says so. Webmails before the
  `blockExternalContent` flag ignore this, and the banner stays silent there.
- Returned HTML still passes through the host sanitizer.

## Build

```bash
cd repos/plugins/smime
npm install          # pulls pkijs / asn1js / pvtsutils / webcrypto-liner / @noble/ciphers + esbuild
npm run build        # → dist/index.js  (~1.7 MB, under the privileged cap)
npm run package      # → smime.zip (manifest.json + index.js) for admin upload
```

The build aliases the Node `crypto` builtin (referenced by a dead
`typeof process` branch in `asmcrypto.js`) to a browser shim so the bundle is
self-contained.

## Layout

```
src/
  index.js            entry: activate + hooks + slots (React.createElement UI)
  crypto-engine.js    pkijs CryptoEngine w/ 3DES + legacy PKCS#12 PBE
  certificate-utils.js X.509 parse + metadata + capability classification
  mime-builder.js     deterministic CRLF MIME builder + CMS RFC822 wrapper
  mime-parse.js       inner-MIME parser for decrypted/verified content
  smime-detect.js     S/MIME or not, from the message's top-level Content-Type
  smime-sign.js       CMS SignedData (opaque or detached)
  smime-encrypt.js    CMS EnvelopedData
  smime-decrypt.js    CMS decrypt + blob normalisation + recipient matching
  auth-enveloped.js   AuthEnvelopedData: parse, key unwrap, AES-GCM / ChaCha20-Poly1305
  key-agree.js        ECDH recipients: X9.63 KDF + AES key wrap
  os-keys.js          keys in the OS store: virtual key records, handles for api.keystore
  smime-verify.js     CMS signature verification + signer status
  trust.js            whose signature counts as verified: trusted issuers, paths, usage, From
  pkcs12.js           PKCS#12 import + key wrap/unlock
  key-storage.js      IndexedDB: key records, recipient certs, session keys, trusted certificates
  util.js             uuid / hex / equality helpers
  node-crypto-shim.js browser shim for the Node "crypto" builtin
```

The crypto modules are faithful ports of the host's `lib/smime/*` (the former
native pipeline), so the plugin produces byte-compatible CMS.

## Note on host wiring

The `onComposeSend` and `onRenderEmailBody` hook buses and the privileged
`api.jmap` surface exist in the host (see `lib/plugin-hooks.ts`,
`lib/plugin-sandbox/host-api.ts`). The send/render **takeover** fires once the
host emits those buses from the composer and viewer (the migration that retires
the inline native path). The `settings-section` and `email-banner` slots
and the Options menu entries are active today.
