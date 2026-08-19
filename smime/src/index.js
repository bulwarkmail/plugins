/**
 * S/MIME — privileged (same-origin) webmail plugin.
 *
 * Replaces the former native S/MIME pipeline with a sandboxed plugin that
 * runs all cryptography locally (bundled pkijs/asn1js/webcrypto-liner):
 *
 *   • onComposeSend   (intercept)  → build MIME, sign/encrypt, api.jmap.sendRaw
 *   • onRenderEmailBody (transform) → api.jmap.fetchBlob, decrypt/verify, replace body
 *   • composer-toolbar slot         → per-message Sign / Encrypt toggles
 *   • email-banner slot             → signature / encryption status
 *   • settings-section slot         → key import, unlock/lock, recipient certs
 *
 * Private keys are imported from PKCS#12, AES-GCM-wrapped under PBKDF2(600k),
 * and unlocked into NON-EXTRACTABLE WebCrypto keys held in a same-origin
 * IndexedDB session store shared between the background and slot iframes.
 */

const host = require('@plugin-host');
const React = require('react');
const h = React.createElement;
const { useState, useEffect, useCallback, useRef } = React;

import { buildMimeMessage, wrapCmsAsSmimeMessage, base64Encode } from './mime-builder.js';
import { smimeSign } from './smime-sign.js';
import { smimeEncrypt } from './smime-encrypt.js';
import { smimeVerify, smimeVerifyDetached } from './smime-verify.js';
import { smimeDecrypt, normalizeCmsBytes, SmimeKeyLockedError } from './smime-decrypt.js';
import { detectSmime } from './smime-detect.js';
import { splitMultipartSigned } from './mime-signed.js';
import { parseMime } from './mime-parse.js';
import { importPkcs12, unlockPrivateKey } from './pkcs12.js';
import { parseCertificatePemOrDer, extractCertificateInfo } from './certificate-utils.js';
import { generateUUID } from './util.js';
import {
  saveKeyRecord, listKeyRecords, deleteKeyRecord,
  savePublicCert, listPublicCerts, deletePublicCert,
  saveSessionKeys, getSessionKeys, deleteSessionKeys, clearSessionKeys,
} from './key-storage.js';

// ─── Shared preferences (api.storage; shared across iframes) ──────────

const PREFS_KEY = 'prefs.v1';
const INTENT_KEY = 'composeIntent.v1';
const VERIFY_PREFIX = 'verify:';

// ─── i18n ────────────────────────────────────────────────────────────
// Uses Bulwark's own plugin i18n API (host.i18n.t), which reads the
// "locales" bundle in manifest.json and follows the same locale the rest
// of the app is already showing (Accept-Language + the user's stored
// preference) — no separate language detection needed on our side.
// The fallback dictionary below only kicks in if host.i18n is somehow
// unavailable (e.g. an older Bulwark version predating the i18n API).
const I18N_FALLBACK_EN = {
  'banner.encryption': 'Encryption',
  'banner.decrypted': 'Decrypted',
  'banner.encryptedLocked': 'Encrypted — unlock your key to read',
  'banner.encryptedFailed': 'Encrypted — couldn’t be decrypted with your keys',
  'banner.encryptedMessage': 'Encrypted message',
  'banner.signature': 'Signature',
  'banner.validSignature': 'Valid signature',
  'banner.validSignatureBy': 'Valid signature — {email}',
  'banner.signedMessage': 'Signed message',
  'banner.invalidSignature': 'Invalid signature: {reason}',
  'banner.selfSignedBadge': 'self-signed',
  'banner.signerMismatchBadge': 'signer ≠ From',
  'banner.unlockNow': 'Unlock now',
  'banner.unlocking': 'Unlocking…',
  'banner.viewCertDetails': 'View certificate details',
  'banner.hideCertDetails': 'Hide certificate details',
  'banner.downloadCert': 'Download certificate',
  'banner.copyCert': 'Copy to clipboard',
  'banner.copyChain': 'Copy with chain',
  'banner.copied': 'Copied!',
  'banner.certChain': 'Chain',
  'banner.certChainCount': '{count} additional certificate(s) included',
  'banner.certSubject': 'Subject',
  'banner.certIssuer': 'Issuer',
  'banner.certEmail': 'Email',
  'banner.certValid': 'Valid',
  'banner.certFingerprint': 'Fingerprint (SHA-256)',
};

const SETTINGS_EN = {
  'settings.notActive': 'S/MIME is not active',
  'settings.yourKeys': 'Your keys',
  'settings.yourKeysDesc': 'Import a PKCS#12 (.p12/.pfx) file containing your certificate and private key. The key is encrypted in your browser and never leaves it.',
  'settings.importKey': 'Import key',
  'settings.noKeys': 'No keys imported yet.',
  'settings.certUnknown': 'Certificate',
  'settings.validRange': 'valid {from} – {to}',
  'settings.expired': 'EXPIRED',
  'settings.capSign': 'sign',
  'settings.capEncrypt': 'encrypt',
  'settings.lock': 'Lock',
  'settings.unlock': 'Unlock',
  'settings.delete': 'Delete',
  'settings.recipientCerts': 'Recipient certificates',
  'settings.recipientCertsDesc': 'Public certificates (PEM/DER) of people you want to send encrypted mail to. Signer certificates from validly signed mail are saved automatically.',
  'settings.importCert': 'Import certificate',
  'settings.noCerts': 'No recipient certificates.',
  'settings.certExpires': 'expires {date}',
  'settings.remove': 'Remove',
  'settings.defaults': 'Defaults for new messages',
  'settings.defaultSign': 'Sign new messages by default',
  'settings.defaultEncrypt': 'Encrypt new messages by default (when all recipients have certificates)',
  'settings.importKeyDialogTitle': 'Import S/MIME key',
  'settings.importKeyDialogMessage': 'Importing "{file}".',
  'settings.importDialogConfirm': 'Import',
  'settings.p12PassLabel': 'Passphrase protecting the .p12/.pfx file',
  'settings.p12PassPlaceholder': 'Leave blank if the file has none',
  'settings.storagePassLabel': 'New passphrase to protect this key in your browser',
  'settings.storagePassRequired': 'A storage passphrase is required',
  'settings.importKeySuccess': 'Imported S/MIME key for {email}',
  'settings.importKeyFailed': 'Import failed: {reason}',
  'settings.unlockDialogTitle': 'Unlock {email}',
  'settings.unlockConfirm': 'Unlock',
  'settings.storagePassForKeyLabel': 'Storage passphrase for this key',
  'settings.unlockSuccess': 'Unlocked {email}',
  'settings.unlockFailed': 'Unlock failed',
  'settings.keyFallback': 'key',
  'settings.lockedToast': 'Locked {email}',
  'settings.deleteDialogTitle': 'Delete S/MIME key',
  'settings.deleteDialogMessage': 'Delete the private key and certificate for {email}? You will no longer be able to decrypt mail encrypted to it.',
  'settings.deleteDialogFallbackIdentity': 'this identity',
  'settings.deleteConfirm': 'Delete',
  'settings.keyDeletedToast': 'Key deleted',
  'settings.certNoEmail': 'Certificate has no email address',
  'settings.importCertSuccess': 'Imported certificate for {email}',
  'settings.importCertFailed': 'Certificate import failed: {reason}',
  'settings.unlockSendDialogTitle': 'Unlock S/MIME key',
  'settings.unlockSendDialogMessage': 'Your key for {email} is locked. Enter its storage passphrase to sign and send.',
  'settings.unlockAndSend': 'Unlock & send',
  'settings.storagePassphrase': 'Storage passphrase',
  'settings.unlockFailedWrongPass': 'Unlock failed — wrong passphrase?',
  'settings.notPrivilegedToast': 'Cannot sign/encrypt: S/MIME is not running in the privileged tier.',
};
Object.assign(I18N_FALLBACK_EN, SETTINGS_EN);

