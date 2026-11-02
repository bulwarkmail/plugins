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

let background = null;
const bg = () => background ?? { shouldShow: { reader: () => false, thread: () => false, composer: () => false }, hooks: {} };

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
  slots: {
    // The chat panels: next to the message being written and next to the
    // open message. They fill the panel, so the input stays at the bottom,
    // and start folded: the Assistant buttons, Alt+A and the right-click
    // entries open them.
    'composer-sidebar-right': { component: AssistantPanel, fill: true, startFolded: true, shouldShow: () => bg().shouldShow.composer() },
    'email-detail-sidebar': { component: AssistantPanel, fill: true, startFolded: true, shouldShow: () => bg().shouldShow.reader() },
    // The bar above a message, for screens without the panel (phones).
    'email-banner': { component: ReaderBar, shouldShow: () => bg().shouldShow.reader() },
    'thread-summary': { component: ThreadSummary, shouldShow: (ctx) => bg().shouldShow.thread(ctx) },
    // The dialog, for composers without a panel (phones).
    'plugin-dialog': { component: Dialog },
    'settings-section': { component: SettingsPanel },
  },
};
