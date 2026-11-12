// Keeps a certificate as one the user trusts, the way "Trust this certificate" in the
// signature details does: a trusted signer certificate, by fingerprint. Tests that check
// the plugin reads a mail the way the server does use it, so their controls show the
// trusted verdict whenever the signature and the structure hold.
import { computeFingerprint } from '../../src/certificate-utils.js';
import { saveTrusted } from '../../src/key-storage.js';

export async function trustSigner(der) {
  const fingerprint = await computeFingerprint(der);
  await saveTrusted({ id: `signer-${fingerprint}`, kind: 'signer', fingerprint, addedAt: Date.now() });
}