// ======================================================================
// >>> SELF-DETECTED LOCALE FALLBACK — EASY TO FIND / REMOVE LATER <<<
// host.i18n.t() exists and correctly finds our manifest.json locale keys,
// but as of Bulwark v1.8.1 it appears to always resolve to English inside
// this privileged plugin iframe, regardless of the user's actual account
// language (confirmed: host.i18n.t('banner.signature') returns "Signature"
// even with the account set to German). This block works around that by
// detecting the active locale ourselves and using our own copy of the
// manifest.json locale strings, bypassing host.i18n.t() entirely whenever
// we have a matching local dictionary. Delete this whole block (and the
// two lines marked below in t()) once the host bug is fixed upstream.
const LOCAL_I18N = 
{
  "en": {
    "banner.encryption": "Encryption",
    "banner.decrypted": "Decrypted",
    "banner.encryptedLocked": "Encrypted — unlock your key to read",
    "banner.encryptedFailed": "Encrypted — couldn’t be decrypted with your keys",
    "banner.encryptedMessage": "Encrypted message",
    "banner.signature": "Signature",
    "banner.validSignature": "Valid signature",
    "banner.validSignatureBy": "Valid signature — {email}",
    "banner.signedMessage": "Signed message",
    "banner.invalidSignature": "Invalid signature: {reason}",
    "banner.selfSignedBadge": "self-signed",
    "banner.signerMismatchBadge": "signer ≠ From",
    "banner.unlockNow": "Unlock now",
    "banner.unlocking": "Unlocking…",
    "banner.viewCertDetails": "View certificate details",
    "banner.hideCertDetails": "Hide certificate details",
    "banner.downloadCert": "Download certificate",
    "banner.certSubject": "Subject",
    "banner.certIssuer": "Issuer",
    "banner.certEmail": "Email",
    "banner.certValid": "Valid",
    "banner.certFingerprint": "Fingerprint (SHA-256)",
    "toolbar.sign": "Sign",
    "toolbar.encrypt": "Encrypt",
    "toolbar.signTitle": "Digitally sign this message",
    "toolbar.encryptTitle": "Encrypt this message to its recipients",
    "toolbar.needKey": "S/MIME: import a key in Settings to sign/encrypt",
    "settings.title": "S/MIME keys & certificates",
    "banner.copyCert": "Copy to clipboard",
    "banner.copied": "Copied!",
    "banner.copyChain": "Copy with chain",
    "banner.certChain": "Chain",
    "banner.certChainCount": "{count} additional certificate(s) included",
    "settings.notActive": "S/MIME is not active",
    "settings.yourKeys": "Your keys",
    "settings.yourKeysDesc": "Import a PKCS#12 (.p12/.pfx) file containing your certificate and private key. The key is encrypted in your browser and never leaves it.",
    "settings.importKey": "Import key",
    "settings.noKeys": "No keys imported yet.",
    "settings.certUnknown": "Certificate",
    "settings.validRange": "valid {from} – {to}",
    "settings.expired": "EXPIRED",
    "settings.capSign": "sign",
    "settings.capEncrypt": "encrypt",
    "settings.lock": "Lock",
    "settings.unlock": "Unlock",
    "settings.delete": "Delete",
    "settings.recipientCerts": "Recipient certificates",
    "settings.recipientCertsDesc": "Public certificates (PEM/DER) of people you want to send encrypted mail to. Signer certificates from validly signed mail are saved automatically.",
    "settings.importCert": "Import certificate",
    "settings.noCerts": "No recipient certificates.",
    "settings.certExpires": "expires {date}",
    "settings.remove": "Remove",
    "settings.defaults": "Defaults for new messages",
    "settings.defaultSign": "Sign new messages by default",
    "settings.defaultEncrypt": "Encrypt new messages by default (when all recipients have certificates)",
    "settings.importKeyDialogTitle": "Import S/MIME key",
    "settings.importKeyDialogMessage": "Importing \"{file}\".",
    "settings.importDialogConfirm": "Import",
    "settings.p12PassLabel": "Passphrase protecting the .p12/.pfx file",
    "settings.p12PassPlaceholder": "Leave blank if the file has none",
    "settings.storagePassLabel": "New passphrase to protect this key in your browser",
    "settings.storagePassRequired": "A storage passphrase is required",
    "settings.importKeySuccess": "Imported S/MIME key for {email}",
    "settings.importKeyFailed": "Import failed: {reason}",
    "settings.unlockDialogTitle": "Unlock {email}",
    "settings.unlockConfirm": "Unlock",
    "settings.storagePassForKeyLabel": "Storage passphrase for this key",
    "settings.unlockSuccess": "Unlocked {email}",
    "settings.unlockFailed": "Unlock failed",
    "settings.keyFallback": "key",
    "settings.lockedToast": "Locked {email}",
    "settings.deleteDialogTitle": "Delete S/MIME key",
    "settings.deleteDialogMessage": "Delete the private key and certificate for {email}? You will no longer be able to decrypt mail encrypted to it.",
    "settings.deleteDialogFallbackIdentity": "this identity",
    "settings.deleteConfirm": "Delete",
    "settings.keyDeletedToast": "Key deleted",
    "settings.certNoEmail": "Certificate has no email address",
    "settings.importCertSuccess": "Imported certificate for {email}",
    "settings.importCertFailed": "Certificate import failed: {reason}",
    "settings.unlockSendDialogTitle": "Unlock S/MIME key",
    "settings.unlockSendDialogMessage": "Your key for {email} is locked. Enter its storage passphrase to sign and send.",
    "settings.unlockAndSend": "Unlock & send",
    "settings.storagePassphrase": "Storage passphrase",
    "settings.unlockFailedWrongPass": "Unlock failed — wrong passphrase?",
    "settings.notPrivilegedToast": "Cannot sign/encrypt: S/MIME is not running in the privileged tier."
  },
  "de": {
    "banner.encryption": "Verschlüsselung",
    "banner.decrypted": "Entschlüsselt",
    "banner.encryptedLocked": "Verschlüsselt — Schlüssel entsperren, um zu lesen",
    "banner.encryptedFailed": "Verschlüsselt — konnte mit Ihren Schlüsseln nicht entschlüsselt werden",
    "banner.encryptedMessage": "Verschlüsselte Nachricht",
    "banner.signature": "Signatur",
    "banner.validSignature": "Gültige Signatur",
    "banner.validSignatureBy": "Gültige Signatur — {email}",
    "banner.signedMessage": "Signierte Nachricht",
    "banner.invalidSignature": "Ungültige Signatur: {reason}",
    "banner.selfSignedBadge": "selbstsigniert",
    "banner.signerMismatchBadge": "Unterzeichner ≠ Absender",
    "banner.unlockNow": "Jetzt entsperren",
    "banner.unlocking": "Entsperre…",
    "banner.viewCertDetails": "Zertifikatsdetails anzeigen",
    "banner.hideCertDetails": "Zertifikatsdetails ausblenden",
    "banner.downloadCert": "Zertifikat herunterladen",
    "banner.certSubject": "Inhaber",
    "banner.certIssuer": "Aussteller",
    "banner.certEmail": "E-Mail",
    "banner.certValid": "Gültig",
    "banner.certFingerprint": "Fingerabdruck (SHA-256)",
    "toolbar.sign": "Signieren",
    "toolbar.encrypt": "Verschlüsseln",
    "toolbar.signTitle": "Diese Nachricht digital signieren",
    "toolbar.encryptTitle": "Diese Nachricht für die Empfänger verschlüsseln",
    "toolbar.needKey": "S/MIME: Schlüssel in den Einstellungen importieren, um zu signieren/verschlüsseln",
    "settings.title": "S/MIME-Schlüssel & Zertifikate",
    "banner.copyCert": "In Zwischenablage kopieren",
    "banner.copied": "Kopiert!",
    "banner.copyChain": "Mit Kette kopieren",
    "banner.certChain": "Kette",
    "banner.certChainCount": "{count} weitere(s) Zertifikat(e) enthalten",
    "settings.notActive": "S/MIME ist nicht aktiv",
    "settings.yourKeys": "Ihre Schlüssel",
    "settings.yourKeysDesc": "Importieren Sie eine PKCS#12-Datei (.p12/.pfx) mit Ihrem Zertifikat und privaten Schlüssel. Der Schlüssel wird in Ihrem Browser verschlüsselt und verlässt ihn nie.",
    "settings.importKey": "Schlüssel importieren",
    "settings.noKeys": "Noch keine Schlüssel importiert.",
    "settings.certUnknown": "Zertifikat",
    "settings.validRange": "gültig {from} – {to}",
    "settings.expired": "ABGELAUFEN",
    "settings.capSign": "signieren",
    "settings.capEncrypt": "verschlüsseln",
    "settings.lock": "Sperren",
    "settings.unlock": "Entsperren",
    "settings.delete": "Löschen",
    "settings.recipientCerts": "Empfängerzertifikate",
    "settings.recipientCertsDesc": "Öffentliche Zertifikate (PEM/DER) von Personen, denen Sie verschlüsselte Mail senden möchten. Signierer-Zertifikate aus gültig signierten Mails werden automatisch gespeichert.",
    "settings.importCert": "Zertifikat importieren",
    "settings.noCerts": "Keine Empfängerzertifikate.",
    "settings.certExpires": "läuft ab am {date}",
    "settings.remove": "Entfernen",
    "settings.defaults": "Standardeinstellungen für neue Nachrichten",
    "settings.defaultSign": "Neue Nachrichten standardmäßig signieren",
    "settings.defaultEncrypt": "Neue Nachrichten standardmäßig verschlüsseln (wenn alle Empfänger Zertifikate haben)",
    "settings.importKeyDialogTitle": "S/MIME-Schlüssel importieren",
    "settings.importKeyDialogMessage": "Importiere „{file}\".",
    "settings.importDialogConfirm": "Importieren",
    "settings.p12PassLabel": "Kennwort, das die .p12/.pfx-Datei schützt",
    "settings.p12PassPlaceholder": "Leer lassen, falls die Datei keines hat",
    "settings.storagePassLabel": "Neues Kennwort, um diesen Schlüssel im Browser zu schützen",
    "settings.storagePassRequired": "Ein Speicher-Kennwort ist erforderlich",
    "settings.importKeySuccess": "S/MIME-Schlüssel für {email} importiert",
    "settings.importKeyFailed": "Import fehlgeschlagen: {reason}",
    "settings.unlockDialogTitle": "{email} entsperren",
    "settings.unlockConfirm": "Entsperren",
    "settings.storagePassForKeyLabel": "Speicher-Kennwort für diesen Schlüssel",
    "settings.unlockSuccess": "{email} entsperrt",
    "settings.unlockFailed": "Entsperren fehlgeschlagen",
    "settings.keyFallback": "Schlüssel",
    "settings.lockedToast": "{email} gesperrt",
    "settings.deleteDialogTitle": "S/MIME-Schlüssel löschen",
    "settings.deleteDialogMessage": "Privaten Schlüssel und Zertifikat für {email} löschen? Sie können damit verschlüsselte Mails danach nicht mehr entschlüsseln.",
    "settings.deleteDialogFallbackIdentity": "diese Identität",
    "settings.deleteConfirm": "Löschen",
    "settings.keyDeletedToast": "Schlüssel gelöscht",
    "settings.certNoEmail": "Zertifikat hat keine E-Mail-Adresse",
    "settings.importCertSuccess": "Zertifikat für {email} importiert",
    "settings.importCertFailed": "Zertifikatsimport fehlgeschlagen: {reason}",
    "settings.unlockSendDialogTitle": "S/MIME-Schlüssel entsperren",
    "settings.unlockSendDialogMessage": "Ihr Schlüssel für {email} ist gesperrt. Geben Sie das Speicher-Kennwort ein, um zu signieren und zu senden.",
    "settings.unlockAndSend": "Entsperren & senden",
    "settings.storagePassphrase": "Speicher-Kennwort",
    "settings.unlockFailedWrongPass": "Entsperren fehlgeschlagen — falsches Kennwort?",
    "settings.notPrivilegedToast": "Signieren/Verschlüsseln nicht möglich: S/MIME läuft nicht im privilegierten Tier."
  },
  "es": {
    "banner.encryption": "Cifrado",
    "banner.decrypted": "Descifrado",
    "banner.encryptedLocked": "Cifrado — desbloquee su clave para leer",
    "banner.encryptedFailed": "Cifrado — no se pudo descifrar con sus claves",
    "banner.encryptedMessage": "Mensaje cifrado",
    "banner.signature": "Firma",
    "banner.validSignature": "Firma válida",
    "banner.validSignatureBy": "Firma válida — {email}",
    "banner.signedMessage": "Mensaje firmado",
    "banner.invalidSignature": "Firma no válida: {reason}",
    "banner.selfSignedBadge": "autofirmado",
    "banner.signerMismatchBadge": "firmante ≠ remitente",
    "banner.unlockNow": "Desbloquear ahora",
    "banner.unlocking": "Desbloqueando…",
    "banner.viewCertDetails": "Ver detalles del certificado",
    "banner.hideCertDetails": "Ocultar detalles del certificado",
    "banner.downloadCert": "Descargar certificado",
    "banner.certSubject": "Titular",
    "banner.certIssuer": "Emisor",
    "banner.certEmail": "Correo electrónico",
    "banner.certValid": "Válido",
    "banner.certFingerprint": "Huella digital (SHA-256)",
    "toolbar.sign": "Firmar",
    "toolbar.encrypt": "Cifrar",
    "toolbar.signTitle": "Firmar digitalmente este mensaje",
    "toolbar.encryptTitle": "Cifrar este mensaje para sus destinatarios",
    "toolbar.needKey": "S/MIME: importe una clave en Configuración para firmar/cifrar",
    "settings.title": "Claves y certificados S/MIME",
    "banner.copyCert": "Copiar al portapapeles",
    "banner.copied": "¡Copiado!",
    "banner.copyChain": "Copiar con cadena",
    "banner.certChain": "Cadena",
    "banner.certChainCount": "{count} certificado(s) adicional(es) incluido(s)",
    "settings.notActive": "S/MIME no está activo",
    "settings.yourKeys": "Sus claves",
    "settings.yourKeysDesc": "Importe un archivo PKCS#12 (.p12/.pfx) que contenga su certificado y clave privada. La clave se cifra en su navegador y nunca sale de él.",
    "settings.importKey": "Importar clave",
    "settings.noKeys": "Aún no se han importado claves.",
    "settings.certUnknown": "Certificado",
    "settings.validRange": "válido {from} – {to}",
    "settings.expired": "CADUCADO",
    "settings.capSign": "firmar",
    "settings.capEncrypt": "cifrar",
    "settings.lock": "Bloquear",
    "settings.unlock": "Desbloquear",
    "settings.delete": "Eliminar",
    "settings.recipientCerts": "Certificados de destinatarios",
    "settings.recipientCertsDesc": "Certificados públicos (PEM/DER) de las personas a las que desea enviar correo cifrado. Los certificados del firmante de correo válidamente firmado se guardan automáticamente.",
    "settings.importCert": "Importar certificado",
    "settings.noCerts": "No hay certificados de destinatarios.",
    "settings.certExpires": "caduca el {date}",
    "settings.remove": "Quitar",
    "settings.defaults": "Valores predeterminados para mensajes nuevos",
    "settings.defaultSign": "Firmar mensajes nuevos de forma predeterminada",
    "settings.defaultEncrypt": "Cifrar mensajes nuevos de forma predeterminada (cuando todos los destinatarios tengan certificados)",
    "settings.importKeyDialogTitle": "Importar clave S/MIME",
    "settings.importKeyDialogMessage": "Importando \"{file}\".",
    "settings.importDialogConfirm": "Importar",
    "settings.p12PassLabel": "Contraseña que protege el archivo .p12/.pfx",
    "settings.p12PassPlaceholder": "Déjelo en blanco si el archivo no tiene ninguna",
    "settings.storagePassLabel": "Nueva contraseña para proteger esta clave en su navegador",
    "settings.storagePassRequired": "Se requiere una contraseña de almacenamiento",
    "settings.importKeySuccess": "Clave S/MIME importada para {email}",
    "settings.importKeyFailed": "Error al importar: {reason}",
    "settings.unlockDialogTitle": "Desbloquear {email}",
    "settings.unlockConfirm": "Desbloquear",
    "settings.storagePassForKeyLabel": "Contraseña de almacenamiento para esta clave",
    "settings.unlockSuccess": "{email} desbloqueada",
    "settings.unlockFailed": "Error al desbloquear",
    "settings.keyFallback": "clave",
    "settings.lockedToast": "{email} bloqueada",
    "settings.deleteDialogTitle": "Eliminar clave S/MIME",
    "settings.deleteDialogMessage": "¿Eliminar la clave privada y el certificado de {email}? Ya no podrá descifrar el correo cifrado para ella.",
    "settings.deleteDialogFallbackIdentity": "esta identidad",
    "settings.deleteConfirm": "Eliminar",
    "settings.keyDeletedToast": "Clave eliminada",
    "settings.certNoEmail": "El certificado no tiene dirección de correo",
    "settings.importCertSuccess": "Certificado importado para {email}",
    "settings.importCertFailed": "Error al importar el certificado: {reason}",
    "settings.unlockSendDialogTitle": "Desbloquear clave S/MIME",
    "settings.unlockSendDialogMessage": "Su clave para {email} está bloqueada. Introduzca su contraseña de almacenamiento para firmar y enviar.",
    "settings.unlockAndSend": "Desbloquear y enviar",
    "settings.storagePassphrase": "Contraseña de almacenamiento",
    "settings.unlockFailedWrongPass": "Error al desbloquear — ¿contraseña incorrecta?",
    "settings.notPrivilegedToast": "No se puede firmar/cifrar: S/MIME no se ejecuta en el nivel privilegiado."
  },
  "fr": {
    "banner.encryption": "Chiffrement",
    "banner.decrypted": "Déchiffré",
    "banner.encryptedLocked": "Chiffré — déverrouillez votre clé pour lire",
    "banner.encryptedFailed": "Chiffré — impossible de déchiffrer avec vos clés",
    "banner.encryptedMessage": "Message chiffré",
    "banner.signature": "Signature",
    "banner.validSignature": "Signature valide",
    "banner.validSignatureBy": "Signature valide — {email}",
    "banner.signedMessage": "Message signé",
    "banner.invalidSignature": "Signature invalide : {reason}",
    "banner.selfSignedBadge": "auto-signé",
    "banner.signerMismatchBadge": "signataire ≠ expéditeur",
    "banner.unlockNow": "Déverrouiller maintenant",
    "banner.unlocking": "Déverrouillage…",
    "banner.viewCertDetails": "Voir les détails du certificat",
    "banner.hideCertDetails": "Masquer les détails du certificat",
    "banner.downloadCert": "Télécharger le certificat",
    "banner.certSubject": "Objet",
    "banner.certIssuer": "Émetteur",
    "banner.certEmail": "E-mail",
    "banner.certValid": "Valide",
    "banner.certFingerprint": "Empreinte (SHA-256)",
    "toolbar.sign": "Signer",
    "toolbar.encrypt": "Chiffrer",
    "toolbar.signTitle": "Signer numériquement ce message",
    "toolbar.encryptTitle": "Chiffrer ce message pour ses destinataires",
    "toolbar.needKey": "S/MIME : importez une clé dans les paramètres pour signer/chiffrer",
    "settings.title": "Clés et certificats S/MIME",
    "banner.copyCert": "Copier dans le presse-papiers",
    "banner.copied": "Copié !",
    "banner.copyChain": "Copier avec la chaîne",
    "banner.certChain": "Chaîne",
    "banner.certChainCount": "{count} certificat(s) supplémentaire(s) inclus",
    "settings.notActive": "S/MIME n'est pas actif",
    "settings.yourKeys": "Vos clés",
    "settings.yourKeysDesc": "Importez un fichier PKCS#12 (.p12/.pfx) contenant votre certificat et votre clé privée. La clé est chiffrée dans votre navigateur et n'en sort jamais.",
    "settings.importKey": "Importer une clé",
    "settings.noKeys": "Aucune clé importée pour l'instant.",
    "settings.certUnknown": "Certificat",
    "settings.validRange": "valide du {from} au {to}",
    "settings.expired": "EXPIRÉ",
    "settings.capSign": "signer",
    "settings.capEncrypt": "chiffrer",
    "settings.lock": "Verrouiller",
    "settings.unlock": "Déverrouiller",
    "settings.delete": "Supprimer",
    "settings.recipientCerts": "Certificats des destinataires",
    "settings.recipientCertsDesc": "Certificats publics (PEM/DER) des personnes à qui vous souhaitez envoyer du courrier chiffré. Les certificats des signataires de courriers valablement signés sont enregistrés automatiquement.",
    "settings.importCert": "Importer un certificat",
    "settings.noCerts": "Aucun certificat de destinataire.",
    "settings.certExpires": "expire le {date}",
    "settings.remove": "Retirer",
    "settings.defaults": "Valeurs par défaut pour les nouveaux messages",
    "settings.defaultSign": "Signer les nouveaux messages par défaut",
    "settings.defaultEncrypt": "Chiffrer les nouveaux messages par défaut (si tous les destinataires ont un certificat)",
    "settings.importKeyDialogTitle": "Importer une clé S/MIME",
    "settings.importKeyDialogMessage": "Importation de « {file} ».",
    "settings.importDialogConfirm": "Importer",
    "settings.p12PassLabel": "Mot de passe protégeant le fichier .p12/.pfx",
    "settings.p12PassPlaceholder": "Laissez vide si le fichier n'en a pas",
    "settings.storagePassLabel": "Nouveau mot de passe pour protéger cette clé dans votre navigateur",
    "settings.storagePassRequired": "Un mot de passe de stockage est requis",
    "settings.importKeySuccess": "Clé S/MIME importée pour {email}",
    "settings.importKeyFailed": "Échec de l'importation : {reason}",
    "settings.unlockDialogTitle": "Déverrouiller {email}",
    "settings.unlockConfirm": "Déverrouiller",
    "settings.storagePassForKeyLabel": "Mot de passe de stockage pour cette clé",
    "settings.unlockSuccess": "{email} déverrouillée",
    "settings.unlockFailed": "Échec du déverrouillage",
    "settings.keyFallback": "clé",
    "settings.lockedToast": "{email} verrouillée",
    "settings.deleteDialogTitle": "Supprimer la clé S/MIME",
    "settings.deleteDialogMessage": "Supprimer la clé privée et le certificat de {email} ? Vous ne pourrez plus déchiffrer le courrier qui lui est destiné.",
    "settings.deleteDialogFallbackIdentity": "cette identité",
    "settings.deleteConfirm": "Supprimer",
    "settings.keyDeletedToast": "Clé supprimée",
    "settings.certNoEmail": "Le certificat n'a pas d'adresse e-mail",
    "settings.importCertSuccess": "Certificat importé pour {email}",
    "settings.importCertFailed": "Échec de l'import du certificat : {reason}",
    "settings.unlockSendDialogTitle": "Déverrouiller la clé S/MIME",
    "settings.unlockSendDialogMessage": "Votre clé pour {email} est verrouillée. Saisissez son mot de passe de stockage pour signer et envoyer.",
    "settings.unlockAndSend": "Déverrouiller et envoyer",
    "settings.storagePassphrase": "Mot de passe de stockage",
    "settings.unlockFailedWrongPass": "Échec du déverrouillage — mot de passe incorrect ?",
    "settings.notPrivilegedToast": "Impossible de signer/chiffrer : S/MIME ne fonctionne pas dans le niveau privilégié."
  },
  "it": {
    "banner.encryption": "Crittografia",
    "banner.decrypted": "Decrittografato",
    "banner.encryptedLocked": "Crittografato — sblocca la tua chiave per leggere",
    "banner.encryptedFailed": "Crittografato — impossibile decrittografare con le tue chiavi",
    "banner.encryptedMessage": "Messaggio crittografato",
    "banner.signature": "Firma",
    "banner.validSignature": "Firma valida",
    "banner.validSignatureBy": "Firma valida — {email}",
    "banner.signedMessage": "Messaggio firmato",
    "banner.invalidSignature": "Firma non valida: {reason}",
    "banner.selfSignedBadge": "autofirmato",
    "banner.signerMismatchBadge": "firmatario ≠ mittente",
    "banner.unlockNow": "Sblocca ora",
    "banner.unlocking": "Sblocco in corso…",
    "banner.viewCertDetails": "Visualizza dettagli certificato",
    "banner.hideCertDetails": "Nascondi dettagli certificato",
    "banner.downloadCert": "Scarica certificato",
    "banner.certSubject": "Intestatario",
    "banner.certIssuer": "Emittente",
    "banner.certEmail": "Email",
    "banner.certValid": "Valido",
    "banner.certFingerprint": "Impronta digitale (SHA-256)",
    "toolbar.sign": "Firma",
    "toolbar.encrypt": "Crittografa",
    "toolbar.signTitle": "Firma digitalmente questo messaggio",
    "toolbar.encryptTitle": "Crittografa questo messaggio per i destinatari",
    "toolbar.needKey": "S/MIME: importa una chiave nelle Impostazioni per firmare/crittografare",
    "settings.title": "Chiavi e certificati S/MIME",
    "banner.copyCert": "Copia negli appunti",
    "banner.copied": "Copiato!",
    "banner.copyChain": "Copia con catena",
    "banner.certChain": "Catena",
    "banner.certChainCount": "{count} certificato/i aggiuntivo/i incluso/i",
    "settings.notActive": "S/MIME non è attivo",
    "settings.yourKeys": "Le tue chiavi",
    "settings.yourKeysDesc": "Importa un file PKCS#12 (.p12/.pfx) contenente il tuo certificato e la chiave privata. La chiave viene crittografata nel browser e non ne esce mai.",
    "settings.importKey": "Importa chiave",
    "settings.noKeys": "Nessuna chiave importata finora.",
    "settings.certUnknown": "Certificato",
    "settings.validRange": "valido {from} – {to}",
    "settings.expired": "SCADUTO",
    "settings.capSign": "firma",
    "settings.capEncrypt": "crittografia",
    "settings.lock": "Blocca",
    "settings.unlock": "Sblocca",
    "settings.delete": "Elimina",
    "settings.recipientCerts": "Certificati destinatari",
    "settings.recipientCertsDesc": "Certificati pubblici (PEM/DER) delle persone a cui vuoi inviare posta crittografata. I certificati del firmatario di posta validamente firmata vengono salvati automaticamente.",
    "settings.importCert": "Importa certificato",
    "settings.noCerts": "Nessun certificato destinatario.",
    "settings.certExpires": "scade il {date}",
    "settings.remove": "Rimuovi",
    "settings.defaults": "Impostazioni predefinite per i nuovi messaggi",
    "settings.defaultSign": "Firma i nuovi messaggi per impostazione predefinita",
    "settings.defaultEncrypt": "Crittografa i nuovi messaggi per impostazione predefinita (quando tutti i destinatari hanno un certificato)",
    "settings.importKeyDialogTitle": "Importa chiave S/MIME",
    "settings.importKeyDialogMessage": "Importazione di \"{file}\".",
    "settings.importDialogConfirm": "Importa",
    "settings.p12PassLabel": "Passphrase che protegge il file .p12/.pfx",
    "settings.p12PassPlaceholder": "Lascia vuoto se il file non ne ha una",
    "settings.storagePassLabel": "Nuova passphrase per proteggere questa chiave nel browser",
    "settings.storagePassRequired": "È richiesta una passphrase di archiviazione",
    "settings.importKeySuccess": "Chiave S/MIME importata per {email}",
    "settings.importKeyFailed": "Importazione non riuscita: {reason}",
    "settings.unlockDialogTitle": "Sblocca {email}",
    "settings.unlockConfirm": "Sblocca",
    "settings.storagePassForKeyLabel": "Passphrase di archiviazione per questa chiave",
    "settings.unlockSuccess": "{email} sbloccata",
    "settings.unlockFailed": "Sblocco non riuscito",
    "settings.keyFallback": "chiave",
    "settings.lockedToast": "{email} bloccata",
    "settings.deleteDialogTitle": "Elimina chiave S/MIME",
    "settings.deleteDialogMessage": "Eliminare la chiave privata e il certificato per {email}? Non sarà più possibile decrittografare la posta a lei destinata.",
    "settings.deleteDialogFallbackIdentity": "questa identità",
    "settings.deleteConfirm": "Elimina",
    "settings.keyDeletedToast": "Chiave eliminata",
    "settings.certNoEmail": "Il certificato non ha un indirizzo email",
    "settings.importCertSuccess": "Certificato importato per {email}",
    "settings.importCertFailed": "Importazione del certificato non riuscita: {reason}",
    "settings.unlockSendDialogTitle": "Sblocca chiave S/MIME",
    "settings.unlockSendDialogMessage": "La tua chiave per {email} è bloccata. Inserisci la passphrase di archiviazione per firmare e inviare.",
    "settings.unlockAndSend": "Sblocca e invia",
    "settings.storagePassphrase": "Passphrase di archiviazione",
    "settings.unlockFailedWrongPass": "Sblocco non riuscito — passphrase errata?",
    "settings.notPrivilegedToast": "Impossibile firmare/crittografare: S/MIME non è in esecuzione nel livello privilegiato."
  },
  "pt": {
    "banner.encryption": "Criptografia",
    "banner.decrypted": "Descriptografado",
    "banner.encryptedLocked": "Criptografado — desbloqueie sua chave para ler",
    "banner.encryptedFailed": "Criptografado — não foi possível descriptografar com suas chaves",
    "banner.encryptedMessage": "Mensagem criptografada",
    "banner.signature": "Assinatura",
    "banner.validSignature": "Assinatura válida",
    "banner.validSignatureBy": "Assinatura válida — {email}",
    "banner.signedMessage": "Mensagem assinada",
    "banner.invalidSignature": "Assinatura inválida: {reason}",
    "banner.selfSignedBadge": "autoassinado",
    "banner.signerMismatchBadge": "signatário ≠ remetente",
    "banner.unlockNow": "Desbloquear agora",
    "banner.unlocking": "Desbloqueando…",
    "banner.viewCertDetails": "Ver detalhes do certificado",
    "banner.hideCertDetails": "Ocultar detalhes do certificado",
    "banner.downloadCert": "Baixar certificado",
    "banner.certSubject": "Titular",
    "banner.certIssuer": "Emissor",
    "banner.certEmail": "E-mail",
    "banner.certValid": "Válido",
    "banner.certFingerprint": "Impressão digital (SHA-256)",
    "toolbar.sign": "Assinar",
    "toolbar.encrypt": "Criptografar",
    "toolbar.signTitle": "Assinar digitalmente esta mensagem",
    "toolbar.encryptTitle": "Criptografar esta mensagem para os destinatários",
    "toolbar.needKey": "S/MIME: importe uma chave em Configurações para assinar/criptografar",
    "settings.title": "Chaves e certificados S/MIME",
    "banner.copyCert": "Copiar para a área de transferência",
    "banner.copied": "Copiado!",
    "banner.copyChain": "Copiar com cadeia",
    "banner.certChain": "Cadeia",
    "banner.certChainCount": "{count} certificado(s) adicional(is) incluído(s)",
    "settings.notActive": "O S/MIME não está ativo",
    "settings.yourKeys": "Suas chaves",
    "settings.yourKeysDesc": "Importe um arquivo PKCS#12 (.p12/.pfx) contendo seu certificado e chave privada. A chave é criptografada no seu navegador e nunca sai dele.",
    "settings.importKey": "Importar chave",
    "settings.noKeys": "Nenhuma chave importada ainda.",
    "settings.certUnknown": "Certificado",
    "settings.validRange": "válido {from} – {to}",
    "settings.expired": "EXPIRADO",
    "settings.capSign": "assinar",
    "settings.capEncrypt": "criptografar",
    "settings.lock": "Bloquear",
    "settings.unlock": "Desbloquear",
    "settings.delete": "Excluir",
    "settings.recipientCerts": "Certificados de destinatários",
    "settings.recipientCertsDesc": "Certificados públicos (PEM/DER) das pessoas para quem deseja enviar e-mail criptografado. Os certificados do signatário de e-mails validamente assinados são salvos automaticamente.",
    "settings.importCert": "Importar certificado",
    "settings.noCerts": "Nenhum certificado de destinatário.",
    "settings.certExpires": "expira em {date}",
    "settings.remove": "Remover",
    "settings.defaults": "Padrões para novas mensagens",
    "settings.defaultSign": "Assinar novas mensagens por padrão",
    "settings.defaultEncrypt": "Criptografar novas mensagens por padrão (quando todos os destinatários tiverem certificados)",
    "settings.importKeyDialogTitle": "Importar chave S/MIME",
    "settings.importKeyDialogMessage": "Importando \"{file}\".",
    "settings.importDialogConfirm": "Importar",
    "settings.p12PassLabel": "Senha que protege o arquivo .p12/.pfx",
    "settings.p12PassPlaceholder": "Deixe em branco se o arquivo não tiver",
    "settings.storagePassLabel": "Nova senha para proteger esta chave no navegador",
    "settings.storagePassRequired": "É necessária uma senha de armazenamento",
    "settings.importKeySuccess": "Chave S/MIME importada para {email}",
    "settings.importKeyFailed": "Falha na importação: {reason}",
    "settings.unlockDialogTitle": "Desbloquear {email}",
    "settings.unlockConfirm": "Desbloquear",
    "settings.storagePassForKeyLabel": "Senha de armazenamento para esta chave",
    "settings.unlockSuccess": "{email} desbloqueada",
    "settings.unlockFailed": "Falha ao desbloquear",
    "settings.keyFallback": "chave",
    "settings.lockedToast": "{email} bloqueada",
    "settings.deleteDialogTitle": "Excluir chave S/MIME",
    "settings.deleteDialogMessage": "Excluir a chave privada e o certificado de {email}? Você não poderá mais descriptografar e-mails criptografados para ela.",
    "settings.deleteDialogFallbackIdentity": "esta identidade",
    "settings.deleteConfirm": "Excluir",
    "settings.keyDeletedToast": "Chave excluída",
    "settings.certNoEmail": "O certificado não tem endereço de e-mail",
    "settings.importCertSuccess": "Certificado importado para {email}",
    "settings.importCertFailed": "Falha ao importar certificado: {reason}",
    "settings.unlockSendDialogTitle": "Desbloquear chave S/MIME",
    "settings.unlockSendDialogMessage": "Sua chave para {email} está bloqueada. Digite a senha de armazenamento para assinar e enviar.",
    "settings.unlockAndSend": "Desbloquear e enviar",
    "settings.storagePassphrase": "Senha de armazenamento",
    "settings.unlockFailedWrongPass": "Falha ao desbloquear — senha incorreta?",
    "settings.notPrivilegedToast": "Não é possível assinar/criptografar: o S/MIME não está em execução no nível privilegiado."
  },
  "nl": {
    "banner.encryption": "Versleuteling",
    "banner.decrypted": "Ontsleuteld",
    "banner.encryptedLocked": "Versleuteld — ontgrendel uw sleutel om te lezen",
    "banner.encryptedFailed": "Versleuteld — kon niet worden ontsleuteld met uw sleutels",
    "banner.encryptedMessage": "Versleuteld bericht",
    "banner.signature": "Handtekening",
    "banner.validSignature": "Geldige handtekening",
    "banner.validSignatureBy": "Geldige handtekening — {email}",
    "banner.signedMessage": "Ondertekend bericht",
    "banner.invalidSignature": "Ongeldige handtekening: {reason}",
    "banner.selfSignedBadge": "zelfondertekend",
    "banner.signerMismatchBadge": "ondertekenaar ≠ afzender",
    "banner.unlockNow": "Nu ontgrendelen",
    "banner.unlocking": "Ontgrendelen…",
    "banner.viewCertDetails": "Certificaatgegevens weergeven",
    "banner.hideCertDetails": "Certificaatgegevens verbergen",
    "banner.downloadCert": "Certificaat downloaden",
    "banner.certSubject": "Onderwerp",
    "banner.certIssuer": "Uitgever",
    "banner.certEmail": "E-mail",
    "banner.certValid": "Geldig",
    "banner.certFingerprint": "Vingerafdruk (SHA-256)",
    "toolbar.sign": "Ondertekenen",
    "toolbar.encrypt": "Versleutelen",
    "toolbar.signTitle": "Dit bericht digitaal ondertekenen",
    "toolbar.encryptTitle": "Dit bericht versleutelen voor de ontvangers",
    "toolbar.needKey": "S/MIME: importeer een sleutel in Instellingen om te ondertekenen/versleutelen",
    "settings.title": "S/MIME-sleutels & certificaten",
    "banner.copyCert": "Naar klembord kopiëren",
    "banner.copied": "Gekopieerd!",
    "banner.copyChain": "Kopiëren met keten",
    "banner.certChain": "Keten",
    "banner.certChainCount": "{count} extra certifica(a)t(en) inbegrepen",
    "settings.notActive": "S/MIME is niet actief",
    "settings.yourKeys": "Uw sleutels",
    "settings.yourKeysDesc": "Importeer een PKCS#12-bestand (.p12/.pfx) met uw certificaat en privésleutel. De sleutel wordt in uw browser versleuteld en verlaat deze nooit.",
    "settings.importKey": "Sleutel importeren",
    "settings.noKeys": "Nog geen sleutels geïmporteerd.",
    "settings.certUnknown": "Certificaat",
    "settings.validRange": "geldig {from} – {to}",
    "settings.expired": "VERLOPEN",
    "settings.capSign": "ondertekenen",
    "settings.capEncrypt": "versleutelen",
    "settings.lock": "Vergrendelen",
    "settings.unlock": "Ontgrendelen",
    "settings.delete": "Verwijderen",
    "settings.recipientCerts": "Certificaten van ontvangers",
    "settings.recipientCertsDesc": "Openbare certificaten (PEM/DER) van personen aan wie u versleutelde mail wilt sturen. Certificaten van ondertekenaars uit geldig ondertekende mail worden automatisch opgeslagen.",
    "settings.importCert": "Certificaat importeren",
    "settings.noCerts": "Geen certificaten van ontvangers.",
    "settings.certExpires": "verloopt op {date}",
    "settings.remove": "Verwijderen",
    "settings.defaults": "Standaardinstellingen voor nieuwe berichten",
    "settings.defaultSign": "Nieuwe berichten standaard ondertekenen",
    "settings.defaultEncrypt": "Nieuwe berichten standaard versleutelen (als alle ontvangers certificaten hebben)",
    "settings.importKeyDialogTitle": "S/MIME-sleutel importeren",
    "settings.importKeyDialogMessage": "Bezig met importeren van \"{file}\".",
    "settings.importDialogConfirm": "Importeren",
    "settings.p12PassLabel": "Wachtwoord dat het .p12/.pfx-bestand beschermt",
    "settings.p12PassPlaceholder": "Laat leeg als het bestand er geen heeft",
    "settings.storagePassLabel": "Nieuw wachtwoord om deze sleutel in uw browser te beschermen",
    "settings.storagePassRequired": "Er is een opslagwachtwoord vereist",
    "settings.importKeySuccess": "S/MIME-sleutel geïmporteerd voor {email}",
    "settings.importKeyFailed": "Importeren mislukt: {reason}",
    "settings.unlockDialogTitle": "{email} ontgrendelen",
    "settings.unlockConfirm": "Ontgrendelen",
    "settings.storagePassForKeyLabel": "Opslagwachtwoord voor deze sleutel",
    "settings.unlockSuccess": "{email} ontgrendeld",
    "settings.unlockFailed": "Ontgrendelen mislukt",
    "settings.keyFallback": "sleutel",
    "settings.lockedToast": "{email} vergrendeld",
    "settings.deleteDialogTitle": "S/MIME-sleutel verwijderen",
    "settings.deleteDialogMessage": "Privésleutel en certificaat voor {email} verwijderen? U kunt dan geen mail meer ontsleutelen die daarvoor versleuteld is.",
    "settings.deleteDialogFallbackIdentity": "deze identiteit",
    "settings.deleteConfirm": "Verwijderen",
    "settings.keyDeletedToast": "Sleutel verwijderd",
    "settings.certNoEmail": "Certificaat heeft geen e-mailadres",
    "settings.importCertSuccess": "Certificaat geïmporteerd voor {email}",
    "settings.importCertFailed": "Certificaat importeren mislukt: {reason}",
    "settings.unlockSendDialogTitle": "S/MIME-sleutel ontgrendelen",
    "settings.unlockSendDialogMessage": "Uw sleutel voor {email} is vergrendeld. Voer het opslagwachtwoord in om te ondertekenen en te verzenden.",
    "settings.unlockAndSend": "Ontgrendelen & verzenden",
    "settings.storagePassphrase": "Opslagwachtwoord",
    "settings.unlockFailedWrongPass": "Ontgrendelen mislukt — onjuist wachtwoord?",
    "settings.notPrivilegedToast": "Kan niet ondertekenen/versleutelen: S/MIME draait niet in de privileged tier."
  },
  "ru": {
    "banner.encryption": "Шифрование",
    "banner.decrypted": "Расшифровано",
    "banner.encryptedLocked": "Зашифровано — разблокируйте ключ для чтения",
    "banner.encryptedFailed": "Зашифровано — не удалось расшифровать имеющимися ключами",
    "banner.encryptedMessage": "Зашифрованное сообщение",
    "banner.signature": "Подпись",
    "banner.validSignature": "Подпись действительна",
    "banner.validSignatureBy": "Подпись действительна — {email}",
    "banner.signedMessage": "Подписанное сообщение",
    "banner.invalidSignature": "Недействительная подпись: {reason}",
    "banner.selfSignedBadge": "самоподписанный",
    "banner.signerMismatchBadge": "подписант ≠ отправитель",
    "banner.unlockNow": "Разблокировать",
    "banner.unlocking": "Разблокировка…",
    "banner.viewCertDetails": "Показать данные сертификата",
    "banner.hideCertDetails": "Скрыть данные сертификата",
    "banner.downloadCert": "Скачать сертификат",
    "banner.certSubject": "Владелец",
    "banner.certIssuer": "Издатель",
    "banner.certEmail": "Эл. почта",
    "banner.certValid": "Срок действия",
    "banner.certFingerprint": "Отпечаток (SHA-256)",
    "toolbar.sign": "Подписать",
    "toolbar.encrypt": "Зашифровать",
    "toolbar.signTitle": "Подписать это сообщение цифровой подписью",
    "toolbar.encryptTitle": "Зашифровать это сообщение для получателей",
    "toolbar.needKey": "S/MIME: импортируйте ключ в настройках, чтобы подписывать/шифровать",
    "settings.title": "Ключи и сертификаты S/MIME",
    "banner.copyCert": "Скопировать в буфер обмена",
    "banner.copied": "Скопировано!",
    "banner.copyChain": "Копировать с цепочкой",
    "banner.certChain": "Цепочка",
    "banner.certChainCount": "включено доп. сертификатов: {count}",
    "settings.notActive": "S/MIME не активен",
    "settings.yourKeys": "Ваши ключи",
    "settings.yourKeysDesc": "Импортируйте файл PKCS#12 (.p12/.pfx) с вашим сертификатом и закрытым ключом. Ключ шифруется в браузере и никогда не покидает его.",
    "settings.importKey": "Импортировать ключ",
    "settings.noKeys": "Ключи ещё не импортированы.",
    "settings.certUnknown": "Сертификат",
    "settings.validRange": "действителен {from} – {to}",
    "settings.expired": "ИСТЁК",
    "settings.capSign": "подпись",
    "settings.capEncrypt": "шифрование",
    "settings.lock": "Заблокировать",
    "settings.unlock": "Разблокировать",
    "settings.delete": "Удалить",
    "settings.recipientCerts": "Сертификаты получателей",
    "settings.recipientCertsDesc": "Открытые сертификаты (PEM/DER) людей, которым вы хотите отправлять зашифрованную почту. Сертификаты подписавших из корректно подписанных писем сохраняются автоматически.",
    "settings.importCert": "Импортировать сертификат",
    "settings.noCerts": "Нет сертификатов получателей.",
    "settings.certExpires": "истекает {date}",
    "settings.remove": "Удалить",
    "settings.defaults": "Значения по умолчанию для новых сообщений",
    "settings.defaultSign": "Подписывать новые сообщения по умолчанию",
    "settings.defaultEncrypt": "Шифровать новые сообщения по умолчанию (если у всех получателей есть сертификаты)",
    "settings.importKeyDialogTitle": "Импорт ключа S/MIME",
    "settings.importKeyDialogMessage": "Импорт файла «{file}».",
    "settings.importDialogConfirm": "Импортировать",
    "settings.p12PassLabel": "Пароль, защищающий файл .p12/.pfx",
    "settings.p12PassPlaceholder": "Оставьте пустым, если у файла его нет",
    "settings.storagePassLabel": "Новый пароль для защиты этого ключа в браузере",
    "settings.storagePassRequired": "Требуется пароль для хранения",
    "settings.importKeySuccess": "Ключ S/MIME импортирован для {email}",
    "settings.importKeyFailed": "Ошибка импорта: {reason}",
    "settings.unlockDialogTitle": "Разблокировать {email}",
    "settings.unlockConfirm": "Разблокировать",
    "settings.storagePassForKeyLabel": "Пароль хранения для этого ключа",
    "settings.unlockSuccess": "{email} разблокирован",
    "settings.unlockFailed": "Не удалось разблокировать",
    "settings.keyFallback": "ключ",
    "settings.lockedToast": "{email} заблокирован",
    "settings.deleteDialogTitle": "Удалить ключ S/MIME",
    "settings.deleteDialogMessage": "Удалить закрытый ключ и сертификат для {email}? Вы больше не сможете расшифровывать почту, зашифрованную для него.",
    "settings.deleteDialogFallbackIdentity": "эту личность",
    "settings.deleteConfirm": "Удалить",
    "settings.keyDeletedToast": "Ключ удалён",
    "settings.certNoEmail": "У сертификата нет адреса эл. почты",
    "settings.importCertSuccess": "Сертификат импортирован для {email}",
    "settings.importCertFailed": "Ошибка импорта сертификата: {reason}",
    "settings.unlockSendDialogTitle": "Разблокировать ключ S/MIME",
    "settings.unlockSendDialogMessage": "Ваш ключ для {email} заблокирован. Введите пароль хранения, чтобы подписать и отправить.",
    "settings.unlockAndSend": "Разблокировать и отправить",
    "settings.storagePassphrase": "Пароль хранения",
    "settings.unlockFailedWrongPass": "Не удалось разблокировать — неверный пароль?",
    "settings.notPrivilegedToast": "Невозможно подписать/зашифровать: S/MIME не работает в привилегированном режиме."
  },
  "zh": {
    "banner.encryption": "加密",
    "banner.decrypted": "已解密",
    "banner.encryptedLocked": "已加密 — 请解锁密钥以阅读",
    "banner.encryptedFailed": "已加密 — 无法使用您的密钥解密",
    "banner.encryptedMessage": "加密邮件",
    "banner.signature": "签名",
    "banner.validSignature": "签名有效",
    "banner.validSignatureBy": "签名有效 — {email}",
    "banner.signedMessage": "已签名邮件",
    "banner.invalidSignature": "签名无效：{reason}",
    "banner.selfSignedBadge": "自签名",
    "banner.signerMismatchBadge": "签名人 ≠ 发件人",
    "banner.unlockNow": "立即解锁",
    "banner.unlocking": "正在解锁…",
    "banner.viewCertDetails": "查看证书详情",
    "banner.hideCertDetails": "隐藏证书详情",
    "banner.downloadCert": "下载证书",
    "banner.certSubject": "主体",
    "banner.certIssuer": "颁发者",
    "banner.certEmail": "电子邮件",
    "banner.certValid": "有效期",
    "banner.certFingerprint": "指纹（SHA-256）",
    "toolbar.sign": "签名",
    "toolbar.encrypt": "加密",
    "toolbar.signTitle": "对此邮件进行数字签名",
    "toolbar.encryptTitle": "为收件人加密此邮件",
    "toolbar.needKey": "S/MIME：请在设置中导入密钥以签名/加密",
    "settings.title": "S/MIME 密钥与证书",
    "banner.copyCert": "复制到剪贴板",
    "banner.copied": "已复制！",
    "banner.copyChain": "复制（含证书链）",
    "banner.certChain": "证书链",
    "banner.certChainCount": "包含 {count} 个附加证书",
    "settings.notActive": "S/MIME 未启用",
    "settings.yourKeys": "您的密钥",
    "settings.yourKeysDesc": "导入包含您的证书和私钥的 PKCS#12（.p12/.pfx）文件。密钥在浏览器中加密，永远不会离开浏览器。",
    "settings.importKey": "导入密钥",
    "settings.noKeys": "尚未导入任何密钥。",
    "settings.certUnknown": "证书",
    "settings.validRange": "有效期 {from} 至 {to}",
    "settings.expired": "已过期",
    "settings.capSign": "签名",
    "settings.capEncrypt": "加密",
    "settings.lock": "锁定",
    "settings.unlock": "解锁",
    "settings.delete": "删除",
    "settings.recipientCerts": "收件人证书",
    "settings.recipientCertsDesc": "您想向其发送加密邮件的人员的公钥证书（PEM/DER）。来自有效签名邮件的签名者证书会自动保存。",
    "settings.importCert": "导入证书",
    "settings.noCerts": "没有收件人证书。",
    "settings.certExpires": "{date} 到期",
    "settings.remove": "移除",
    "settings.defaults": "新邮件的默认设置",
    "settings.defaultSign": "默认对新邮件签名",
    "settings.defaultEncrypt": "默认加密新邮件（当所有收件人都有证书时）",
    "settings.importKeyDialogTitle": "导入 S/MIME 密钥",
    "settings.importKeyDialogMessage": "正在导入 \"{file}\"。",
    "settings.importDialogConfirm": "导入",
    "settings.p12PassLabel": "保护 .p12/.pfx 文件的密码",
    "settings.p12PassPlaceholder": "如果文件没有密码请留空",
    "settings.storagePassLabel": "用于在浏览器中保护此密钥的新密码",
    "settings.storagePassRequired": "需要设置存储密码",
    "settings.importKeySuccess": "已为 {email} 导入 S/MIME 密钥",
    "settings.importKeyFailed": "导入失败：{reason}",
    "settings.unlockDialogTitle": "解锁 {email}",
    "settings.unlockConfirm": "解锁",
    "settings.storagePassForKeyLabel": "此密钥的存储密码",
    "settings.unlockSuccess": "已解锁 {email}",
    "settings.unlockFailed": "解锁失败",
    "settings.keyFallback": "密钥",
    "settings.lockedToast": "已锁定 {email}",
    "settings.deleteDialogTitle": "删除 S/MIME 密钥",
    "settings.deleteDialogMessage": "删除 {email} 的私钥和证书？之后将无法解密发给该地址的加密邮件。",
    "settings.deleteDialogFallbackIdentity": "该身份",
    "settings.deleteConfirm": "删除",
    "settings.keyDeletedToast": "密钥已删除",
    "settings.certNoEmail": "证书没有电子邮件地址",
    "settings.importCertSuccess": "已为 {email} 导入证书",
    "settings.importCertFailed": "证书导入失败：{reason}",
    "settings.unlockSendDialogTitle": "解锁 S/MIME 密钥",
    "settings.unlockSendDialogMessage": "您用于 {email} 的密钥已锁定。请输入其存储密码以签名并发送。",
    "settings.unlockAndSend": "解锁并发送",
    "settings.storagePassphrase": "存储密码",
    "settings.unlockFailedWrongPass": "解锁失败——密码错误？",
    "settings.notPrivilegedToast": "无法签名/加密：S/MIME 未在特权层级中运行。"
  },
  "ja": {
    "banner.encryption": "暗号化",
    "banner.decrypted": "復号済み",
    "banner.encryptedLocked": "暗号化されています — 読むには鍵のロックを解除してください",
    "banner.encryptedFailed": "暗号化されています — お使いの鍵では復号できませんでした",
    "banner.encryptedMessage": "暗号化されたメッセージ",
    "banner.signature": "署名",
    "banner.validSignature": "有効な署名",
    "banner.validSignatureBy": "有効な署名 — {email}",
    "banner.signedMessage": "署名付きメッセージ",
    "banner.invalidSignature": "無効な署名: {reason}",
    "banner.selfSignedBadge": "自己署名",
    "banner.signerMismatchBadge": "署名者 ≠ 差出人",
    "banner.unlockNow": "今すぐロック解除",
    "banner.unlocking": "ロック解除中…",
    "banner.viewCertDetails": "証明書の詳細を表示",
    "banner.hideCertDetails": "証明書の詳細を隠す",
    "banner.downloadCert": "証明書をダウンロード",
    "banner.certSubject": "サブジェクト",
    "banner.certIssuer": "発行者",
    "banner.certEmail": "メール",
    "banner.certValid": "有効期間",
    "banner.certFingerprint": "フィンガープリント（SHA-256）",
    "toolbar.sign": "署名",
    "toolbar.encrypt": "暗号化",
    "toolbar.signTitle": "このメッセージにデジタル署名する",
    "toolbar.encryptTitle": "受信者向けにこのメッセージを暗号化する",
    "toolbar.needKey": "S/MIME: 署名・暗号化するには設定で鍵をインポートしてください",
    "settings.title": "S/MIME 鍵と証明書",
    "banner.copyCert": "クリップボードにコピー",
    "banner.copied": "コピーしました！",
    "banner.copyChain": "チェーンを含めてコピー",
    "banner.certChain": "証明書チェーン",
    "banner.certChainCount": "追加証明書 {count} 件を含む",
    "settings.notActive": "S/MIME は有効になっていません",
    "settings.yourKeys": "あなたの鍵",
    "settings.yourKeysDesc": "証明書と秘密鍵を含む PKCS#12（.p12/.pfx）ファイルをインポートします。鍵はブラウザ内で暗号化され、外部に出ることはありません。",
    "settings.importKey": "鍵をインポート",
    "settings.noKeys": "まだ鍵がインポートされていません。",
    "settings.certUnknown": "証明書",
    "settings.validRange": "有効期間 {from} ～ {to}",
    "settings.expired": "期限切れ",
    "settings.capSign": "署名",
    "settings.capEncrypt": "暗号化",
    "settings.lock": "ロック",
    "settings.unlock": "ロック解除",
    "settings.delete": "削除",
    "settings.recipientCerts": "受信者証明書",
    "settings.recipientCertsDesc": "暗号化メールを送りたい相手の公開証明書（PEM/DER）。有効に署名されたメールの署名者証明書は自動的に保存されます。",
    "settings.importCert": "証明書をインポート",
    "settings.noCerts": "受信者証明書はありません。",
    "settings.certExpires": "有効期限 {date}",
    "settings.remove": "削除",
    "settings.defaults": "新規メッセージの既定値",
    "settings.defaultSign": "新規メッセージにデフォルトで署名する",
    "settings.defaultEncrypt": "新規メッセージをデフォルトで暗号化する（すべての受信者が証明書を持っている場合）",
    "settings.importKeyDialogTitle": "S/MIME 鍵をインポート",
    "settings.importKeyDialogMessage": "\"{file}\" をインポート中です。",
    "settings.importDialogConfirm": "インポート",
    "settings.p12PassLabel": "「.p12/.pfx」ファイルを保護するパスフレーズ",
    "settings.p12PassPlaceholder": "ファイルにパスフレーズがない場合は空欄のままにしてください",
    "settings.storagePassLabel": "この鍵をブラウザ内で保護するための新しいパスフレーズ",
    "settings.storagePassRequired": "保存用パスフレーズが必要です",
    "settings.importKeySuccess": "{email} 用の S/MIME 鍵をインポートしました",
    "settings.importKeyFailed": "インポートに失敗しました: {reason}",
    "settings.unlockDialogTitle": "{email} のロックを解除",
    "settings.unlockConfirm": "ロック解除",
    "settings.storagePassForKeyLabel": "この鍵の保存用パスフレーズ",
    "settings.unlockSuccess": "{email} のロックを解除しました",
    "settings.unlockFailed": "ロック解除に失敗しました",
    "settings.keyFallback": "鍵",
    "settings.lockedToast": "{email} をロックしました",
    "settings.deleteDialogTitle": "S/MIME 鍵を削除",
    "settings.deleteDialogMessage": "{email} の秘密鍵と証明書を削除しますか？ 削除後は、この宛先向けに暗号化されたメールを復号できなくなります。",
    "settings.deleteDialogFallbackIdentity": "この ID",
    "settings.deleteConfirm": "削除",
    "settings.keyDeletedToast": "鍵を削除しました",
    "settings.certNoEmail": "証明書にメールアドレスがありません",
    "settings.importCertSuccess": "{email} 用の証明書をインポートしました",
    "settings.importCertFailed": "証明書のインポートに失敗しました: {reason}",
    "settings.unlockSendDialogTitle": "S/MIME 鍵のロックを解除",
    "settings.unlockSendDialogMessage": "{email} 用の鍵がロックされています。署名して送信するには、保存用パスフレーズを入力してください。",
    "settings.unlockAndSend": "ロック解除して送信",
    "settings.storagePassphrase": "保存用パスフレーズ",
    "settings.unlockFailedWrongPass": "ロック解除に失敗しました — パスフレーズが違いますか？",
    "settings.notPrivilegedToast": "署名・暗号化できません: S/MIME が privileged tier で動作していません。"
  },
  "ko": {
    "banner.encryption": "암호화",
    "banner.decrypted": "복호화됨",
    "banner.encryptedLocked": "암호화됨 — 읽으려면 키 잠금을 해제하세요",
    "banner.encryptedFailed": "암호화됨 — 보유한 키로 복호화할 수 없습니다",
    "banner.encryptedMessage": "암호화된 메시지",
    "banner.signature": "서명",
    "banner.validSignature": "유효한 서명",
    "banner.validSignatureBy": "유효한 서명 — {email}",
    "banner.signedMessage": "서명된 메시지",
    "banner.invalidSignature": "유효하지 않은 서명: {reason}",
    "banner.selfSignedBadge": "자체 서명",
    "banner.signerMismatchBadge": "서명자 ≠ 보낸 사람",
    "banner.unlockNow": "지금 잠금 해제",
    "banner.unlocking": "잠금 해제 중…",
    "banner.viewCertDetails": "인증서 세부정보 보기",
    "banner.hideCertDetails": "인증서 세부정보 숨기기",
    "banner.downloadCert": "인증서 다운로드",
    "banner.certSubject": "주체",
    "banner.certIssuer": "발급자",
    "banner.certEmail": "이메일",
    "banner.certValid": "유효 기간",
    "banner.certFingerprint": "지문(SHA-256)",
    "toolbar.sign": "서명",
    "toolbar.encrypt": "암호화",
    "toolbar.signTitle": "이 메시지에 전자 서명하기",
    "toolbar.encryptTitle": "수신자를 위해 이 메시지 암호화하기",
    "toolbar.needKey": "S/MIME: 서명/암호화하려면 설정에서 키를 가져오세요",
    "settings.title": "S/MIME 키 및 인증서",
    "banner.copyCert": "클립보드에 복사",
    "banner.copied": "복사됨!",
    "banner.copyChain": "체인 포함하여 복사",
    "banner.certChain": "체인",
    "banner.certChainCount": "추가 인증서 {count}개 포함",
    "settings.notActive": "S/MIME이 활성화되어 있지 않습니다",
    "settings.yourKeys": "내 키",
    "settings.yourKeysDesc": "인증서와 개인 키가 포함된 PKCS#12(.p12/.pfx) 파일을 가져옵니다. 키는 브라우저에서 암호화되며 브라우저를 벗어나지 않습니다.",
    "settings.importKey": "키 가져오기",
    "settings.noKeys": "아직 가져온 키가 없습니다.",
    "settings.certUnknown": "인증서",
    "settings.validRange": "유효 기간 {from} – {to}",
    "settings.expired": "만료됨",
    "settings.capSign": "서명",
    "settings.capEncrypt": "암호화",
    "settings.lock": "잠금",
    "settings.unlock": "잠금 해제",
    "settings.delete": "삭제",
    "settings.recipientCerts": "수신자 인증서",
    "settings.recipientCertsDesc": "암호화된 메일을 보낼 사람의 공개 인증서(PEM/DER)입니다. 유효하게 서명된 메일의 서명자 인증서는 자동으로 저장됩니다.",
    "settings.importCert": "인증서 가져오기",
    "settings.noCerts": "수신자 인증서가 없습니다.",
    "settings.certExpires": "{date} 만료",
    "settings.remove": "제거",
    "settings.defaults": "새 메시지 기본값",
    "settings.defaultSign": "새 메시지에 기본적으로 서명",
    "settings.defaultEncrypt": "새 메시지 기본적으로 암호화(모든 수신자가 인증서를 보유한 경우)",
    "settings.importKeyDialogTitle": "S/MIME 키 가져오기",
    "settings.importKeyDialogMessage": "\"{file}\" 가져오는 중입니다.",
    "settings.importDialogConfirm": "가져오기",
    "settings.p12PassLabel": ".p12/.pfx 파일을 보호하는 암호",
    "settings.p12PassPlaceholder": "파일에 암호가 없으면 비워 두세요",
    "settings.storagePassLabel": "이 키를 브라우저에서 보호할 새 암호",
    "settings.storagePassRequired": "저장용 암호가 필요합니다",
    "settings.importKeySuccess": "{email}의 S/MIME 키를 가져왔습니다",
    "settings.importKeyFailed": "가져오기 실패: {reason}",
    "settings.unlockDialogTitle": "{email} 잠금 해제",
    "settings.unlockConfirm": "잠금 해제",
    "settings.storagePassForKeyLabel": "이 키의 저장용 암호",
    "settings.unlockSuccess": "{email} 잠금 해제됨",
    "settings.unlockFailed": "잠금 해제 실패",
    "settings.keyFallback": "키",
    "settings.lockedToast": "{email} 잠금됨",
    "settings.deleteDialogTitle": "S/MIME 키 삭제",
    "settings.deleteDialogMessage": "{email}의 개인 키와 인증서를 삭제하시겠습니까? 이후 해당 주소로 암호화된 메일을 복호화할 수 없습니다.",
    "settings.deleteDialogFallbackIdentity": "이 신원",
    "settings.deleteConfirm": "삭제",
    "settings.keyDeletedToast": "키 삭제됨",
    "settings.certNoEmail": "인증서에 이메일 주소가 없습니다",
    "settings.importCertSuccess": "{email}의 인증서를 가져왔습니다",
    "settings.importCertFailed": "인증서 가져오기 실패: {reason}",
    "settings.unlockSendDialogTitle": "S/MIME 키 잠금 해제",
    "settings.unlockSendDialogMessage": "{email}의 키가 잠겨 있습니다. 서명하고 보내려면 저장용 암호를 입력하세요.",
    "settings.unlockAndSend": "잠금 해제 후 보내기",
    "settings.storagePassphrase": "저장용 암호",
    "settings.unlockFailedWrongPass": "잠금 해제 실패 — 암호가 틀렸나요?",
    "settings.notPrivilegedToast": "서명/암호화할 수 없음: S/MIME이 privileged tier에서 실행되고 있지 않습니다."
  },
  "ar": {
    "banner.encryption": "التشفير",
    "banner.decrypted": "تم فك التشفير",
    "banner.encryptedLocked": "مشفّرة — افتح قفل مفتاحك للقراءة",
    "banner.encryptedFailed": "مشفّرة — تعذّر فك التشفير بالمفاتيح المتاحة لديك",
    "banner.encryptedMessage": "رسالة مشفّرة",
    "banner.signature": "التوقيع",
    "banner.validSignature": "توقيع صالح",
    "banner.validSignatureBy": "توقيع صالح — {email}",
    "banner.signedMessage": "رسالة موقّعة",
    "banner.invalidSignature": "توقيع غير صالح: {reason}",
    "banner.selfSignedBadge": "موقّع ذاتيًا",
    "banner.signerMismatchBadge": "الموقّع ≠ المُرسِل",
    "banner.unlockNow": "فتح القفل الآن",
    "banner.unlocking": "جارٍ فتح القفل…",
    "banner.viewCertDetails": "عرض تفاصيل الشهادة",
    "banner.hideCertDetails": "إخفاء تفاصيل الشهادة",
    "banner.downloadCert": "تنزيل الشهادة",
    "banner.certSubject": "الجهة",
    "banner.certIssuer": "المُصدِر",
    "banner.certEmail": "البريد الإلكتروني",
    "banner.certValid": "صالحة من",
    "banner.certFingerprint": "البصمة (SHA-256)",
    "toolbar.sign": "توقيع",
    "toolbar.encrypt": "تشفير",
    "toolbar.signTitle": "توقيع هذه الرسالة رقميًا",
    "toolbar.encryptTitle": "تشفير هذه الرسالة للمستلمين",
    "toolbar.needKey": "S/MIME: استورد مفتاحًا من الإعدادات للتوقيع/التشفير",
    "settings.title": "مفاتيح وشهادات S/MIME",
    "banner.copyCert": "نسخ إلى الحافظة",
    "banner.copied": "تم النسخ!",
    "banner.copyChain": "نسخ مع السلسلة",
    "banner.certChain": "السلسلة",
    "banner.certChainCount": "تتضمن {count} شهادة إضافية",
    "settings.notActive": "S/MIME غير مُفعّل",
    "settings.yourKeys": "مفاتيحك",
    "settings.yourKeysDesc": "استورد ملف PKCS#12 (.p12/.pfx) يحتوي على شهادتك ومفتاحك الخاص. يُشفَّر المفتاح في متصفحك ولا يغادره أبدًا.",
    "settings.importKey": "استيراد مفتاح",
    "settings.noKeys": "لم يتم استيراد أي مفاتيح بعد.",
    "settings.certUnknown": "شهادة",
    "settings.validRange": "صالحة من {from} إلى {to}",
    "settings.expired": "منتهية الصلاحية",
    "settings.capSign": "التوقيع",
    "settings.capEncrypt": "التشفير",
    "settings.lock": "قفل",
    "settings.unlock": "فتح القفل",
    "settings.delete": "حذف",
    "settings.recipientCerts": "شهادات المستلمين",
    "settings.recipientCertsDesc": "الشهادات العامة (PEM/DER) للأشخاص الذين تريد إرسال بريد مشفّر إليهم. تُحفَظ شهادات الموقّعين من الرسائل الموقّعة بشكل صحيح تلقائيًا.",
    "settings.importCert": "استيراد شهادة",
    "settings.noCerts": "لا توجد شهادات مستلمين.",
    "settings.certExpires": "تنتهي في {date}",
    "settings.remove": "إزالة",
    "settings.defaults": "الإعدادات الافتراضية للرسائل الجديدة",
    "settings.defaultSign": "توقيع الرسائل الجديدة افتراضيًا",
    "settings.defaultEncrypt": "تشفير الرسائل الجديدة افتراضيًا (عندما يملك جميع المستلمين شهادات)",
    "settings.importKeyDialogTitle": "استيراد مفتاح S/MIME",
    "settings.importKeyDialogMessage": "جارٍ استيراد \"{file}\".",
    "settings.importDialogConfirm": "استيراد",
    "settings.p12PassLabel": "كلمة المرور التي تحمي ملف .p12/.pfx",
    "settings.p12PassPlaceholder": "اتركه فارغًا إذا لم يكن للملف كلمة مرور",
    "settings.storagePassLabel": "كلمة مرور جديدة لحماية هذا المفتاح في متصفحك",
    "settings.storagePassRequired": "كلمة مرور التخزين مطلوبة",
    "settings.importKeySuccess": "تم استيراد مفتاح S/MIME للعنوان {email}",
    "settings.importKeyFailed": "فشل الاستيراد: {reason}",
    "settings.unlockDialogTitle": "فتح قفل {email}",
    "settings.unlockConfirm": "فتح القفل",
    "settings.storagePassForKeyLabel": "كلمة مرور التخزين لهذا المفتاح",
    "settings.unlockSuccess": "تم فتح قفل {email}",
    "settings.unlockFailed": "فشل فتح القفل",
    "settings.keyFallback": "مفتاح",
    "settings.lockedToast": "تم قفل {email}",
    "settings.deleteDialogTitle": "حذف مفتاح S/MIME",
    "settings.deleteDialogMessage": "هل تريد حذف المفتاح الخاص والشهادة لـ {email}؟ لن تتمكن بعد ذلك من فك تشفير البريد المشفّر لهذا العنوان.",
    "settings.deleteDialogFallbackIdentity": "هذه الهوية",
    "settings.deleteConfirm": "حذف",
    "settings.keyDeletedToast": "تم حذف المفتاح",
    "settings.certNoEmail": "الشهادة لا تحتوي على عنوان بريد إلكتروني",
    "settings.importCertSuccess": "تم استيراد الشهادة للعنوان {email}",
    "settings.importCertFailed": "فشل استيراد الشهادة: {reason}",
    "settings.unlockSendDialogTitle": "فتح قفل مفتاح S/MIME",
    "settings.unlockSendDialogMessage": "مفتاحك الخاص بـ {email} مُقفل. أدخل كلمة مرور التخزين للتوقيع والإرسال.",
    "settings.unlockAndSend": "فتح القفل والإرسال",
    "settings.storagePassphrase": "كلمة مرور التخزين",
    "settings.unlockFailedWrongPass": "فشل فتح القفل — كلمة مرور خاطئة؟",
    "settings.notPrivilegedToast": "تعذّر التوقيع/التشفير: S/MIME لا يعمل في الطبقة المميزة."
  },
  "tr": {
    "banner.encryption": "Şifreleme",
    "banner.decrypted": "Şifresi çözüldü",
    "banner.encryptedLocked": "Şifreli — okumak için anahtarınızın kilidini açın",
    "banner.encryptedFailed": "Şifreli — mevcut anahtarlarınızla çözülemedi",
    "banner.encryptedMessage": "Şifreli ileti",
    "banner.signature": "İmza",
    "banner.validSignature": "Geçerli imza",
    "banner.validSignatureBy": "Geçerli imza — {email}",
    "banner.signedMessage": "İmzalı ileti",
    "banner.invalidSignature": "Geçersiz imza: {reason}",
    "banner.selfSignedBadge": "kendinden imzalı",
    "banner.signerMismatchBadge": "imzalayan ≠ gönderen",
    "banner.unlockNow": "Şimdi kilidi aç",
    "banner.unlocking": "Kilit açılıyor…",
    "banner.viewCertDetails": "Sertifika ayrıntılarını görüntüle",
    "banner.hideCertDetails": "Sertifika ayrıntılarını gizle",
    "banner.downloadCert": "Sertifikayı indir",
    "banner.certSubject": "Konu",
    "banner.certIssuer": "Veren",
    "banner.certEmail": "E-posta",
    "banner.certValid": "Geçerlilik",
    "banner.certFingerprint": "Parmak izi (SHA-256)",
    "toolbar.sign": "İmzala",
    "toolbar.encrypt": "Şifrele",
    "toolbar.signTitle": "Bu iletiyi dijital olarak imzala",
    "toolbar.encryptTitle": "Bu iletiyi alıcılar için şifrele",
    "toolbar.needKey": "S/MIME: imzalamak/şifrelemek için Ayarlar'dan bir anahtar içe aktarın",
    "settings.title": "S/MIME anahtarları ve sertifikaları",
    "banner.copyCert": "Panoya kopyala",
    "banner.copied": "Kopyalandı!",
    "banner.copyChain": "Zincirle birlikte kopyala",
    "banner.certChain": "Zincir",
    "banner.certChainCount": "{count} ek sertifika dahil",
    "settings.notActive": "S/MIME etkin değil",
    "settings.yourKeys": "Anahtarlarınız",
    "settings.yourKeysDesc": "Sertifikanızı ve özel anahtarınızı içeren bir PKCS#12 (.p12/.pfx) dosyası içe aktarın. Anahtar tarayıcınızda şifrelenir ve tarayıcıyı asla terk etmez.",
    "settings.importKey": "Anahtar içe aktar",
    "settings.noKeys": "Henüz anahtar içe aktarılmadı.",
    "settings.certUnknown": "Sertifika",
    "settings.validRange": "geçerlilik {from} – {to}",
    "settings.expired": "SÜRESİ DOLDU",
    "settings.capSign": "imzalama",
    "settings.capEncrypt": "şifreleme",
    "settings.lock": "Kilitle",
    "settings.unlock": "Kilidi aç",
    "settings.delete": "Sil",
    "settings.recipientCerts": "Alıcı sertifikaları",
    "settings.recipientCertsDesc": "Şifreli posta göndermek istediğiniz kişilerin genel sertifikaları (PEM/DER). Geçerli şekilde imzalanmış postalardaki imzalayan sertifikaları otomatik olarak kaydedilir.",
    "settings.importCert": "Sertifika içe aktar",
    "settings.noCerts": "Alıcı sertifikası yok.",
    "settings.certExpires": "{date} tarihinde sona eriyor",
    "settings.remove": "Kaldır",
    "settings.defaults": "Yeni iletiler için varsayılanlar",
    "settings.defaultSign": "Yeni iletileri varsayılan olarak imzala",
    "settings.defaultEncrypt": "Yeni iletileri varsayılan olarak şifrele (tüm alıcıların sertifikası olduğunda)",
    "settings.importKeyDialogTitle": "S/MIME anahtarı içe aktar",
    "settings.importKeyDialogMessage": "\"{file}\" içe aktarılıyor.",
    "settings.importDialogConfirm": "İçe aktar",
    "settings.p12PassLabel": ".p12/.pfx dosyasını koruyan parola",
    "settings.p12PassPlaceholder": "Dosyanın parolası yoksa boş bırakın",
    "settings.storagePassLabel": "Bu anahtarı tarayıcınızda korumak için yeni parola",
    "settings.storagePassRequired": "Bir depolama parolası gerekli",
    "settings.importKeySuccess": "{email} için S/MIME anahtarı içe aktarıldı",
    "settings.importKeyFailed": "İçe aktarma başarısız: {reason}",
    "settings.unlockDialogTitle": "{email} kilidini aç",
    "settings.unlockConfirm": "Kilidi aç",
    "settings.storagePassForKeyLabel": "Bu anahtar için depolama parolası",
    "settings.unlockSuccess": "{email} kilidi açıldı",
    "settings.unlockFailed": "Kilit açma başarısız",
    "settings.keyFallback": "anahtar",
    "settings.lockedToast": "{email} kilitlendi",
    "settings.deleteDialogTitle": "S/MIME anahtarını sil",
    "settings.deleteDialogMessage": "{email} için özel anahtar ve sertifika silinsin mi? Bundan sonra ona şifrelenmiş postaların şifresini çözemezsiniz.",
    "settings.deleteDialogFallbackIdentity": "bu kimlik",
    "settings.deleteConfirm": "Sil",
    "settings.keyDeletedToast": "Anahtar silindi",
    "settings.certNoEmail": "Sertifikada e-posta adresi yok",
    "settings.importCertSuccess": "{email} için sertifika içe aktarıldı",
    "settings.importCertFailed": "Sertifika içe aktarma başarısız: {reason}",
    "settings.unlockSendDialogTitle": "S/MIME anahtalının kilidini aç",
    "settings.unlockSendDialogMessage": "{email} için anahtarınız kilitli. İmzalamak ve göndermek için depolama parolasını girin.",
    "settings.unlockAndSend": "Kilidi aç ve gönder",
    "settings.storagePassphrase": "Depolama parolası",
    "settings.unlockFailedWrongPass": "Kilit açma başarısız — yanlış parola mı?",
    "settings.notPrivilegedToast": "İmzalanamıyor/şifrelenemiyor: S/MIME ayrıcalıklı katmanda çalışmıyor."
  },
  "pl": {
    "banner.encryption": "Szyfrowanie",
    "banner.decrypted": "Odszyfrowano",
    "banner.encryptedLocked": "Zaszyfrowane — odblokuj klucz, aby odczytać",
    "banner.encryptedFailed": "Zaszyfrowane — nie udało się odszyfrować dostępnymi kluczami",
    "banner.encryptedMessage": "Zaszyfrowana wiadomość",
    "banner.signature": "Podpis",
    "banner.validSignature": "Podpis prawidłowy",
    "banner.validSignatureBy": "Podpis prawidłowy — {email}",
    "banner.signedMessage": "Podpisana wiadomość",
    "banner.invalidSignature": "Nieprawidłowy podpis: {reason}",
    "banner.selfSignedBadge": "samopodpisany",
    "banner.signerMismatchBadge": "podpisujący ≠ nadawca",
    "banner.unlockNow": "Odblokuj teraz",
    "banner.unlocking": "Odblokowywanie…",
    "banner.viewCertDetails": "Pokaż szczegóły certyfikatu",
    "banner.hideCertDetails": "Ukryj szczegóły certyfikatu",
    "banner.downloadCert": "Pobierz certyfikat",
    "banner.certSubject": "Podmiot",
    "banner.certIssuer": "Wystawca",
    "banner.certEmail": "E-mail",
    "banner.certValid": "Ważność",
    "banner.certFingerprint": "Odcisk (SHA-256)",
    "toolbar.sign": "Podpisz",
    "toolbar.encrypt": "Zaszyfruj",
    "toolbar.signTitle": "Podpisz cyfrowo tę wiadomość",
    "toolbar.encryptTitle": "Zaszyfruj tę wiadomość dla odbiorców",
    "toolbar.needKey": "S/MIME: zaimportuj klucz w Ustawieniach, aby podpisywać/szyfrować",
    "settings.title": "Klucze i certyfikaty S/MIME",
    "banner.copyCert": "Kopiuj do schowka",
    "banner.copied": "Skopiowano!",
    "banner.copyChain": "Kopiuj z łańcuchem",
    "banner.certChain": "Łańcuch",
    "banner.certChainCount": "dołączono dodatkowych certyfikatów: {count}",
    "settings.notActive": "S/MIME nie jest aktywne",
    "settings.yourKeys": "Twoje klucze",
    "settings.yourKeysDesc": "Zaimportuj plik PKCS#12 (.p12/.pfx) zawierający Twój certyfikat i klucz prywatny. Klucz jest szyfrowany w przeglądarce i nigdy jej nie opuszcza.",
    "settings.importKey": "Importuj klucz",
    "settings.noKeys": "Nie zaimportowano jeszcze żadnych kluczy.",
    "settings.certUnknown": "Certyfikat",
    "settings.validRange": "ważny {from} – {to}",
    "settings.expired": "WYGASŁ",
    "settings.capSign": "podpis",
    "settings.capEncrypt": "szyfrowanie",
    "settings.lock": "Zablokuj",
    "settings.unlock": "Odblokuj",
    "settings.delete": "Usuń",
    "settings.recipientCerts": "Certyfikaty odbiorców",
    "settings.recipientCertsDesc": "Certyfikaty publiczne (PEM/DER) osób, do których chcesz wysyłać szyfrowaną pocztę. Certyfikaty podpisujących z poprawnie podpisanych wiadomości są zapisywane automatycznie.",
    "settings.importCert": "Importuj certyfikat",
    "settings.noCerts": "Brak certyfikatów odbiorców.",
    "settings.certExpires": "wygasa {date}",
    "settings.remove": "Usuń",
    "settings.defaults": "Ustawienia domyślne dla nowych wiadomości",
    "settings.defaultSign": "Domyślnie podpisuj nowe wiadomości",
    "settings.defaultEncrypt": "Domyślnie szyfruj nowe wiadomości (gdy wszyscy odbiorcy mają certyfikaty)",
    "settings.importKeyDialogTitle": "Importuj klucz S/MIME",
    "settings.importKeyDialogMessage": "Importowanie „{file}”.",
    "settings.importDialogConfirm": "Importuj",
    "settings.p12PassLabel": "Hasło chroniące plik .p12/.pfx",
    "settings.p12PassPlaceholder": "Pozostaw puste, jeśli plik go nie ma",
    "settings.storagePassLabel": "Nowe hasło do ochrony tego klucza w przeglądarce",
    "settings.storagePassRequired": "Wymagane jest hasło przechowywania",
    "settings.importKeySuccess": "Zaimportowano klucz S/MIME dla {email}",
    "settings.importKeyFailed": "Import nie powiódł się: {reason}",
    "settings.unlockDialogTitle": "Odblokuj {email}",
    "settings.unlockConfirm": "Odblokuj",
    "settings.storagePassForKeyLabel": "Hasło przechowywania dla tego klucza",
    "settings.unlockSuccess": "Odblokowano {email}",
    "settings.unlockFailed": "Odblokowanie nie powiodło się",
    "settings.keyFallback": "klucz",
    "settings.lockedToast": "Zablokowano {email}",
    "settings.deleteDialogTitle": "Usuń klucz S/MIME",
    "settings.deleteDialogMessage": "Usunąć klucz prywatny i certyfikat dla {email}? Nie będzie już można odszyfrować poczty zaszyfrowanej dla tego adresu.",
    "settings.deleteDialogFallbackIdentity": "tej tożsamości",
    "settings.deleteConfirm": "Usuń",
    "settings.keyDeletedToast": "Klucz usunięty",
    "settings.certNoEmail": "Certyfikat nie ma adresu e-mail",
    "settings.importCertSuccess": "Zaimportowano certyfikat dla {email}",
    "settings.importCertFailed": "Import certyfikatu nie powiódł się: {reason}",
    "settings.unlockSendDialogTitle": "Odblokuj klucz S/MIME",
    "settings.unlockSendDialogMessage": "Twój klucz dla {email} jest zablokowany. Wprowadź hasło przechowywania, aby podpisać i wysłać.",
    "settings.unlockAndSend": "Odblokuj i wyślij",
    "settings.storagePassphrase": "Hasło przechowywania",
    "settings.unlockFailedWrongPass": "Odblokowanie nie powiodło się — błędne hasło?",
    "settings.notPrivilegedToast": "Nie można podpisać/zaszyfrować: S/MIME nie działa w warstwie uprzywilejowanej."
  }
}
;

