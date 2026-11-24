// The background side: "From Immich" in the composer's Attach menu and
// "Save to Immich" on attachments. index.js wires it to the host.

import { clientFor, connectPersonal, resolveConnection } from './connection.js';
import { errorText } from './errors.js';
import { saveAttachment } from './media.js';

export const ACTION_ATTACH = 'from-immich';
export const ACTION_SAVE = 'save-attachment';

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

  /** The picker for one composer; it attaches there and says how many it did. */
  async function attachFromImmich(composerId) {
    const result = await api.ui.openDialog({
      title: t('picker.title'),
      slot: 'plugin-dialog',
      extraProps: { view: 'picker', composerId },
      width: 900,
    });
    const attached = Number(result?.attached) || 0;
    if (attached) api.toast.success(t('picker.attached', { count: attached }));
    return attached;
  }

  async function save(ctx) {
    try {
      const connection = await ensureConnection();
      if (!connection) return null;
      const result = await saveAttachment(api, clientFor(api, connection), ctx);
      api.toast.success(t(result.duplicate ? 'save.duplicate' : 'save.done', { name: result.name }));
      return result;
    } catch (err) {
      api.toast.error(errorText(t, err));
      return null;
    }
  }

  /** onAction: start the work and return at once (the host times hooks out). */
  function onAction({ actionId, context } = {}) {
    const ctx = context || {};
    if (actionId === ACTION_ATTACH && typeof ctx.composerId === 'string' && ctx.composerId) return attachFromImmich(ctx.composerId);
    if (actionId === ACTION_SAVE && ctx.emailId && ctx.blobId) return save(ctx);
    return null;
  }

  /** The menu entries, in the current language. */
  async function registerUi() {
    const calls = [
      api.ui.setActions('composer-attach-menu', [{ id: ACTION_ATTACH, label: t('composer.attach_menu'), icon: 'photo' }]),
      api.ui.setActions('attachment-menu', [{ id: ACTION_SAVE, label: t('save.action'), icon: 'cloud-upload' }]),
    ];
    await Promise.all(calls.map((p) => Promise.resolve(p).catch((err) => api.log?.warn?.('setup failed', err?.message))));
  }

  return { onAction, registerUi, save, attachFromImmich };
}
