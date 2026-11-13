# Changelog

## Unreleased

### Changed
- Encrypted mail that isn't also signed now opens with the note that it has no integrity protection, and external content stays off. That's the price of the format other mail programs read; signed and encrypted mail, the default, is not affected

### Fixed
- Other mail programs can open encrypted mail sent from Bulwark. The body is encrypted with AES-CBC and the message key is wrapped with RSA PKCS#1 v1.5, the pairing every S/MIME client reads. Until now they stopped at the cipher and usually reported a missing recipient. Mail sent with earlier versions still opens in Bulwark #42 (thanks @b3rsrk)
- A detached signature stays valid when a mail server or list rewrites the message's MIME framing: the signed part now ends with a line break of its own

## 1.5.0 (2026-11-07)

### Added
- In the Bulwark desktop app, with Bulwark 1.21 or later, certificates from the system store and smart cards sign and decrypt without an import. They're listed under Your keys, marked as from the system store. The PKCS#12 import stays, and takes over where the system can't do the job
- With a system certificate, the app asks before every signature, and a No stops only that send. Opening a message never brings up a dialog: when a system certificate could open it, the banner offers an Open button
- Mail encrypted to an EC certificate (ECDH) can now be decrypted, with a system key or an imported one
- With Bulwark 1.21 or later, decrypted mail with no integrity protection and no verified signature keeps external content off, whatever the settings or trusted senders allow, and the banner says so
- A warning when you sign with a certificate outside its dates, or when you won't be able to read your own encrypted copy

### Fixed
- Mail whose key is wrapped with OAEP SHA-1 in EnvelopedData opens with a system key
- A key's signing and encryption uses are read from its certificate. They used to show as off for most certificates
- The banner no longer shows the verdict from the last time a message was open, and keeps watching for as long as a PIN takes
- A message listing the same recipient many times costs one attempt per key

## 1.4.3 (2026-11-01)

### Fixed
- Two signed or encrypted messages sent at the same time from one address are no longer refused by Bulwark 1.20 when the organisation uses classification labels

## 1.4.2 (2026-10-31)

### Fixed
- The key hints point to Settings > Add-ons > S/MIME, where the page is now
- A signed message shows its signature verdict the first time it opens, not only the second
