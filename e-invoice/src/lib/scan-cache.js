// Messages already looked at that hold no e-invoice, so opening them again
// doesn't download their PDFs again. Keyed by message and attachment list.

export const EINVOICE_KEYWORD = '$einvoice';
export const SCANNED_KEY = 'scanned';
const MAX = 500;

export async function knownNoInvoice(storage, key, attachments) {
  const all = (await storage.get(SCANNED_KEY).catch(() => null)) || {};
  return all[key] === attachments;
}

export async function rememberNoInvoice(storage, key, attachments) {
  const all = (await storage.get(SCANNED_KEY).catch(() => null)) || {};
  delete all[key];
  all[key] = attachments;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
  await storage.set(SCANNED_KEY, all).catch(() => {});
}
