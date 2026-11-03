# Changelog

## Unreleased

### Added
- In the desktop app, certificates from the system store and smart cards sign and decrypt without an import. They're listed under Your keys, marked as from the system store. The PKCS#12 import stays, and takes over where the system can't do the job
- Mail encrypted to an EC certificate (ECDH) can now be decrypted, with a system key or an imported one

### Fixed
- Mail whose key is wrapped with OAEP SHA-1 in EnvelopedData opens with a system key

## 1.4.3 (2026-11-01)

### Fixed
- Two signed or encrypted messages sent at the same time from one address are no longer refused by Bulwark 1.20 when the organisation uses classification labels

## 1.4.2 (2026-10-31)

### Fixed
- The key hints point to Settings > Add-ons > S/MIME, where the page is now
- A signed message shows its signature verdict the first time it opens, not only the second