/** Detect the active locale ourselves: top-level app <html lang> first (reflects the account's language setting), then our own iframe's <html lang>, then navigator.language. */
function detectLocale() {
  try {
    // Same-origin, privileged iframe — the top-level Bulwark page's <html lang>
    // is set server-side from the account's language, unlike navigator.language
    // which reflects the browser/OS and may not match (e.g. German account on
    // an English-language browser).
    const topLang = (typeof window !== 'undefined' && window.top && window.top.document
      && window.top.document.documentElement && window.top.document.documentElement.lang) || '';
    const topBase = topLang.slice(0, 2).toLowerCase();
    if (LOCAL_I18N[topBase]) return topBase;
  } catch { /* cross-origin or blocked — fall through */ }
  try {
    const docLang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || '';
    const base = docLang.slice(0, 2).toLowerCase();
    if (LOCAL_I18N[base]) return base;
  } catch { /* cross-origin or unavailable — fall through */ }
  try {
    const navLang = (typeof navigator !== 'undefined' && navigator.language) || '';
    const base = navLang.slice(0, 2).toLowerCase();
    if (LOCAL_I18N[base]) return base;
  } catch { /* ignore */ }
  return 'en';
}
// <<< END SELF-DETECTED LOCALE FALLBACK >>>
// ======================================================================

