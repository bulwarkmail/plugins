/**
 * Send Checks: the admin's rules for what may leave in a message. Before a
 * message is sent (composer, quick reply, a plugin's forward) it looks for
 * IBANs, payment card numbers, keywords and the admin's own patterns, and
 * checks attachment types and sizes. Each rule warns (the user may send
 * anyway) or blocks, and can count only when the message goes outside the
 * organisation.
 *
 * - onBeforeEmailSend fails closed in the host: if this handler throws or
 *   never answers, nothing is sent. A match is shown with its rule and a
 *   masked form, never the whole number.
 * - onBeforeAttachmentUpload refuses a blocked file type or a file over the
 *   size limit right when it is attached, when the attachment rule blocks
 *   and doesn't depend on the recipients.
 * - The admin's settings come from api.config.get() (no secrets). Rules are
 *   global for the plugin, not per domain or group. A failed read keeps the
 *   last settings that were read; with none read yet, nothing is sent.
 * - It fails closed: a blocking rule that couldn't be checked (patterns out
 *   of time, a pattern line that can't run, a file the host couldn't read)
 *   stops the send like a match; a warning rule that couldn't finish asks.
 */

import { compileRules, evaluate, uploadProblem } from './lib/scan.js';
import { normaliseConfig } from './lib/config.js';
import { dialogFor, FALLBACK, formatMb } from './lib/messages.js';

let pluginApi = null;
let compiled = compileRules(normaliseConfig({}));
let configKey = '';
// Whether the admin's settings were ever read. Until then the defaults
// would be a guess, and a block rule the admin set wouldn't apply.
let configLoaded = false;

function tr(key, vars) {
  const i18n = pluginApi && pluginApi.i18n;
  if (i18n && typeof i18n.has === 'function' && i18n.has(key)) return i18n.t(key, vars);
  return String(FALLBACK[key] || key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
}

/**
 * The rules as the admin set them now, or null when they were never read.
 * A failed read keeps the last rules that were read, so a hiccup never
 * turns them off.
 */
async function currentRules() {
  try {
    const raw = await pluginApi.config.get();
    if (raw !== null && typeof raw !== 'object') throw new Error('settings are not an object');
    const key = JSON.stringify(raw ?? {});
    if (key !== configKey || !configLoaded) {
      configKey = key;
      compiled = compileRules(normaliseConfig(raw));
      for (const { line, reason } of compiled.skippedPatterns) {
        pluginApi.log.warn(`Pattern line can't run (${reason}), it counts as a rule that couldn't be checked: ${line}`);
      }
    }
    configLoaded = true;
  } catch (err) {
    pluginApi.log.warn(configLoaded ? 'Could not read the admin settings; using the last ones' : 'Could not read the admin settings', err);
  }
  return configLoaded ? compiled : null;
}

export async function activate(api) {
  pluginApi = api;
  await currentRules();
  api.log.info('Send Checks plugin activated');
}

export const hooks = {
  async onBeforeEmailSend(email) {
    if (!pluginApi || !email) return undefined;
    const rules = await currentRules();
    if (!rules) {
      await pluginApi.ui.alert({ title: tr('unchecked.title'), message: tr('unchecked.config') });
      return false;
    }
    const { found, incomplete } = await evaluate(email, rules);
    for (const item of incomplete) pluginApi.log.warn(`Not checked: ${item.kind}${item.name ? ` (${item.name})` : ''}`);
    const dialog = dialogFor(found, tr, incomplete);
    if (!dialog) return undefined;
    if (dialog.kind === 'alert') {
      await pluginApi.ui.alert({ title: dialog.title, message: dialog.message });
      return false;
    }
    const send = await pluginApi.ui.confirm({
      title: dialog.title,
      message: dialog.message,
      confirmLabel: dialog.confirmLabel,
      cancelLabel: dialog.cancelLabel,
      danger: true,
    });
    if (send) return undefined;
    pluginApi.toast.info(tr('warn.cancelled'));
    return false;
  },

  async onBeforeAttachmentUpload(info) {
    if (!pluginApi || !info) return undefined;
    const rules = await currentRules();
    // Without settings Send decides (and stops the message).
    if (!rules) return undefined;
    const problem = uploadProblem(info, rules);
    if (!problem) return undefined;
    const message = problem.kind === 'size'
      ? tr('upload.size', { name: problem.name, max: formatMb(rules.config.maxSizeMb) })
      : problem.kind === 'unreadable'
        ? tr('upload.unreadable', { name: problem.name })
        : tr('upload.type', { name: problem.name, type: problem.type });
    await pluginApi.ui.alert({ title: tr('upload.title'), message });
    return false;
  },
};
