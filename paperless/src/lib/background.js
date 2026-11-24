// The background side: buttons on the mail surfaces, the send flow, the
// task follow-up and the rules on new mail. index.js wires it to the host.

import { createClient } from './client.js';
import { clientFor, connectPersonal, resolveConnection } from './connection.js';
import { errorText, toPaperlessError } from './errors.js';
import { documentLink, titleSearchLink } from './links.js';
import { PROCESSED_KEY, RULES_KEY, findRule, markProcessed } from './rules.js';
import { collectAttachment, collectMessage, collectMessages, forDialog, plannedUploads } from './send.js';
import { rememberChoice } from './suggest.js';
import { createPoller, createTaskTracker } from './tasks.js';

export const REMEMBERED_KEY = 'remembered';
export const LINKS_KEY = 'links';

export const ACTION_ATTACHMENT = 'send-attachment';
export const ACTION_MESSAGE = 'send-message';
export const ACTION_BULK = 'send-bulk';
export const ACTION_COMPOSER = 'from-paperless';

export function createBackground(api, { setTimer = setTimeout } = {}) {
  const t = (key, vars) => api.i18n.t(key, vars);
  const toastError = (err) => api.toast.error(errorText(t, err));

  const tracker = createTaskTracker({
    storage: api.storage,
    clientFor: async (entry) => createClient({ proxyFetch: (...a) => api.proxy.fetch(...a), credentialId: entry.credentialId, base: entry.base }),
    onDone: (entry, outcome) => { void reportDone(entry, outcome); },
  });
  const poller = createPoller(tracker, { setTimer });

  /**
   * A notification (also a toast and an entry in the notification centre),
   * with an "Open in Paperless" link when there is one. Without the
   * notification permission, or with notifications off, a plain toast.
   */
  async function tell({ title, body, tag, error, url }) {
    if (api.plugin.settings?.notify !== false) {
      const note = { title: title.slice(0, 120), body: (body || '').slice(0, 300), ...(tag ? { tag } : {}) };
      const action = url ? { label: t('browse.open_in_paperless'), url } : null;
      try {
        await api.notifications.show(action ? { ...note, action } : note);
        return;
      } catch { /* the host refused the link, no permission or rate limited */ }
      if (action) {
        try {
          await api.notifications.show(note);
          return;
        } catch { /* fall back to a toast */ }
      }
    }
    const text = body ? `${title}: ${body}` : title;
    if (error) api.toast.error(text); else api.toast.success(text);
  }

  async function rememberLink(tag, url) {
    const links = (await api.storage.get(LINKS_KEY).catch(() => null)) || {};
    const keys = Object.keys(links);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete links[k];
    links[tag] = url;
    await api.storage.set(LINKS_KEY, links).catch(() => {});
  }

  async function reportDone(entry, outcome) {
    const name = entry.name || entry.fileName || '';
    // Without the document's id: the list, filtered by the title it was sent with.
    const found = entry.base ? titleSearchLink(entry.base, name) : null;
    if (outcome.state === 'success') {
      const known = outcome.documentId != null && entry.base;
      const url = known ? documentLink(entry.base, outcome.documentId) : found;
      const tag = known ? `doc-${outcome.documentId}` : undefined;
      // A click on a system notification arrives as onNotificationClick with the tag.
      if (tag) await rememberLink(tag, url);
      await tell({ title: t('done.title'), body: t('done.body', { name }), tag, url });
    } else if (outcome.state === 'failure') {
      const duplicate = outcome.duplicateOf != null || /duplicate/i.test(outcome.error || '');
      const body = duplicate
        ? t('failed.duplicate', { name })
        : t('failed.body', { name, error: outcome.error || t('failed.unknown') });
      // The copy that is already there.
      const url = outcome.duplicateOf != null && entry.base ? documentLink(entry.base, outcome.duplicateOf) : null;
      const tag = url ? `doc-${outcome.duplicateOf}` : undefined;
      if (tag) await rememberLink(tag, url);
      await tell({ title: t('failed.title'), body, error: true, tag, url });
    } else if (outcome.state === 'timeout') {
      await tell({ title: t('failed.title'), body: t('failed.timeout', { name }), error: true, url: found });
    } else {
      await tell({ title: t('failed.title'), body: `${name}: ${t(outcome.errorKey || 'error.unexpected', {})}`, error: true, url: found });
    }
  }

  /** A connected state, asking the user to connect when there is none. */
  async function ensureConnection() {
    const connection = await resolveConnection(api);
    if (connection.state === 'connected') return connection;
    if (connection.state === 'error') throw connection.error;
    const go = await api.ui.confirm({ title: t('connect.title'), message: t('connect.needed'), confirmLabel: t('connect.button'), cancelLabel: t('common.cancel') });
    if (!go) return null;
    const result = await connectPersonal(api, connection.suggestedServer);
    if (!result.connected) {
      if (result.error) throw result.error;
      return null;
    }
    return result.connection;
  }

  /** Upload what the user picked and follow the tasks. */
  async function upload(connection, groups, choice) {
    const client = clientFor(api, connection);
    const plan = plannedUploads(groups, choice);
    let sent = 0;
    let firstError = null;
    for (const { item, doc } of plan) {
      try {
        const taskId = await client.upload(doc);
        await tracker.add({ taskId, name: doc.title || item.name, base: connection.base, credentialId: connection.credentialId });
        sent++;
      } catch (err) {
        firstError ||= err;
        // A bad token or a full disk won't get better for the next file.
        const key = toPaperlessError(err).key;
        if (['error.token', 'error.full', 'error.forbidden', 'error.not_connected', 'error.rate_limit'].includes(key)) break;
      }
    }
    if (sent) {
      poller.start();
      api.toast.info(t('send.queued', { count: sent }));
    }
    if (firstError) toastError(firstError);
    return { sent, failed: plan.length - sent };
  }

  async function sendFlow(collect) {
    let connection;
    try {
      connection = await ensureConnection();
      if (!connection) return null;
    } catch (err) {
      toastError(err);
      return null;
    }
    let groups;
    try {
      groups = await collect();
    } catch (err) {
      toastError(err);
      return null;
    }
    if (!groups.length || !groups.some((g) => g.items.length)) {
      api.toast.info(t('send.nothing'));
      return null;
    }
    const choice = await api.ui.openDialog({
      title: t('dialog.title'),
      slot: 'plugin-dialog',
      extraProps: { view: 'send', groups: forDialog(groups), connection },
      width: 640,
    });
    if (!choice || !Array.isArray(choice.selected) || choice.selected.length === 0) return null;
    if (choice.remember && choice.senderEmail) {
      const remembered = (await api.storage.get(REMEMBERED_KEY).catch(() => null)) || {};
      await api.storage.set(REMEMBERED_KEY, rememberChoice(remembered, choice.senderEmail, choice)).catch(() => {});
    }
    return upload(connection, groups, choice);
  }

  /**
   * "From Paperless" in a composer's Attach menu: the browser attaches the
   * picked documents to that message (it asks to connect first when needed).
   */
  async function attachFromPaperless(composerId) {
    const result = await api.ui.openDialog({
      title: t('page.title'),
      slot: 'plugin-dialog',
      extraProps: { view: 'browse', composerId },
      width: 900,
    });
    const attached = Number(result?.attached) || 0;
    if (attached) api.toast.success(t('composer.attached', { count: attached }));
    return attached;
  }

  /** onAction: start the flow and return at once (the host times hooks out). */
  function onAction({ surface, actionId, context } = {}) {
    const ctx = context || {};
    if (actionId === ACTION_COMPOSER && typeof ctx.composerId === 'string' && ctx.composerId) {
      return attachFromPaperless(ctx.composerId);
    }
    if (actionId === ACTION_ATTACHMENT && ctx.emailId && ctx.blobId) {
      return sendFlow(() => collectAttachment(api, ctx));
    }
    if (actionId === ACTION_MESSAGE && ctx.emailId) {
      return sendFlow(async () => [await collectMessage(api, ctx.emailId)]);
    }
    if (actionId === ACTION_BULK && Array.isArray(ctx.emailIds) && ctx.emailIds.length) {
      if (ctx.emailIds.length > 25) api.toast.warning(t('send.bulk_limit', { count: 25 }));
      return sendFlow(() => collectMessages(api, ctx.emailIds));
    }
    void surface;
    return null;
  }

  /** A rule the user switched on sends matching new mail without a dialog. */
  async function onNewEmail(email) {
    if (!email?.id) return null;
    const rules = await api.storage.get(RULES_KEY).catch(() => null);
    const rule = findRule(rules, email);
    if (!rule) return null;
    const processed = await api.storage.get(PROCESSED_KEY).catch(() => null);
    const mark = markProcessed(processed, email.id);
    if (!mark.added) return null;
    await api.storage.set(PROCESSED_KEY, mark.list);
    try {
      const connection = await resolveConnection(api);
      if (connection.state !== 'connected') return null;
      const group = await collectMessage(api, email.id);
      const items = rule.what === 'message'
        ? group.items.filter((i) => i.kind === 'eml')
        : group.items.filter((i) => i.kind === 'file' && i.support === 'yes');
      if (!items.length) return null;
      const choice = {
        selected: items.map((i) => i.key), correspondent: rule.correspondent, documentType: rule.documentType,
        storagePath: rule.storagePath, tags: rule.tags,
      };
      return await upload(connection, [group], choice);
    } catch (err) {
      toastError(err);
      return null;
    }
  }

  async function onNotificationClick({ tag } = {}) {
    if (typeof tag !== 'string' || !tag.startsWith('doc-')) return;
    const links = (await api.storage.get(LINKS_KEY).catch(() => null)) || {};
    if (links[tag]) await api.ui.openExternalUrl(links[tag]);
  }

  /** Buttons and the page, in the current language. */
  async function registerUi() {
    const label = t('action.send');
    const calls = [
      api.ui.setActions('attachment-menu', [{ id: ACTION_ATTACHMENT, label, icon: 'archive-restore' }]),
      api.ui.setActions('reader-actions', [{ id: ACTION_MESSAGE, label, icon: 'archive-restore' }]),
      api.ui.setActions('message-bulk-actions', [{ id: ACTION_BULK, label, icon: 'archive-restore' }]),
      api.ui.setActions('composer-attach-menu', [{ id: ACTION_COMPOSER, label: t('composer.attach_menu'), icon: 'archive' }]),
      api.ui.setPages([{ id: 'documents', title: t('page.title'), icon: 'archive' }]),
    ];
    await Promise.all(calls.map((p) => Promise.resolve(p).catch((err) => api.log?.warn?.('setup failed', err?.message))));
  }

  async function resume() {
    const open = await tracker.pending().catch(() => []);
    if (open.length) poller.start();
  }

  return { onAction, onNewEmail, onNotificationClick, registerUi, resume, tracker, poller, sendFlow, upload, reportDone };
}
