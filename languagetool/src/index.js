// Proofreading with LanguageTool for Bulwark Mail.
//
// The webmail decides when text may be checked (its Proofreading setting,
// the admin's policy, never for signed or encrypted mail) and draws the
// underlines. This plugin is the checker: it sends the paragraphs the
// webmail hands it to the LanguageTool server the administrator set up,
// through the webmail's proxy, and answers with what LanguageTool found.
// The logic lives in src/lib/; this file only wires it up.

import { createBackground } from './lib/background.js';
import { SettingsPanel } from './ui/SettingsPanel.jsx';

let background = null;

export default {
  async activate(api) {
    background = createBackground(api);
    await background.activate();
  },
  slots: {
    'settings-section': { component: SettingsPanel },
  },
};
