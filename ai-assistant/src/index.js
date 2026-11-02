// AI assistant for Bulwark Webmail.
//
// Nothing is sent anywhere until the user asks the assistant something.
// Requests go through the webmail's server proxy, which adds the API key
// the administrator (or the user) set up; the key never reaches the
// browser.

import { createBackground } from './lib/background.js';
import { SettingsPanel } from './ui/SettingsPanel.jsx';
import { Dialog } from './ui/Dialog.jsx';
import { ReaderBar, ThreadSummary } from './ui/Reader.jsx';
import { AssistantPanel } from './ui/Panel.jsx';
import { withStrings } from './lib/i18n.js';

let background = null;
const bg = () => background ?? { shouldShow: { reader: () => false, thread: () => false, composer: () => false, view: () => false }, hooks: {} };

/** The shortcut's name in the user's language (read once when the plugin loads). */
function shortcutLabel() {
  try {
    // eslint-disable-next-line no-undef
    const api = withStrings(require('@plugin-host'));
    return api.i18n.t('shortcut.toggle');
  } catch {
    return 'AI assistant';
  }
}

export default {
  async activate(api) {
    background = createBackground(api);
    await background.activate();
  },
  hooks: {
    onAction: (event) => bg().hooks.onAction?.(event),
    onDraftChange: (draft) => bg().hooks.onDraftChange?.(draft),
    onComposerOpen: (ctx) => bg().hooks.onComposerOpen?.(ctx),
    onComposerClose: () => bg().hooks.onComposerClose?.(),
    onEmailOpen: () => bg().hooks.onEmailOpen?.(),
  },
  // Alt+A opens and closes the panel of the view the user is in: next to
  // Calendar, Contacts, Files or Settings, else next to the message (the
  // composer handles its own Alt+A through its Assistant button).
  shortcuts: {
    'toggle-panel': {
      keys: 'Alt+A',
      get label() { return shortcutLabel(); },
      handler: () => bg().shortcutToggle?.(),
    },
  },
  slots: {
    // The chat panels: next to the message being written and next to the
    // open message. They fill the panel, so the input stays at the bottom,
    // and start folded: the Assistant buttons, Alt+A and the right-click
    // entries open them.
    'composer-sidebar-right': { component: AssistantPanel, fill: true, startFolded: true, shouldShow: () => bg().shouldShow.composer() },
    'email-detail-sidebar': { component: AssistantPanel, fill: true, startFolded: true, shouldShow: () => bg().shouldShow.reader() },
    // The same chat next to Calendar, Contacts, Files and Settings (webmail
    // 1.20 and later; older ones don't know the slot and skip it).
    'app-side-panel': { component: AssistantPanel, fill: true, startFolded: true, shouldShow: () => bg().shouldShow.view() },
    // The bar above a message, for screens without the panel (phones).
    'email-banner': { component: ReaderBar, shouldShow: () => bg().shouldShow.reader() },
    'thread-summary': { component: ThreadSummary, shouldShow: (ctx) => bg().shouldShow.thread(ctx) },
    // The dialog, for composers without a panel (phones).
    'plugin-dialog': { component: Dialog },
    'settings-section': { component: SettingsPanel },
  },
};
