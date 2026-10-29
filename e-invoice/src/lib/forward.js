// "Forward to accounting": where it goes, what goes along, and what the
// plugin remembers about it. The host (api.email.forward) builds and sends
// the forward, and asks the user before the first one to an address.

import { oneLine } from './present.js';

export const FORWARDED_KEY = 'forwarded';
export const ADDRESS_KEY = 'accountingAddress';
const MAX_REMEMBERED = 500;

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export function isAddress(value) {
  return EMAIL_RE.test((value || '').trim());
}

/**
 * The accounting address: the admin's when they set it for everyone, else
 * the user's own setting, else the admin's suggestion, else the one the
 * user typed when first asked.
 */
export function resolveAddress({ config = {}, settings = {}, remembered = '' }) {
  const admin = (config.accountingAddress || '').trim();
  const own = (settings.accountingAddress || '').trim();
  if (admin && config.lockAddress) return admin;
  return [own, admin, remembered].find(isAddress) || '';
}

export function messageKey(email) {
  return `${email.accountId || ''}:${email.id}`;
}

/** { to, at } when this message was forwarded to accounting, else null. */
export async function forwardedInfo(storage, email) {
  const all = (await storage.get(FORWARDED_KEY).catch(() => null)) || {};
  return all[messageKey(email)] || null;
}

export async function recordForward(storage, email, entry) {
  const all = (await storage.get(FORWARDED_KEY).catch(() => null)) || {};
  delete all[messageKey(email)];
  all[messageKey(email)] = entry;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete all[k];
  await storage.set(FORWARDED_KEY, all);
}

/** The note above the forwarded message, in the user's language. */
export function forwardNote(inv, { t, has, locale }) {
  const lines = [t('forward.note', { summary: oneLine(inv, { t, has, locale }) })];
  if (inv.buyerReference) lines.push(`${t('fact.buyer_reference')}: ${inv.buyerReference}`);
  if (inv.orderReference) lines.push(`${t('fact.order')}: ${inv.orderReference}`);
  return lines.join('\n');
}

/** Which attachments go along: every one (the host's default), or only the invoice file. */
export function attachmentsFor(source, mode) {
  return mode === 'forward.invoice_only' && source?.blobId ? [source.blobId] : undefined;
}

/**
 * Ask for the address when none is set, and remember the answer.
 * Resolves to the address or '' when the user cancelled.
 */
async function askAddress(api) {
  const t = (k, v) => api.i18n.t(k, v);
  for (;;) {
    const answer = await api.ui.prompt({
      title: t('ask.title'),
      message: t('ask.message'),
      confirmLabel: t('ask.save'),
      fields: [{ name: 'address', label: t('ask.label'), placeholder: 'rechnungseingang@example.com', required: true }],
    });
    const address = (answer?.address || '').trim();
    if (!answer) return '';
    if (isAddress(address)) {
      await api.storage.set(ADDRESS_KEY, address).catch(() => {});
      return address;
    }
    api.toast.error(t('ask.invalid'));
  }
}

export async function currentAddress(api) {
  const config = await Promise.resolve(api.config.get()).catch(() => ({})) || {};
  const remembered = await api.storage.get(ADDRESS_KEY).catch(() => '') || '';
  return resolveAddress({ config, settings: api.plugin.settings || {}, remembered });
}

/**
 * Forward `email` (an EmailReadView) with its invoice to accounting.
 * `quiet`: no toasts and no address question (automatic forwards).
 * Resolves to 'sent', 'declined', 'stopped', 'no-address' or 'failed'.
 */
export async function forwardToAccounting(api, { email, invoice, source, quiet = false }) {
  const t = (k, v) => api.i18n.t(k, v);
  const i18n = { t, has: (k) => api.i18n.has(k), locale: api.i18n.getLocale() };
  let address = await currentAddress(api);
  if (!address && !quiet) address = await askAddress(api);
  if (!address) return 'no-address';
  try {
    const result = await api.email.forward(email.id, {
      to: [address],
      text: forwardNote(invoice, i18n),
      ...(attachmentsFor(source, api.plugin.settings?.forwardWhat) ? { attachments: attachmentsFor(source, api.plugin.settings.forwardWhat) } : {}),
      ...(email.accountId ? { accountId: email.accountId } : {}),
    });
    if (!result?.sent) {
      if (!quiet && result?.reason === 'stopped') api.toast.info(t('forward.stopped'));
      return result?.reason === 'stopped' ? 'stopped' : 'declined';
    }
    await recordForward(api.storage, email, { to: address, at: new Date().toISOString() }).catch(() => {});
    if (!quiet) api.toast.success(t('forward.done', { address }));
    return 'sent';
  } catch (err) {
    if (!quiet) api.toast.error(t('forward.failed', { error: err?.message || String(err) }));
    return 'failed';
  }
}
