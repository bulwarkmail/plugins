// The background side: the attachment menu entry, the list filter and
// badge, and the look at new mail (tag e-invoices, forward them on their
// own when the user turned that on). index.js wires it to the host.

import { findInvoice, invoiceFromBytes, kindOf } from './detect.js';
import { forwardToAccounting, forwardedInfo } from './forward.js';
import { EINVOICE_KEYWORD } from './scan-cache.js';

export const ACTION_SHOW = 'show-invoice';

export function createBackground(api, { openDialog, tag }) {
  const t = (key, vars) => api.i18n.t(key, vars);
  let queue = Promise.resolve();

  async function registerUi() {
    await Promise.resolve(api.ui.setActions('attachment-menu', [
      { id: ACTION_SHOW, label: t('action.show'), icon: 'file-invoice', mimeTypes: ['application/pdf', 'application/xml', 'text/xml'] },
    ])).catch(() => {});
    const tagging = api.plugin.settings?.tagMessages !== false;
    await Promise.resolve(api.ui.setListFilters(tagging
      ? [{ id: 'einvoices', label: t('filter.label'), icon: 'file-invoice', hasKeyword: EINVOICE_KEYWORD }]
      : [])).catch(() => {});
  }

  async function showAttachment({ emailId, blobId, name, type }) {
    if (!kindOf({ name, type })) return;
    const [file, email] = await Promise.all([
      api.email.getAttachment(emailId, blobId),
      Promise.resolve(api.email.get(emailId)).catch(() => null),
    ]);
    const kind = kindOf({ name: file.name, type: file.type });
    const found = invoiceFromBytes(kind, file.data);
    if (!found) {
      api.toast.info(t('action.not_invoice', { name: file.name }));
      return;
    }
    await openDialog({ invoice: found.invoice, source: { blobId, name: file.name, kind, embeddedName: found.embeddedName || '' }, email });
  }

  async function onAction({ surface, actionId, context }) {
    if (surface === 'attachment-menu' && actionId === ACTION_SHOW && context?.emailId && context?.blobId) {
      try {
        await showAttachment(context);
      } catch (err) {
        api.toast.error(t('action.failed', { error: err?.message || String(err) }));
      }
    }
  }

  async function lookAtNewEmail(summary) {
    const settings = api.plugin.settings || {};
    const tagging = settings.tagMessages !== false;
    if (!summary?.hasAttachment || (!tagging && !settings.autoForward)) return;
    const email = await api.email.get(summary.id, summary.accountId);
    if (!email) return;
    const found = await findInvoice(email.attachments, async (blobId) => (await api.email.getAttachment(email.id, blobId, email.accountId)).data);
    if (!found) return;
    if (tagging) tag(email);
    if (settings.autoForward && !(await forwardedInfo(api.storage, email))) {
      const outcome = await forwardToAccounting(api, { email, invoice: found.invoice, source: found.source, quiet: true });
      if (outcome === 'sent') api.toast.info(t('auto.done', { subject: email.subject || '' }));
    }
  }

  /** One message at a time, so a burst of new mail doesn't download everything at once. */
  function onNewEmail(summary) {
    queue = queue.then(() => lookAtNewEmail(summary)).catch(() => {});
    return queue;
  }

  function badges(current, { email }) {
    if (!(email?.keywords || []).includes(EINVOICE_KEYWORD)) return undefined;
    return [...current, { key: 'einvoice', label: t('badge.list'), icon: 'file-invoice', title: t('badge.list_title') }];
  }

  return { registerUi, onAction, onNewEmail, badges };
}