function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
}

let i18nDiagLogged = false;
function t(key, params) {
  if (!i18nDiagLogged) {
    i18nDiagLogged = true;
    let topLang = '(error)';
    try { topLang = window.top.document.documentElement.lang || '(empty)'; } catch (e) { topLang = '(blocked: ' + e.message + ')'; }
    // eslint-disable-next-line no-console
    console.log('[smime i18n diag] detectLocale() =', detectLocale(),
      '| window.top html lang =', topLang,
      '| own iframe html lang =', (document.documentElement && document.documentElement.lang) || '(empty)',
      '| navigator.language =', navigator.language,
      '| host.i18n =', host.i18n,
      '| host sample lookup for "banner.signature" =', host.i18n && typeof host.i18n.t === 'function' ? host.i18n.t('banner.signature') : '(n/a)');
  }

  // >>> SELF-DETECTED LOCALE FALLBACK: takes priority over host.i18n.t() <<<
  // See the LOCAL_I18N / detectLocale() block above for why. Remove this
  // "if" block (and go back to host.i18n.t() alone) once the host bug is
  // fixed upstream.
  const locale = detectLocale();
  const localDict = LOCAL_I18N[locale];
  if (localDict && localDict[key]) return interpolate(localDict[key], params);
  // <<< END SELF-DETECTED LOCALE FALLBACK >>>

  try {
    if (host.i18n && typeof host.i18n.t === 'function') {
      const out = host.i18n.t(key, params);
      if (out) return out;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[smime i18n diag] host.i18n.t threw:', err);
  }
  return interpolate(I18N_FALLBACK_EN[key] || key, params);
}

/** Wrap a base64 DER string into standard 64-col PEM. */
function pemFromBase64(b64, label) {
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** Certificate PEM text, regardless of whether .certificate is a base64 string (from storage) or an ArrayBuffer (fresh, not yet round-tripped through storage). Returns null (and logs) for garbage/empty input instead of silently producing an empty PEM. */
function certificatePem(cert) {
  if (!cert || !cert.certificate) { console.log('[smime cert pem] no cert.certificate on', cert); return null; }
  const der = cert.certificate;
  let b64;
  if (typeof der === 'string') {
    b64 = der;
  } else {
    try { b64 = bytesToBase64(der); } catch (err) { console.log('[smime cert pem] bytesToBase64 threw:', err, 'der was:', der); return null; }
  }
  // A real DER-encoded X.509 certificate is at minimum a few hundred bytes
  // (base64: a few hundred chars). Anything drastically shorter means the
  // underlying value was never a real certificate — most likely a stale,
  // pre-fix corrupted object ({}) still sitting in host.storage. Reopening
  // the email (not just re-rendering) re-verifies and overwrites it.
  if (!b64 || b64.length < 100) {
    console.log('[smime cert pem] suspiciously short/empty base64 (len=' + (b64 ? b64.length : 0) + ') — likely stale data; try closing and reopening this email.', cert);
    return null;
  }
  return pemFromBase64(b64, 'CERTIFICATE');
}

/**
 * PEM bundle of the signer's leaf certificate plus any chain certificates
 * (usually intermediate CAs) the sender's CMS structure carried. This is
 * "whatever the mail brought along" — not a verified or complete chain to a
 * trusted root, since roots are rarely included and nothing here is checked
 * against a trust store. Falls back to leaf-only if there's no chain data.
 */
function certificateChainPem(cert) {
  const leafPem = certificatePem(cert);
  if (!leafPem) return null;
  const chain = cert && cert.chainCertificates;
  if (!Array.isArray(chain) || chain.length === 0) return leafPem;
  const parts = [leafPem];
  for (const der of chain) {
    let b64;
    if (typeof der === 'string') b64 = der;
    else {
      try { b64 = bytesToBase64(der); } catch { continue; }
    }
    if (b64 && b64.length >= 100) parts.push(pemFromBase64(b64, 'CERTIFICATE'));
  }
  return parts.join('\n');
}

/** Fallback for sandboxed iframes that block programmatic downloads: copy the PEM to the clipboard instead. */
async function copyCertificateToClipboard(cert, setCopied, includeChain) {
  const pem = includeChain ? certificateChainPem(cert) : certificatePem(cert);
  if (!pem) return;
  try {
    await navigator.clipboard.writeText(pem);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  } catch (err) {
    console.log('[smime cert copy] failed:', err);
  }
}

const DEFAULT_PREFS = { defaultSign: false, defaultEncrypt: false };

async function getPrefs() {
  try {
    const p = await host.storage.get(PREFS_KEY);
    return { ...DEFAULT_PREFS, ...(p || {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
async function setPrefs(next) {
  await host.storage.set(PREFS_KEY, next);
}

function settings() {
  return host.plugin?.settings || {};
}
function useAes128() {
  return settings().encryptionStrength === 'aes-128';
}

// ─── Privileged-tier capability probe ─────────────────────────────────
// S/MIME needs in-frame `crypto.subtle` + IndexedDB, which exist only in the
// privileged (same-origin) tier. In the untrusted (null-origin) sandbox,
// `indexedDB.open` throws "The operation is insecure" and `crypto.subtle` is
// absent. We probe once and degrade with a clear message instead of letting a
// raw IndexedDB error crash activate() (which would trip the circuit breaker).

const NOT_PRIVILEGED_MSG =
  'S/MIME could not start: it is running in the restricted (untrusted) plugin ' +
  'sandbox, where in-browser cryptography and key storage are unavailable. ' +
  'This plugin must be delivered as a signed, admin-approved bundle with ' +
  '"tier": "privileged" so it loads in the same-origin tier. Contact your ' +
  'administrator.';

let _capable = null;
async function isCapable() {
  if (_capable !== null) return _capable;
  try {
    if (typeof indexedDB === 'undefined' || !(crypto && crypto.subtle)) throw new Error('missing apis');
    await new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open('smime-capability-probe'); }
      catch (e) { reject(e); return; }
      req.onsuccess = () => { try { req.result.close(); } catch { /* ignore */ } resolve(); };
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
      req.onblocked = () => resolve();
    });
    _capable = true;
  } catch {
    _capable = false;
  }
  return _capable;
}

// ─── Address helpers ──────────────────────────────────────────────────

function parseAddr(value) {
  if (value && typeof value === 'object' && value.email) {
    return { name: value.name || undefined, email: String(value.email) };
  }
  const s = String(value || '');
  // A leading segment is only a display name when it is actually followed by an
  // angle-bracketed address. Making the `<` optional (the old `<?`) let the name
  // group steal the first character of a BARE address — e.g. "root@rbm.systems"
  // parsed as name "r" + email "oot@rbm.systems", which then failed the S/MIME
  // key lookup for every normal send.
  const m = s.match(/^\s*(?:"?([^"<]*?)"?\s*<\s*)?([^<>\s]+@[^<>\s]+)\s*>?\s*$/);
  if (m) return { name: (m[1] || '').trim() || undefined, email: m[2] };
  return { email: s.trim() };
}
function addrList(arr) {
  if (!arr) return [];
  return (Array.isArray(arr) ? arr : [arr]).map(parseAddr).filter((a) => a.email);
}
function emailsOf(arr) {
  return addrList(arr).map((a) => a.email.toLowerCase());
}

// ─── Blob/bytes helpers ────────────────────────────────────────────────

async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
function bytesArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/** Wrap a CMS blob as a nested MIME entity (for sign-then-encrypt). */
function cmsInnerEntity(cmsBytes, smimeType) {
  const header = [
    `Content-Type: application/pkcs7-mime; smime-type=${smimeType}; name="smime.p7m"`,
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="smime.p7m"',
    '',
  ].join('\r\n');
  const b64 = base64Encode(bytesArrayBuffer(cmsBytes));
  return new TextEncoder().encode(header + '\r\n' + b64 + '\r\n');
}

// ─── Key resolution ────────────────────────────────────────────────────

async function signingKeyRecordForEmail(fromEmail) {
  const recs = await listKeyRecords();
  const lower = (fromEmail || '').toLowerCase();
  return (
    recs.find((r) => r.email === lower && r.capabilities?.canSign !== false) ||
    recs.find((r) => r.email === lower) ||
    undefined
  );
}

// Ensure a key's private material is unlocked in the session store. If it's
// locked, ask for the storage passphrase via a host popup and unlock it in
// place. Returns the unlocked session keys, or null if the user cancels or the
// passphrase is wrong (a wrong-passphrase toast is shown in the latter case).
async function ensureKeyUnlocked(keyRecord) {
  const existing = await getSessionKeys(keyRecord.id);
  if (existing && existing.signingKey) return existing;

  const answers = await host.ui.prompt({
    title: t('settings.unlockSendDialogTitle'),
    message: t('settings.unlockSendDialogMessage', { email: keyRecord.email || t('settings.deleteDialogFallbackIdentity') }),
    confirmLabel: t('settings.unlockAndSend'),
    fields: [
      { name: 'pass', label: t('settings.storagePassphrase'), type: 'password', required: true },
    ],
  });
  if (!answers) return null; // cancelled
  const pass = answers.pass || '';
  if (!pass) return null;

  try {
    const { signingKey, decryptionKey, legacyDecryptionKey } = await unlockPrivateKey(keyRecord, pass);
    await saveSessionKeys({ id: keyRecord.id, signingKey, decryptionKey, legacyDecryptionKey });
    return await getSessionKeys(keyRecord.id);
  } catch (err) {
    host.toast.error(err && err.message ? err.message : t('settings.unlockFailedWrongPass'));
    return null;
  }
}

async function recipientCertsFor(emails) {
  const certs = await listPublicCerts();
  const found = [];
  const missing = [];
  for (const email of emails) {
    const c = certs.find((pc) => pc.email.toLowerCase() === email.toLowerCase());
    if (c) found.push(c.certificate);
    else missing.push(email);
  }
  return { found, missing };
}

// Build decrypt key maps from the session store, across all key records.
async function unlockedDecryptMaps() {
  const recs = await listKeyRecords();
  const unlockedKeys = new Map();
  const legacyUnlockedKeys = new Map();
  for (const r of recs) {
    const s = await getSessionKeys(r.id);
    if (!s) continue;
    if (s.decryptionKey) unlockedKeys.set(r.id, s.decryptionKey);
    if (s.legacyDecryptionKey) legacyUnlockedKeys.set(r.id, s.legacyDecryptionKey);
  }
  return { keyRecords: recs, unlockedKeys, legacyUnlockedKeys };
}

// ─── Compose-send takeover ─────────────────────────────────────────────

async function resolveIntent(req) {
  const pick = (...vals) => {
    for (const v of vals) if (typeof v === 'boolean') return v;
    return undefined;
  };
  let sign = pick(req.sign, req.smimeSign, req.intent && req.intent.sign, req.smime && req.smime.sign);
  let encrypt = pick(req.encrypt, req.smimeEncrypt, req.intent && req.intent.encrypt, req.smime && req.smime.encrypt);

  if (sign === undefined && encrypt === undefined) {
    // Fall back to the composer-toolbar slot's stored intent, then prefs.
    const stored = (await host.storage.get(INTENT_KEY)) || {};
    const prefs = await getPrefs();
    sign = typeof stored.sign === 'boolean' ? stored.sign : prefs.defaultSign;
    encrypt = typeof stored.encrypt === 'boolean' ? stored.encrypt : prefs.defaultEncrypt;
  }
  return { sign: !!sign, encrypt: !!encrypt };
}

async function fetchAttachments(req) {
  const list = req.attachments || [];
  const out = [];
  for (const att of list) {
    if (!att || !att.blobId) continue;
    try {
      const bytes = await host.jmap.fetchBlob(att.blobId, { name: att.name, type: att.type });
      out.push({
        filename: att.name || 'attachment',
        contentType: att.type || 'application/octet-stream',
        content: bytesArrayBuffer(bytes),
      });
    } catch (err) {
      host.log.warn('attachment fetch failed', att.name, err);
      throw new Error(`Could not read attachment "${att.name || ''}" for encryption`);
    }
  }
  return out;
}

async function onComposeSend(req) {
  if (!req || typeof req !== 'object') return undefined;

  const { sign, encrypt } = await resolveIntent(req);
  if (!sign && !encrypt) return undefined; // not our job — host sends normally

  if (!(await isCapable())) {
    host.toast.error(t('settings.notPrivilegedToast'));
    return false; // refuse rather than send plaintext when sign/encrypt was requested
  }

  try {
    const identityId = req.identityId || req.identity || '';
    if (!identityId) throw new Error('No sending identity available');

    const from = parseAddr(req.fromEmail || req.from || (addrList(req.from)[0] || {}).email || '');
    if (!from.email) throw new Error('Could not determine sender address');

    const to = addrList(req.to);
    const cc = addrList(req.cc);
    const bcc = addrList(req.bcc);
    const allRecipientEmails = [...emailsOf(req.to), ...emailsOf(req.cc), ...emailsOf(req.bcc)];

    const keyRecord = (sign || encrypt) ? await signingKeyRecordForEmail(from.email) : undefined;
    if ((sign || encrypt) && !keyRecord) {
      host.toast.error(`No S/MIME key for ${from.email}. Import one in Settings → Plugins → S/MIME.`);
      return false;
    }

    // Build the inner MIME message from the draft.
    const attachments = await fetchAttachments(req);
    let payloadBytes = buildMimeMessage({
      from,
      to,
      cc,
      subject: req.subject || '',
      textBody: req.textBody || req.text || '',
      htmlBody: req.htmlBody || req.html || '',
      inReplyTo: req.inReplyTo,
      references: req.references,
      attachments,
    });

    // 1. Sign (opaque). If we'll also encrypt, nest the signed CMS as a MIME entity.
    if (sign) {
      // Locked keys are normally unlocked in onBeforeEmailSend (which can abort
      // the send cleanly). This is a fallback for that path not having run: the
      // popup shows here too, but cancelling clears the composer, so prefer the
      // pre-send hook.
      const session = await ensureKeyUnlocked(keyRecord);
      if (!session || !session.signingKey) {
        return false; // refuse rather than send unsigned
      }
      const signedBlob = await smimeSign(
        payloadBytes,
        session.signingKey,
        keyRecord.certificate,
        keyRecord.certificateChain || [],
      );
      const signedBytes = await blobToBytes(signedBlob);
      payloadBytes = encrypt ? cmsInnerEntity(signedBytes, 'signed-data') : signedBytes;
    }

    // 2. Encrypt (envelope). Always includes the sender cert so Sent is readable.
    let smimeType = sign ? 'signed-data' : null;
    if (encrypt) {
      const { found, missing } = await recipientCertsFor(allRecipientEmails);
      if (missing.length > 0) {
        host.toast.error(`Missing encryption certificate for: ${missing.join(', ')}`);
        return false;
      }
      const envBlob = await smimeEncrypt(payloadBytes, found, keyRecord.certificate, useAes128());
      payloadBytes = await blobToBytes(envBlob);
      smimeType = 'enveloped-data';
    }

    // 3. Wrap as RFC822 and submit raw.
    const rfc822 = wrapCmsAsSmimeMessage(payloadBytes, {
      from,
      to,
      cc,
      subject: req.subject || '',
      inReplyTo: req.inReplyTo,
      references: req.references,
      smimeType,
    });
    const rawBytes = await blobToBytes(rfc822);

    const envelopeRecipients = [...new Set([...allRecipientEmails])];
    await host.jmap.sendRaw(bytesArrayBuffer(rawBytes), identityId, { envelopeRecipients });

    host.toast.success(
      encrypt && sign ? 'Message signed, encrypted and sent'
        : encrypt ? 'Message encrypted and sent'
          : 'Message signed and sent',
    );
    // Clear the per-message intent so the next compose starts from defaults.
    await host.storage.set(INTENT_KEY, {});
    return false; // we handled the send
  } catch (err) {
    host.log.error('onComposeSend failed', err);
    host.toast.error(`S/MIME send failed: ${err && err.message ? err.message : String(err)}`);
    return false; // do NOT fall through to a plaintext send when sign/encrypt was requested
  }
}

// ─── Render-body takeover (verify / decrypt) ───────────────────────────

async function maybeAutoImportSigner(status) {
  if (settings().autoImportSignerCerts === false) return;
  const cert = status && status.signerCert;
  if (!cert || !status.signatureValid || !cert.email) return;
  try {
    const existing = (await listPublicCerts()).some((c) => c.fingerprint === cert.fingerprint);
    if (!existing) {
      await savePublicCert({
        id: generateUUID(),
        email: cert.email,
        certificate: cert.certificate,
        issuer: cert.issuer,
        subject: cert.subject,
        notBefore: cert.notBefore,
        notAfter: cert.notAfter,
        fingerprint: cert.fingerprint,
        source: 'signed-email',
      });
    }
  } catch (err) {
    host.log.warn('auto-import signer cert failed', err);
  }
}

// Lucide-style stroke icons rendered inline so the status chip can tint them
// with `currentColor` — matching the host's "External Content" banner, which
// uses tinted SVG glyphs (not emoji) in a round chip.
function iconSvg(size, ...children) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }, ...children);
}
const ICONS = {
  lock: (s = 20) => iconSvg(s,
    h('rect', { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }),
    h('path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' })),
  lockOpen: (s = 20) => iconSvg(s,
    h('rect', { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }),
    h('path', { d: 'M7 11V7a5 5 0 0 1 9.9-1' })),
  shieldCheck: (s = 20) => iconSvg(s,
    h('path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }),
    h('path', { d: 'm9 12 2 2 4-4' })),
  shieldAlert: (s = 20) => iconSvg(s,
    h('path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }),
    h('path', { d: 'M12 8v4' }),
    h('path', { d: 'M12 16h.01' })),
  info: (s = 20) => iconSvg(s,
    h('circle', { cx: 12, cy: 12, r: 10 }),
    h('path', { d: 'M12 16v-4' }),
    h('path', { d: 'M12 8h.01' })),
};

/** ArrayBuffer/TypedArray → base64 string (no line wrapping — that happens at PEM-render time). */
function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
  return btoa(binary);
}

/**
 * host.storage.set appears to JSON-serialize its value, which silently
 * destroys an ArrayBuffer (comes back as `{}` on read, breaking any later
 * base64/PEM conversion — see downloadCertificate). Convert the signer
 * certificate to a plain base64 string before persisting so it survives the
 * round-trip; savePublicCert() (real IndexedDB, used for encryption) is
 * unaffected and keeps working with the original ArrayBuffer.
 */
function toStorageSafeStatus(status) {
  const signerCert = status && status.signerCert;
  if (!signerCert) return status;
  const cert = signerCert.certificate;
  const chain = signerCert.chainCertificates;
  const certNeedsConversion = cert && typeof cert !== 'string';
  const chainNeedsConversion = Array.isArray(chain) && chain.some((c) => typeof c !== 'string');
  if (!certNeedsConversion && !chainNeedsConversion) return status;
  try {
    const safeSignerCert = { ...signerCert };
    if (certNeedsConversion) safeSignerCert.certificate = bytesToBase64(cert);
    if (chainNeedsConversion) safeSignerCert.chainCertificates = chain.map((c) => (typeof c === 'string' ? c : bytesToBase64(c)));
    return { ...status, signerCert: safeSignerCert };
  } catch {
    return status;
  }
}

async function persistVerifyStatus(emailId, status) {
  if (!emailId) return;
  try { await host.storage.set(VERIFY_PREFIX + emailId, toStorageSafeStatus(status)); } catch { /* ignore */ }
}

async function onRenderEmailBody(body, ctx) {
  if (!ctx) return undefined;
  if (!(await isCapable())) return undefined; // can't decrypt/verify without the privileged tier

  const detection = detectSmime(ctx.contentType, ctx.bodyStructure, ctx.attachments);
  if (!detection.type) return undefined;

  if (!detection.supported) {
    const status = {
      isSigned: detection.type === 'detached-sig',
      isEncrypted: false,
      unsupportedReason: `Unsupported S/MIME type (${detection.type})`,
    };
    await persistVerifyStatus(ctx.id, status);
    return undefined; // let the host render the original body
  }

  const blobId = detection.blobId || ctx.blobId;
  if (!blobId) return undefined;

  const fromEmail = (addrList(ctx.from)[0] || {}).email;

  try {
    const raw = await host.jmap.fetchBlob(blobId);
    const rawBytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

    // Detached (multipart/signed) mail is NOT a single CMS blob — it's a MIME
    // container we split ourselves — so it must NOT go through
    // normalizeCmsBytes (which assumes/extracts exactly one CMS structure and
    // would otherwise mistake part 1's own MIME headers for the message's
    // headers and mangle the boundary-delimited body).
    if (detection.type === 'detached-sig') {
      try {
        const { contentBytes, signatureBytes } = splitMultipartSigned(rawBytes, detection.boundary);
        const v = await smimeVerifyDetached(contentBytes, bytesArrayBuffer(signatureBytes), fromEmail);
        await maybeAutoImportSigner(v.status);
        const parsed = parseMime(v.mimeBytes);
        await persistVerifyStatus(ctx.id, v.status);
        return {
          ...body,
          handledBy: 'smime',
          html: parsed.html || '',
          text: parsed.text || '',
          attachments: parsed.attachments,
          verification: v.status,
        };
      } catch (err) {
        host.log.warn('S/MIME detached verify failed', err);
        const status = {
          isSigned: true,
          isEncrypted: false,
          signatureValid: false,
          signatureError: err && err.message ? err.message : String(err),
        };
        await persistVerifyStatus(ctx.id, status);
        return { ...body, handledBy: 'smime', html: '', text: '', attachments: [], verification: status };
      }
    }

    const der = normalizeCmsBytes(bytesArrayBuffer(rawBytes));

    if (detection.type === 'enveloped-data') {
      const { keyRecords, unlockedKeys, legacyUnlockedKeys } = await unlockedDecryptMaps();
      let result;
      try {
        result = await smimeDecrypt({ cmsBytes: der, keyRecords, unlockedKeys, legacyUnlockedKeys });
      } catch (err) {
        // Single-banner UX: on failure we surface the status ONLY through the
        // email-banner slot (which reads the persisted verification), and leave
        // the body empty rather than stacking a second in-body notice box.
        if (err instanceof SmimeKeyLockedError) {
          const status = { isEncrypted: true, decryptionSuccess: false, decryptionError: 'locked' };
          await persistVerifyStatus(ctx.id, status);
          return { ...body, handledBy: 'smime', html: '', text: '', attachments: [], verification: status };
        }
        host.log.warn('S/MIME decrypt failed', err);
        const status = { isEncrypted: true, decryptionSuccess: false, decryptionError: err && err.message ? err.message : String(err) };
        await persistVerifyStatus(ctx.id, status);
        return { ...body, handledBy: 'smime', html: '', text: '', attachments: [], verification: status };
      }

      // Decrypted inner content may itself be a signed CMS — either nested as a
      // MIME entity (RFC 8551 sign-then-encrypt, the Outlook/Thunderbird form)
      // or, more rarely, raw CMS DER. Detect both.
      let innerBytes = result.mimeBytes;
      const verification = { isEncrypted: true, decryptionSuccess: true };
      const innerCt = innerContentType(innerBytes);
      const innerDet = detectSmime(innerCt, null, null);
      const looksSigned = innerDet.type === 'signed-data' || innerBytes[0] === 0x30;
      if (looksSigned) {
        try {
          const signedDer = normalizeCmsBytes(bytesArrayBuffer(innerBytes));
          const v = await smimeVerify(signedDer, fromEmail);
          innerBytes = v.mimeBytes;
          Object.assign(verification, v.status, { isEncrypted: true, decryptionSuccess: true });
          await maybeAutoImportSigner(v.status);
        } catch { /* not actually signed; keep decrypted content as-is */ }
      }

      const parsed = parseMime(innerBytes);
      await persistVerifyStatus(ctx.id, verification);
      return {
        ...body,
        handledBy: 'smime',
        html: parsed.html || '',
        text: parsed.text || '',
        attachments: parsed.attachments,
        verification,
      };
    }

    if (detection.type === 'signed-data') {
      const v = await smimeVerify(der, fromEmail);
      await maybeAutoImportSigner(v.status);
      const parsed = parseMime(v.mimeBytes);
      await persistVerifyStatus(ctx.id, v.status);
      return {
        ...body,
        handledBy: 'smime',
        html: parsed.html || '',
        text: parsed.text || '',
        attachments: parsed.attachments,
        verification: v.status,
      };
    }
  } catch (err) {
    host.log.error('onRenderEmailBody failed', err);
    return undefined; // fall back to host rendering on unexpected failure
  }

  return undefined;
}

// Sniff the Content-Type of an inner MIME entity (first headers only).
function innerContentType(bytes) {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048));
  const m = head.match(/content-type:\s*([^\r\n]+)/i);
  return m ? m[1].trim() : '';
}

