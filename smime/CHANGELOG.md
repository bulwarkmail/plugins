# Changelog

## Unreleased

### Changed
- Encrypted mail that isn't also signed now opens with the note that it has no integrity protection, and external content stays off. That's the price of the format other mail programs read; signed and encrypted mail, the default, is not affected

### Fixed
- A signature is checked against the certificate the banner names. A message carrying a second certificate with the same serial number, and the issuer's name in another spelling, had its signature checked against that certificate and still read "Valid signature by" the sender whose certificate it also carried #44 (thanks @kah-ja)
- Other mail programs can open encrypted mail sent from Bulwark. The body is encrypted with AES-CBC and the message key is wrapped with RSA PKCS#1 v1.5, the pairing every S/MIME client reads. Until now they stopped at the cipher and usually reported a missing recipient. Mail sent with earlier versions still opens in Bulwark #42 (thanks @b3rsrk)
- A detached signature stays valid when a mail server or list rewrites the message's MIME framing: the signed part now ends with a line break of its own
- Attachments in signed and encrypted mail are listed under their names. A name with an umlaut or another non-ASCII character showed as it is written in the message, `=?UTF-8?Q?Bericht_M=C3=A4rz.pdf?=` for one, which was also how the names of attachments sent from Bulwark came back
- Signed and encrypted mail with more than one text part shows all of them. Of a message with text before and after an attachment, or with a footer in a text part of its own, only the last part was shown
- Signed or encrypted content without MIME headers of its own, as `openssl cms -sign` writes it for plain text, is shown from its first line. Its first paragraph was taken for a header and left out
- A signature that names its signer by key identifier is checked when the message carries the issuer's certificate too. It read "Invalid signature: The signer's certificate is missing from the signature" although the signature was intact
- An image placed in the text of a message you sign or encrypt arrives in the text. It went out as an ordinary attachment, with an empty frame where it stood

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
