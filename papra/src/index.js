// Papra for Bulwark: attach documents from Papra to the message you are
// writing, and save attachments and whole messages to Papra. Every request
// goes through the webmail's proxy with the user's "personal" credential,
// so the API key never reaches the plugin.

import { createElement as h } from 'react';
import { createBackground } from './lib/background.js';
import { setApi } from './ui/host.js';
import { Picker } from './ui/Picker.jsx';
import { SaveDialog } from './ui/SaveDialog.jsx';
import { Settings } from './ui/Settings.jsx';

let background = null;

export async function activate(api) {
  setApi(api);
  background = createBackground(api);
  await background.registerUi();
  api.i18n.onLocaleChange(() => { void background.registerUi(); });
}

// Hooks answer at once; the work runs on (the host gives up on slow hooks).
export const hooks = {
  onAction(event) {
    if (background) void Promise.resolve(background.onAction(event)).catch(() => {});
  },
};

function Dialog(props) {
  if (props.view === 'save') return h(SaveDialog, props);
  return h(Picker, { composerId: props.composerId, onClose: (attached) => props.onResult?.({ attached }) });
}

export const slots = {
  'plugin-dialog': { component: Dialog },
  'settings-section': { component: Settings },
};