// ─── UI: shared bits ───────────────────────────────────────────────────

const card = {
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: '8px',
  padding: '12px',
  background: 'var(--color-card, #fff)',
  color: 'var(--color-foreground, #0f172a)',
};
const btn = {
  font: 'inherit',
  padding: '6px 12px',
  borderRadius: '6px',
  border: '1px solid var(--color-input, #cbd5e1)',
  background: 'var(--color-muted, #f1f5f9)',
  color: 'var(--color-foreground, #0f172a)',
  cursor: 'pointer',
};
const btnPrimary = { ...btn, background: 'var(--color-primary, #2563eb)', color: 'var(--color-primary-foreground, #fff)', border: '1px solid var(--color-primary, #2563eb)' };
const input = {
  font: 'inherit',
  padding: '6px 8px',
  borderRadius: '6px',
  border: '1px solid var(--color-input, #cbd5e1)',
  background: 'var(--color-background, #fff)',
  color: 'var(--color-foreground, #0f172a)',
  width: '100%',
  boxSizing: 'border-box',
};

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
}
function isExpired(iso) {
  try { return new Date(iso).getTime() < Date.now(); } catch { return false; }
}

// ─── UI: composer toolbar (Sign / Encrypt toggles) ─────────────────────

function ComposerToolbar() {
  const [intent, setIntent] = useState({ sign: false, encrypt: false });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        if (!(await isCapable())) { setReady(false); return; }
        const stored = (await host.storage.get(INTENT_KEY)) || {};
        const prefs = await getPrefs();
        setIntent({
          sign: typeof stored.sign === 'boolean' ? stored.sign : prefs.defaultSign,
          encrypt: typeof stored.encrypt === 'boolean' ? stored.encrypt : prefs.defaultEncrypt,
        });
        const recs = await listKeyRecords();
        setReady(recs.length > 0);
      } catch { setReady(false); }
    })();
  }, []);

  const update = useCallback(async (next) => {
    setIntent(next);
    await host.storage.set(INTENT_KEY, next);
  }, []);

  const toggle = (key) => update({ ...intent, [key]: !intent[key] });

  const pill = (active) => ({
    ...btn,
    background: active ? 'var(--color-primary, #2563eb)' : 'var(--color-muted, #f1f5f9)',
    color: active ? 'var(--color-primary-foreground, #fff)' : 'var(--color-foreground, #0f172a)',
    border: active ? '1px solid var(--color-primary, #2563eb)' : '1px solid var(--color-input, #cbd5e1)',
  });

  if (!ready) {
    return h('span', { style: { fontSize: '12px', color: 'var(--color-muted-foreground, #64748b)' } },
      t('toolbar.needKey'));
  }

  return h('div', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
    h('button', {
      type: 'button',
      style: pill(intent.sign),
      title: t('toolbar.signTitle'),
      onClick: () => toggle('sign'),
    }, intent.sign ? `✓ ${t('toolbar.sign')}` : t('toolbar.sign')),
    h('button', {
      type: 'button',
      style: pill(intent.encrypt),
      title: t('toolbar.encryptTitle'),
      onClick: () => toggle('encrypt'),
    }, intent.encrypt ? `✓ ${t('toolbar.encrypt')}` : t('toolbar.encrypt')),
  );
}

