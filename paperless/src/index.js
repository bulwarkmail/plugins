// Paperless-ngx for Bulwark: send attachments and messages to Paperless,
// find documents there and attach them to new mail.

import { createElement as h } from 'react';
import { createBackground } from './lib/background.js';
import { setApi } from './ui/host.js';
import { SendDialog } from './ui/SendDialog.jsx';
import { DocumentBrowser } from './ui/DocumentBrowser.jsx';
import { Settings } from './ui/Settings.jsx';

let background = null;

export async function activate(api) {
  setApi(api);
  background = createBackground(api);
  await background.registerUi();
  api.i18n.onLocaleChange(() => { void background.registerUi(); });
  await background.resume();
}

// Hooks answer at once; the work runs on (the host gives up on slow hooks
// and turns off plugins whose hooks keep failing).
export const hooks = {
  onAction(event) {
    if (background) void Promise.resolve(background.onAction(event)).catch(() => {});
  },
  onNewEmailReceived(email) {
    if (background) void background.onNewEmail(email).catch(() => {});
  },
  onNotificationClick(event) {
    if (background) void background.onNotificationClick(event).catch(() => {});
  },
  onInterval() {
    if (background && !background.poller.running) void background.resume();
  },
};

function Dialog(props) {
  if (props.view === 'send') return h(SendDialog, props);
  // From a composer's Attach menu the documents go into that message.
  if (props.composerId) {
    return h(DocumentBrowser, { inDialog: true, composerId: props.composerId, onClose: (attached) => props.onResult?.({ attached }) });
  }
  return h(DocumentBrowser, { inDialog: true, onClose: () => props.onResult?.(null) });
}

export const slots = {
  'plugin-dialog': { component: Dialog },
  'app-page': { component: () => h(DocumentBrowser, {}) },
  'settings-section': { component: Settings },
};
