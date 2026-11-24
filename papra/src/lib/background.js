// The background side: "From Papra" in the composer's Attach menu, and
// "Save to Papra" on attachments and on the open message. index.js wires it
// to the host.

import { chooseOrganization, clientFor, connectPersonal, rememberOrganization, resolveConnection, storedOrganization } from './connection.js';
import { PapraError, errorText } from './errors.js';
import { readForSaving } from './documents.js';

export const ACTION_ATTACH = 'from-papra';
export const ACTION_SAVE_ATTACHMENT = 'save-attachment';
export const ACTION_SAVE_MESSAGE = 'save-message';

export function createBackground(api) {
  const t = (key, vars) => api.i18n.t(key, vars);

  /** A connected state, asking the user to connect when there is none. */
  async function ensureConnection() {
    const connection = await resolveConnection(api);
    if (connection.state === 'connected') return connection;
    const go = await api.ui.confirm({ title: t('connect.title'), message: t('connect.needed'), confirmLabel: t('connect.button'), cancelLabel: t('common.cancel') });
    if (!go) return null;
    const result = await connectPersonal(api, connection.suggestedServer);
    if (!result.connected) {
      if (result.error) throw result.error;
      return null;
    }
    return result.connection;
  }

  async function attachFromPapra(composerId) {
    const result = await api.ui.openDialog({
      title: t('picker.title'),
      slot: 'plugin-dialog',
      extraProps: { view: 'picker', composerId },
      width: 820,
    });
    const attached = Number(result?.attached) || 0;
    if (attached) api.toast.success(t('picker.attached', { count: attached }));
    return attached;
  }

  /**
   * Save an attachment or the whole message. With one organization it goes
   * straight there; with several the user picks one (the last one picked
   * comes first).
   */
  async function save(item) {
    try {
      const connection = await ensureConnection();
      if (!connection) return null;
      const client = clientFor(api, connection);
      const organizations = await client.organizations();
      if (!organizations.length) throw new PapraError('error.no_organization');
      let organizationId = chooseOrganization(organizations, await storedOrganization(api));
      if (organizations.length > 1) {
        const choice = await api.ui.openDialog({
          title: t('save.action'),
          slot: 'plugin-dialog',
          extraProps: { view: 'save', kind: item.kind, name: item.name || '', organizations, organizationId },
          width: 480,
        });
        if (!choice || !organizations.some((o) => o.id === choice.organizationId)) return null;
        organizationId = choice.organizationId;
        await rememberOrganization(api, organizationId);
      }
      const file = await readForSaving(api, item);
      const doc = await client.upload(organizationId, file);
      api.toast.success(t('save.done', { name: doc.name }));
      return { organizationId, ...doc };
    } catch (err) {
      api.toast.error(errorText(t, err));
      return null;
    }
  }

  /** onAction: start the work and return at once (the host times hooks out). */
  function onAction({ actionId, context } = {}) {
    const ctx = context || {};
    if (actionId === ACTION_ATTACH && typeof ctx.composerId === 'string' && ctx.composerId) return attachFromPapra(ctx.composerId);
    if (actionId === ACTION_SAVE_ATTACHMENT && ctx.emailId && ctx.blobId) {
      return save({ kind: 'attachment', emailId: ctx.emailId, blobId: ctx.blobId, name: ctx.name, type: ctx.type });
    }
    if (actionId === ACTION_SAVE_MESSAGE && ctx.emailId) return save({ kind: 'message', emailId: ctx.emailId });
    return null;
  }

  /** The menu entries, in the current language. */
  async function registerUi() {
    const calls = [
      api.ui.setActions('composer-attach-menu', [{ id: ACTION_ATTACH, label: t('composer.attach_menu'), icon: 'folder' }]),
      api.ui.setActions('attachment-menu', [{ id: ACTION_SAVE_ATTACHMENT, label: t('save.action'), icon: 'cloud-upload' }]),
      api.ui.setActions('reader-actions', [{ id: ACTION_SAVE_MESSAGE, label: t('save.message_action'), icon: 'cloud-upload', order: 210 }]),
    ];
    await Promise.all(calls.map((p) => Promise.resolve(p).catch((err) => api.log?.warn?.('setup failed', err?.message))));
  }

  return { onAction, registerUi, save, attachFromPapra };
}