// ─── UI: email banner (verification / encryption status) ───────────────

function EmailBanner(props) {
  const email = props && props.email;
  const [status, setStatus] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showCert, setShowCert] = useState(false);
  const [copiedCert, setCopiedCert] = useState(false);

  // "Unlock now" action for the locked-encryption banner: unlock any locked key
  // (prompting for the storage passphrase), then ask the host to re-run the
  // render hook so the body decrypts in place — no reload (which would wipe the
  // just-unlocked in-memory keys).
  const unlockNow = useCallback(async () => {
    setBusy(true);
    try {
      const recs = await listKeyRecords();
      const locked = [];
      for (const r of recs) {
        const s = await getSessionKeys(r.id);
        if (!(s && s.decryptionKey)) locked.push(r);
      }
      let unlockedAny = false;
      for (const rec of locked) {
        const s = await ensureKeyUnlocked(rec);
        if (s && s.decryptionKey) unlockedAny = true;
        else break; // cancelled or wrong passphrase — stop prompting
      }
      if (!unlockedAny) return;

      await host.ui.rerenderEmail();
      // The re-decrypt runs in the background instance and rewrites the persisted
      // verify status. This banner only read storage once on mount, so poll for
      // the fresh status (until it's no longer 'locked') and update in place.
      if (email && email.id) {
        for (let i = 0; i < 20; i++) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          let next = null;
          try { next = await host.storage.get(VERIFY_PREFIX + email.id); } catch { /* ignore */ }
          if (next && next.decryptionError !== 'locked') { setStatus(next); break; }
        }
      }
    } finally {
      setBusy(false);
    }
  }, [email]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!email || !email.id) { setLoaded(true); return; }
      let s = await host.storage.get(VERIFY_PREFIX + email.id);
      if (!s) {
        // No render-hook result yet — best-effort detect from headers/source.
        const ct = email.headers && (email.headers['Content-Type'] || email.headers['content-type']);
        const det = detectSmime(Array.isArray(ct) ? ct[0] : ct, undefined, undefined);
        if (det.type === 'enveloped-data') s = { isEncrypted: true };
        else if (det.type === 'signed-data' || det.type === 'detached-sig') s = { isSigned: true };
      }
      if (alive) { setStatus(s || null); setLoaded(true); }
    })();
    return () => { alive = false; };
  }, [email && email.id]);

  if (!loaded || !status) return null;

  const rows = [];
  const warnSelfSigned = settings().warnOnSelfSigned !== false;

  if (status.isEncrypted) {
    if (status.decryptionSuccess) rows.push({ icon: 'lockOpen', eyebrow: t('banner.encryption'), text: t('banner.decrypted'), tone: 'success' });
    else if (status.decryptionError === 'locked') rows.push({ icon: 'lock', eyebrow: t('banner.encryption'), text: t('banner.encryptedLocked'), tone: 'warning', action: 'unlock' });
    else if (status.decryptionError) rows.push({ icon: 'lock', eyebrow: t('banner.encryption'), text: t('banner.encryptedFailed'), tone: 'destructive' });
    else rows.push({ icon: 'lock', eyebrow: t('banner.encryption'), text: t('banner.encryptedMessage'), tone: 'info' });
  }
  if (status.isSigned || status.signerCert) {
    if (status.signatureValid) {
      const signerEmail = status.signerCert && status.signerCert.email;
      const mismatch = status.signerEmailMatch === false ? ` · ${t('banner.signerMismatchBadge')}` : '';
      const selfSigned = warnSelfSigned && status.selfSigned;
      const ss = selfSigned ? ` · ${t('banner.selfSignedBadge')}` : '';
      // A valid signature only reads as trusted-green when it also chains to a
      // CA and the signer matches the From. A self-signed cert or a signer≠From
      // mismatch downgrades to an amber warning (still "valid", just untrusted).
      const untrusted = status.signerEmailMatch === false || selfSigned;
      const headline = signerEmail
        ? t('banner.validSignatureBy', { email: signerEmail })
        : t('banner.validSignature');
      rows.push({
        icon: untrusted ? 'shieldAlert' : 'shieldCheck',
        eyebrow: t('banner.signature'),
        text: `${headline}${ss}${mismatch}`,
        tone: untrusted ? 'warning' : 'success',
        cert: status.signerCert,
      });
    } else if (status.signatureError) {
      rows.push({ icon: 'shieldAlert', eyebrow: t('banner.signature'), text: t('banner.invalidSignature', { reason: status.signatureError }), tone: 'destructive', cert: status.signerCert });
    } else {
      rows.push({ icon: 'shieldCheck', eyebrow: t('banner.signature'), text: t('banner.signedMessage'), tone: 'info', cert: status.signerCert });
    }
  }
  if (status.unsupportedReason) rows.push({ icon: 'info', eyebrow: 'S/MIME', text: status.unsupportedReason, tone: 'info' });

  if (rows.length === 0) return null;

  const toneColor = (tone) => tone === 'success' ? 'var(--color-success, #16a34a)'
    : tone === 'destructive' ? 'var(--color-destructive, #dc2626)'
      : tone === 'warning' ? 'var(--color-warning, #d97706)'
        : 'var(--color-info, #0284c7)';

  // Mirror the host's "External Content" banner: a full-width bg-muted/30 strip
  // with a bottom border, each status as a round tinted icon chip + uppercase
  // eyebrow + foreground message.
  return h('div', {
    style: {
      background: 'color-mix(in srgb, var(--color-muted, #f1f5f9) 30%, transparent)',
      borderBottom: '1px solid var(--color-border, #e2e8f0)',
      padding: '6px 24px',
      display: 'flex', flexDirection: 'column', gap: '4px',
    },
  },
    rows.map((r, i) => {
      const color = toneColor(r.tone);
      return h('div', { key: i, style: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '4px 0' } },
        h('div', {
          style: {
            width: '40px', height: '40px', borderRadius: '9999px', flexShrink: 0,
            background: `color-mix(in srgb, ${color} 15%, transparent)`,
            color,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
          },
        }, ICONS[r.icon]()),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-muted-foreground, #64748b)' } }, r.eyebrow),
          h('div', { style: { fontSize: '14px', fontWeight: 500, color: 'var(--color-foreground, #0f172a)', overflowWrap: 'break-word' } }, r.text),
          r.action === 'unlock' && h('div', { style: { marginTop: '8px' } },
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: unlockNow,
              style: {
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                fontSize: '13px', padding: '6px 12px', borderRadius: '8px', minHeight: '34px',
                border: '1px solid var(--color-border, #e2e8f0)',
                background: 'transparent', color: 'var(--color-foreground, #0f172a)',
                cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
              },
            }, ICONS.lockOpen(15), busy ? t('banner.unlocking') : t('banner.unlockNow')),
          ),
          r.cert && h('div', { style: { marginTop: '6px' } },
            h('button', {
              type: 'button',
              onClick: () => setShowCert((v) => !v),
              style: {
                fontSize: '13px', padding: 0, border: 'none', background: 'transparent',
                color: 'var(--color-info, #0284c7)', cursor: 'pointer', textDecoration: 'underline',
              },
            }, showCert ? t('banner.hideCertDetails') : t('banner.viewCertDetails')),
            showCert && h('div', {
              style: {
                marginTop: '8px', padding: '10px 12px', borderRadius: '8px',
                border: '1px solid var(--color-border, #e2e8f0)',
                background: 'color-mix(in srgb, var(--color-muted, #f1f5f9) 40%, transparent)',
                fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                display: 'flex', flexDirection: 'column', gap: '4px', overflowWrap: 'anywhere',
              },
            },
              h('div', null, h('strong', null, `${t('banner.certSubject')}: `), r.cert.subject),
              h('div', null, h('strong', null, `${t('banner.certIssuer')}: `), r.cert.issuer),
              r.cert.email && h('div', null, h('strong', null, `${t('banner.certEmail')}: `), r.cert.email),
              h('div', null, h('strong', null, `${t('banner.certValid')}: `), `${fmtDate(r.cert.notBefore)} – ${fmtDate(r.cert.notAfter)}`),
              h('div', null, h('strong', null, `${t('banner.certFingerprint')}: `), r.cert.fingerprint),
              Array.isArray(r.cert.chainCertificates) && r.cert.chainCertificates.length > 0 &&
                h('div', null, h('strong', null, `${t('banner.certChain')}: `), t('banner.certChainCount', { count: r.cert.chainCertificates.length })),
              h('div', { style: { marginTop: '4px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h('button', {
                  type: 'button',
                  onClick: () => copyCertificateToClipboard(r.cert, setCopiedCert, false),
                  style: {
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    fontSize: '12px', padding: '5px 10px', borderRadius: '6px', minHeight: '30px',
                    border: '1px solid var(--color-border, #e2e8f0)',
                    background: 'transparent', color: 'var(--color-foreground, #0f172a)',
                    cursor: 'pointer', fontFamily: 'inherit',
                  },
                }, copiedCert ? t('banner.copied') : t('banner.copyCert')),
                Array.isArray(r.cert.chainCertificates) && r.cert.chainCertificates.length > 0 &&
                  h('button', {
                    type: 'button',
                    onClick: () => copyCertificateToClipboard(r.cert, setCopiedCert, true),
                    style: {
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      fontSize: '12px', padding: '5px 10px', borderRadius: '6px', minHeight: '30px',
                      border: '1px solid var(--color-border, #e2e8f0)',
                      background: 'transparent', color: 'var(--color-foreground, #0f172a)',
                      cursor: 'pointer', fontFamily: 'inherit',
                    },
                  }, copiedCert ? t('banner.copied') : t('banner.copyChain')),
              ),
            ),
          ),
        ),
      );
    }),
  );
}

