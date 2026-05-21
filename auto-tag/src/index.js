/**
 * Auto Tag Plugin — automatically tags incoming emails based on rules.
 *
 * Demonstrates:
 *   - `hooks` export with onNewEmailReceived (runs in the background iframe)
 *   - `activate(api)` for one-shot init (load lifetime counter from storage)
 *   - Async storage (`await api.storage.get/set`)
 *
 * Rules are derived from per-user settings. Note: the manifest also declares
 * `email:write` for forwards compatibility — actual keyword application would
 * require a JMAP write call, which the current API surface does not yet
 * expose. This plugin tracks matches and logs them.
 */

let rules = [];
let totalTagged = 0;
let pluginApi = null;

function buildRules(settings) {
  const out = [];

  if (settings.tagNewsletter !== false) {
    out.push({
      name: 'Newsletter',
      keyword: '$newsletter',
      check: (email) => {
        const from = (email.from || '').toLowerCase();
        const subject = (email.subject || '').toLowerCase();
        return (
          from.includes('newsletter') ||
          from.includes('noreply') ||
          from.includes('no-reply') ||
          subject.includes('unsubscribe') ||
          subject.includes('weekly digest') ||
          subject.includes('monthly update')
        );
      },
    });
  }

  if (settings.tagInvoice !== false) {
    out.push({
      name: 'Invoice',
      keyword: '$invoice',
      check: (email) => {
        const subject = (email.subject || '').toLowerCase();
        return (
          subject.includes('invoice') ||
          subject.includes('receipt') ||
          subject.includes('payment confirmation') ||
          subject.includes('order confirmation') ||
          subject.includes('billing statement')
        );
      },
    });
  }

  if (settings.tagGithub !== false) {
    out.push({
      name: 'GitHub',
      keyword: '$github',
      check: (email) => {
        const from = (email.from || '').toLowerCase();
        return (
          from.includes('notifications@github.com') ||
          from.includes('noreply@github.com')
        );
      },
    });
  }

  return out;
}

export async function activate(api) {
  pluginApi = api;
  rules = buildRules(api.plugin.settings || {});
  totalTagged = Number((await api.storage.get('totalTagged')) || 0);

  if (rules.length === 0) {
    api.log.info('Auto Tag: no rules enabled');
    return;
  }
  api.log.info(`Auto Tag: ${rules.length} rule(s) active, ${totalTagged} previous match(es)`);
}

export const hooks = {
  async onNewEmailReceived(notification) {
    if (!pluginApi || rules.length === 0) return;
    for (const rule of rules) {
      if (rule.check(notification)) {
        pluginApi.log.info(`Auto Tag: "${notification.subject}" matched rule "${rule.name}"`);
        totalTagged++;
        // Fire-and-forget; we don't block the hook on persistence.
        void pluginApi.storage.set('totalTagged', totalTagged);
        // Note: actual keyword application would require JMAP write access.
        break; // Apply first matching rule only.
      }
    }
  },
};
