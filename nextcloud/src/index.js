// Nextcloud for Bulwark Mail.
//
// The background part registers actions and hooks; each slot is a React
// component in its own iframe. Every request to Nextcloud goes through the
// webmail's secret proxy with the "nextcloud" credential, so the app
// password never reaches the plugin.

import { setApi } from './lib/host.js';
import { storedAccount } from './lib/connection.js';
import { emlName } from './lib/save.js';
import { applyPickerResult } from './lib/picker-result.js';
import { SettingsSection } from './ui/settings-section.js';
import { PluginDialog } from './ui/dialog.js';
import { FilesPage } from './ui/files-page.js';
import { AddTalkMeetingButton } from './ui/talkmeeting-button.js';

const FIRST_RUN_KEY = 'firstRunOffered';

/**
 * Once per account: if Nextcloud isn't connected yet, say where to connect
 * it. People coming from "Nextcloud Attachments" sign in again here; their
 * old app password is not carried over.
 */
export async function offerFirstRun(api) {
  if (await api.storage.get(FIRST_RUN_KEY)) return false;
  const account = await storedAccount(api);
  await api.storage.set(FIRST_RUN_KEY, true);
  if (account?.connected) return false;
  api.toast.info(api.i18n.t('firstrun.offer'));
  return true;
}

let bg = null;

/** The buttons and menu entries the host draws for the plugin. */
export async function registerActions(api) {
  const t = api.i18n.t;
  await api.ui.setActions('attachment-menu', [{ id: 'save-attachment', label: t('save.attachmentAction'), icon: 'cloud-upload' }]);
  await api.ui.setActions('reader-actions', [{ id: 'save-message', label: t('save.messageAction'), icon: 'cloud-upload', order: 200 }]);
  await api.ui.setActions('composer-attach-menu', [{ id: 'from-nextcloud', label: t('composer.attachMenu'), icon: 'cloud' }]);
  await api.ui.setPages([{ id: 'files', title: t('page.title'), icon: 'cloud' }]);
}

export async function activate(api) {
  bg = api;
  setApi(api);
  await registerActions(api).catch((err) => api.log.warn('setActions failed', err));
  api.i18n.onLocaleChange(() => { void registerActions(api).catch(() => { }); });
  await offerFirstRun(api).catch(() => { });
}

/**
 * "From Nextcloud" in the composer's Attach menu: the picker attaches the
 * chosen files to that composer (its composerId goes to the dialog) or
 * hands back share links, which go into the message at the caret.
 */
export async function attachFromNextcloud(api, composerId) {
  if (typeof composerId !== 'string' || !composerId) return { attached: 0, links: 0 };
  const result = await api.ui.openDialog({
    title: api.i18n.t('picker.title'),
    slot: 'plugin-dialog',
    extraProps: { view: 'picker', composerId },
    width: 760,
  });
  return applyPickerResult(api, result, composerId);
}

/**
 * Host-drawn entries: "From Nextcloud" in the Attach menu, and "Save to
 * Nextcloud" on an attachment or a message (ask for a folder, save, say where).
 */
export async function onAction(api, { surface, actionId, context } = {}) {
  const t = api.i18n.t;
  if (surface === 'composer-attach-menu' && actionId === 'from-nextcloud') {
    await attachFromNextcloud(api, context?.composerId);
    return;
  }
  let props;
  if (surface === 'attachment-menu' && actionId === 'save-attachment') {
    if (!context?.emailId || !context?.blobId) return;
    props = { kind: 'attachment', emailId: context.emailId, blobId: context.blobId, name: context.name || 'attachment', size: Number(context.size) || 0 };
  } else if (surface === 'reader-actions' && actionId === 'save-message') {
    if (!context?.emailId) return;
    const email = await api.email.get(context.emailId).catch(() => null);
    props = { kind: 'message', emailId: context.emailId, name: emlName(email?.subject), size: 0 };
  } else {
    return;
  }
  const title = props.kind === 'message' ? t('save.titleMessage') : t('save.titleAttachment', { name: props.name });
  const result = await api.ui.openDialog({ title, slot: 'plugin-dialog', extraProps: { view: 'save', ...props }, width: 640 });
  if (result && typeof result.path === 'string') api.toast.success(t('save.saved', { path: result.path }));
}

const MB = 1024 * 1024;

/**
 * A file the user attaches in the composer (onBeforeBlobUpload hands over
 * its staged id). From the size in the settings on, offer to upload it to
 * Nextcloud and put a link in the message instead. Returns the composer's
 * ExternalAttachmentResult, or undefined to attach the file as usual.
 */
export async function offerLargeUpload(api, payload) {
  const fileId = typeof payload === 'string' ? payload : payload?.fileId;
  if (typeof fileId !== 'string' || !fileId) return undefined;
  const settings = api.plugin.settings ?? {};
  if (settings.offerLargeUpload === false) return undefined;
  const account = await storedAccount(api);
  if (!account?.connected) return undefined;
  const file = await api.upfiles.get(fileId);
  if (!file) return undefined;
  const threshold = Math.max(1, Number(settings.largeFileMb) || 10) * MB;
  if (file.size < threshold) return undefined;
  const result = await api.ui.openDialog({
    title: api.i18n.t('offload.title'),
    slot: 'plugin-dialog',
    extraProps: { view: 'offload', fileId, name: file.name, size: file.size },
    width: 560,
  });
  if (result && result.externalAttachment === true && typeof result.html === 'string' && typeof result.text === 'string') {
    return { externalAttachment: true, html: result.html, text: result.text, fileId };
  }
  return undefined;
}

export const hooks = {
  onAction: (payload) => (bg ? onAction(bg, payload) : undefined),
  onBeforeBlobUpload: (payload) => (bg ? offerLargeUpload(bg, payload) : undefined),
};

export const slots = {
  'settings-section': { component: SettingsSection },
  'plugin-dialog': { component: PluginDialog },
  'app-page': { component: FilesPage },
  'calendar-event-actions': { component: AddTalkMeetingButton },
};