// ─── UI: settings section (key & certificate management) ───────────────

function SettingsSection() {
  const [keys, setKeys] = useState([]);
  const [certs, setCerts] = useState([]);
  const [prefs, setPrefsState] = useState(DEFAULT_PREFS);
  const [unlocked, setUnlocked] = useState({}); // id -> bool
  const [busy, setBusy] = useState(false);
  const [capable, setCapable] = useState(true);
  const fileRef = useRef(null);
  const certFileRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!(await isCapable())) { setCapable(false); return; }
    const [k, c, p] = await Promise.all([listKeyRecords(), listPublicCerts(), getPrefs()]);
    setKeys(k); setCerts(c); setPrefsState(p);
    const u = {};
    for (const rec of k) u[rec.id] = !!(await getSessionKeys(rec.id));
    setUnlocked(u);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!capable) {
    return h('div', { style: { ...card, borderColor: 'var(--color-destructive, #dc2626)', color: 'var(--color-destructive, #dc2626)', maxWidth: '720px' } },
      h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, t('settings.notActive')),
      h('div', { style: { fontSize: '13px', lineHeight: 1.5 } }, NOT_PRIVILEGED_MSG),
    );
  }

  async function importKeyFile() {
    const file = fileRef.current && fileRef.current.files && fileRef.current.files[0];
    if (!file) return;
    const answers = await host.ui.prompt({
      title: t('settings.importKeyDialogTitle'),
      message: t('settings.importKeyDialogMessage', { file: file.name }),
      confirmLabel: t('settings.importDialogConfirm'),
      fields: [
        { name: 'p12pass', label: t('settings.p12PassLabel'), type: 'password', placeholder: t('settings.p12PassPlaceholder') },
        { name: 'storagePass', label: t('settings.storagePassLabel'), type: 'password', required: true },
      ],
    });
    if (!answers) return; // cancelled
    const p12pass = answers.p12pass || '';
    const storagePass = answers.storagePass || '';
    if (!storagePass) { host.toast.error(t('settings.storagePassRequired')); return; }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const { keyRecord } = await importPkcs12(buf, p12pass, storagePass);
      await saveKeyRecord(keyRecord);
      host.toast.success(t('settings.importKeySuccess', { email: keyRecord.email || 'certificate' }));
      if (fileRef.current) fileRef.current.value = '';
      await refresh();
    } catch (err) {
      host.toast.error(t('settings.importKeyFailed', { reason: err && err.message ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function unlock(rec) {
    const answers = await host.ui.prompt({
      title: t('settings.unlockDialogTitle', { email: rec.email || t('settings.certUnknown') }),
      confirmLabel: t('settings.unlockConfirm'),
      fields: [
        { name: 'pass', label: t('settings.storagePassForKeyLabel'), type: 'password', required: true },
      ],
    });
    if (!answers) return; // cancelled
    const pass = answers.pass || '';
    if (!pass) return;
    setBusy(true);
    try {
      const { signingKey, decryptionKey, legacyDecryptionKey } = await unlockPrivateKey(rec, pass);
      await saveSessionKeys({ id: rec.id, signingKey, decryptionKey, legacyDecryptionKey });
      host.toast.success(t('settings.unlockSuccess', { email: rec.email || t('settings.keyFallback') }));
      await refresh();
    } catch (err) {
      host.toast.error(err && err.message ? err.message : t('settings.unlockFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function lock(rec) {
    await deleteSessionKeys(rec.id);
    host.toast.info(t('settings.lockedToast', { email: rec.email || t('settings.keyFallback') }));
    await refresh();
  }

  async function removeKey(rec) {
    const ok = await host.ui.confirm({
      title: t('settings.deleteDialogTitle'),
      message: t('settings.deleteDialogMessage', { email: rec.email || t('settings.deleteDialogFallbackIdentity') }),
      danger: true,
      confirmLabel: t('settings.deleteConfirm'),
    });
    if (!ok) return;
    await deleteSessionKeys(rec.id);
    await deleteKeyRecord(rec.id);
    host.toast.success(t('settings.keyDeletedToast'));
    await refresh();
  }

  async function importCertFile() {
    const file = certFileRef.current && certFileRef.current.files && certFileRef.current.files[0];
    if (!file) return;
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const cert = parseCertificatePemOrDer(buf);
      const der = cert.toSchema(true).toBER(false);
      const info = await extractCertificateInfo(cert, der);
      const email = (info.emailAddresses[0] || '').toLowerCase();
      if (!email) throw new Error(t('settings.certNoEmail'));
      await savePublicCert({
        id: generateUUID(),
        email,
        certificate: der,
        issuer: info.issuer,
        subject: info.subject,
        notBefore: info.notBefore,
        notAfter: info.notAfter,
        fingerprint: info.fingerprint,
        source: 'manual',
      });
      host.toast.success(t('settings.importCertSuccess', { email }));
      if (certFileRef.current) certFileRef.current.value = '';
      await refresh();
    } catch (err) {
      host.toast.error(t('settings.importCertFailed', { reason: err && err.message ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function removeCert(c) {
    await deletePublicCert(c.id);
    await refresh();
  }

  async function setPref(key, value) {
    const next = { ...prefs, [key]: value };
    setPrefsState(next);
    await setPrefs(next);
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' } },
    h('div', null,
      h('h3', { style: { margin: '0 0 4px', fontSize: '15px', fontWeight: 600 } }, t('settings.yourKeys')),
      h('p', { style: { margin: '0 0 8px', fontSize: '13px', color: 'var(--color-muted-foreground, #64748b)' } },
        t('settings.yourKeysDesc')),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
        h('input', { ref: fileRef, type: 'file', accept: '.p12,.pfx', style: { fontSize: '13px' } }),
        h('button', { type: 'button', style: btnPrimary, disabled: busy, onClick: importKeyFile }, t('settings.importKey')),
      ),
      keys.length === 0
        ? h('div', { style: { ...card, fontSize: '13px', color: 'var(--color-muted-foreground, #64748b)' } }, t('settings.noKeys'))
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          keys.map((rec) => h('div', { key: rec.id, style: card },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
              h('div', null,
                h('div', { style: { fontWeight: 600, fontSize: '14px' } }, rec.email || rec.subject || t('settings.certUnknown')),
                h('div', { style: { fontSize: '12px', color: 'var(--color-muted-foreground, #64748b)' } },
                  `${rec.algorithm} · ${t('settings.validRange', { from: fmtDate(rec.notBefore), to: fmtDate(rec.notAfter) })}${isExpired(rec.notAfter) ? ` · ${t('settings.expired')}` : ''}`),
                h('div', { style: { fontSize: '11px', fontFamily: 'monospace', color: 'var(--color-muted-foreground, #64748b)', wordBreak: 'break-all' } },
                  rec.fingerprint),
                h('div', { style: { fontSize: '11px', color: 'var(--color-muted-foreground, #64748b)' } },
                  `${rec.capabilities && rec.capabilities.canSign ? t('settings.capSign') : ''}${rec.capabilities && rec.capabilities.canSign && rec.capabilities.canEncrypt ? ' · ' : ''}${rec.capabilities && rec.capabilities.canEncrypt ? t('settings.capEncrypt') : ''}`),
              ),
              h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } },
                unlocked[rec.id]
                  ? h('button', { type: 'button', style: btn, disabled: busy, onClick: () => lock(rec) }, `🔓 ${t('settings.lock')}`)
                  : h('button', { type: 'button', style: btnPrimary, disabled: busy, onClick: () => unlock(rec) }, `🔒 ${t('settings.unlock')}`),
                h('button', {
                  type: 'button',
                  style: { ...btn, color: 'var(--color-destructive, #dc2626)', borderColor: 'var(--color-destructive, #dc2626)' },
                  disabled: busy, onClick: () => removeKey(rec),
                }, t('settings.delete')),
              ),
            ),
          )),
        ),
    ),

    h('div', null,
      h('h3', { style: { margin: '0 0 4px', fontSize: '15px', fontWeight: 600 } }, t('settings.recipientCerts')),
      h('p', { style: { margin: '0 0 8px', fontSize: '13px', color: 'var(--color-muted-foreground, #64748b)' } },
        t('settings.recipientCertsDesc')),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
        h('input', { ref: certFileRef, type: 'file', accept: '.pem,.crt,.cer,.der', style: { fontSize: '13px' } }),
        h('button', { type: 'button', style: btn, disabled: busy, onClick: importCertFile }, t('settings.importCert')),
      ),
      certs.length === 0
        ? h('div', { style: { ...card, fontSize: '13px', color: 'var(--color-muted-foreground, #64748b)' } }, t('settings.noCerts'))
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          certs.map((c) => h('div', { key: c.id, style: { ...card, display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' } },
            h('div', null,
              h('div', { style: { fontWeight: 600, fontSize: '13px' } }, c.email || c.subject),
              h('div', { style: { fontSize: '11px', color: 'var(--color-muted-foreground, #64748b)' } },
                `${c.source} · ${t('settings.certExpires', { date: fmtDate(c.notAfter) })}${isExpired(c.notAfter) ? ` · ${t('settings.expired')}` : ''}`),
            ),
            h('button', { type: 'button', style: { ...btn, color: 'var(--color-destructive, #dc2626)' }, onClick: () => removeCert(c) }, t('settings.remove')),
          )),
        ),
    ),

    h('div', null,
      h('h3', { style: { margin: '0 0 8px', fontSize: '15px', fontWeight: 600 } }, t('settings.defaults')),
      h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', marginBottom: '6px' } },
        h('input', { type: 'checkbox', checked: !!prefs.defaultSign, onChange: (e) => setPref('defaultSign', e.target.checked) }),
        t('settings.defaultSign')),
      h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px' } },
        h('input', { type: 'checkbox', checked: !!prefs.defaultEncrypt, onChange: (e) => setPref('defaultEncrypt', e.target.checked) }),
        t('settings.defaultEncrypt')),
    ),
  );
}

// ─── Exports ───────────────────────────────────────────────────────────

// Before a send commits: if the user is signing but their key is locked,
// prompt to unlock it here rather than failing mid-send in onComposeSend.
// Returning false aborts the send cleanly — the draft and open composer are
// preserved — so a cancelled unlock never loses the message.
async function onBeforeEmailSend(email) {
  try {
    if (!email || typeof email !== 'object') return true;
    if (!(await isCapable())) return true;
    // Resolve the sign intent the way onComposeSend does: the composer-toolbar
    // slot's stored intent, falling back to prefs. (Encrypt needs no private key.)
    const stored = (await host.storage.get(INTENT_KEY)) || {};
    const prefs = await getPrefs();
    const sign = typeof stored.sign === 'boolean' ? stored.sign : prefs.defaultSign;
    if (!sign) return true;

    const from = parseAddr(email.fromEmail || email.from || '');
    if (!from.email) return true;
    const keyRecord = await signingKeyRecordForEmail(from.email);
    if (!keyRecord) return true; // onComposeSend surfaces the "no key" message

    const session = await getSessionKeys(keyRecord.id);
    if (session && session.signingKey) return true; // already unlocked

    const unlocked = await ensureKeyUnlocked(keyRecord);
    return !!(unlocked && unlocked.signingKey); // false → cancelled/failed → abort send
  } catch (err) {
    host.log.warn('onBeforeEmailSend unlock check failed', err);
    return true; // never block a send on an unexpected error here
  }
}

export const hooks = {
  onBeforeEmailSend,
  onComposeSend,
  onRenderEmailBody,
  // Wipe unlocked keys from the shared session store on sign-out / account switch.
  async onAfterLogout() {
    if (settings().lockOnLogout === false) return;
    try { await clearSessionKeys(); } catch (err) { host.log.warn('clearSessionKeys failed', err); }
  },
  async onAccountSwitch() {
    if (settings().lockOnLogout === false) return;
    try { await clearSessionKeys(); } catch (err) { host.log.warn('clearSessionKeys failed', err); }
  },
};

export const slots = {
  'composer-toolbar': { component: ComposerToolbar, order: 70 },
  'email-banner': { component: EmailBanner, order: 20 },
  'settings-section': { component: SettingsSection, order: 100 },
};

export async function activate(api) {
  // Bail out gracefully if we're not in the privileged (same-origin) tier — do
  // NOT throw, or the circuit breaker disables the plugin after a raw IDB error.
  if (!(await isCapable())) {
    api.log.error(NOT_PRIVILEGED_MSG);
    try { api.toast.error('S/MIME needs the privileged tier — see plugin logs / contact your admin.'); } catch { /* ignore */ }
    return;
  }
  // Enforce session scope for unlocked keys: wipe any left over from a prior
  // app session at boot (mirrors the native "in-memory, cleared on reload").
  try { await clearSessionKeys(); } catch (err) { api.log.warn('S/MIME: clearSessionKeys failed', err); }
  let keyCount = 0;
  try { keyCount = (await listKeyRecords()).length; } catch (err) { api.log.warn('S/MIME: listKeyRecords failed', err); }
  api.log.info(`S/MIME plugin activated (${keyCount} key${keyCount === 1 ? '' : 's'} imported)`);
}
