/**
 * Bulwark Mail Plugin Template — sandboxed contract.
 *
 * Plugins now export three top-level fields:
 *
 *   slots:    { [SlotName]: { component, shouldShow?, order? } }
 *             React components rendered inside their own opaque-origin
 *             iframe. The component receives whatever the host slot
 *             provides as `extraProps`. The slot iframe is a pure
 *             renderer — it cannot reach api.storage / api.http /
 *             api.plugin.settings.
 *
 *   hooks:    { [HookName]: handler }
 *             Handlers dispatched into the background iframe via
 *             postMessage RPC. Handlers may return a Promise. NO DOM
 *             access from hooks — the background iframe is hidden.
 *
 *   activate(api): one-shot side effects (storage init, http calls).
 *             Runs once in the background iframe. Should NOT register
 *             hooks here — use the `hooks` export instead.
 *
 * Async API surface:
 *   - api.storage.get/set/remove/keys     → returns a Promise
 *   - api.http.post/fetch                  → returns a Promise
 *   - api.admin.getConfig/setConfig/etc.   → returns a Promise
 *   - api.ui.confirm/alert/openExternalUrl → returns a Promise
 *   - api.toast.success/info/warning/error → fire-and-forget
 *   - api.log.*                             → local console
 *
 * IMPORTANT:
 *   - Do NOT import React via globalThis.__PLUGIN_EXTERNALS__ (that hook
 *     is gone). Use `const React = require('react')` instead; the
 *     bundler will mark it external and the host injects React at
 *     evaluation time.
 *   - Hooks are dispose-managed by the host. Don't try to capture
 *     "Disposable" return values — there aren't any.
 *   - The slot iframe and background iframe are separate. State you
 *     mutate in one is not visible in the other.
 */

const { createElement: h, useState } = require('react');

// ─── Slot component example ─────────────────────────────────

function MyWidget(props) {
  const [count, setCount] = useState(0);
  return h(
    'div',
    { style: { padding: '12px', fontSize: '13px' } },
    h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, 'My Plugin'),
    h(
      'button',
      {
        type: 'button',
        onClick: () => setCount((c) => c + 1),
        style: {
          font: 'inherit',
          padding: '6px 10px',
          borderRadius: '6px',
          border: '1px solid #cbd5e1',
          background: '#f8fafc',
          cursor: 'pointer',
        },
      },
      `Clicked ${count} times`,
    ),
    props?.email
      ? h(
          'div',
          { style: { marginTop: '8px', color: '#64748b' } },
          `Current email: ${props.email.subject || '(no subject)'}`,
        )
      : null,
  );
}

export const slots = {
  // Pick a slot name from SlotName in lib/plugin-types.ts:
  //   toolbar-actions, app-top-banner, email-banner, email-footer,
  //   composer-toolbar, composer-sidebar, composer-sidebar-right,
  //   sidebar-widget, email-detail-sidebar, settings-section,
  //   context-menu-email, navigation-rail-bottom,
  //   calendar-event-actions, admin-plugin-page
  'sidebar-widget': {
    component: MyWidget,
    // shouldShow runs in the BACKGROUND iframe with the host's extraProps.
    // Return false to skip mounting the slot iframe entirely.
    shouldShow: () => true,
    order: 100,
  },
};

// ─── Hooks ──────────────────────────────────────────────────

export const hooks = {
  onAppReady() {
    console.info('[my-plugin] App is ready');
  },

  onEmailOpen(email) {
    console.info('[my-plugin] Email opened:', email?.subject);
  },

  // Intercept hooks may return a Promise. Return `false` to cancel.
  // async onBeforeEmailSend(draft) {
  //   const ok = await api.ui.confirm({ title: 'Send?', message: '...' });
  //   return ok ? undefined : false;
  // },
};

// ─── Activate (one-shot init) ───────────────────────────────

export async function activate(api) {
  if (api.plugin.settings.enabled === false) {
    api.log.info('Plugin disabled by user settings');
    return;
  }

  const runCount = Number((await api.storage.get('runCount')) || 0) + 1;
  await api.storage.set('runCount', runCount);
  api.log.info(`Plugin activated (run ${runCount})`);
}
