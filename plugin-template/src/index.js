/**
 * Bulwark Mail Plugin Template
 *
 * This file demonstrates the full Plugin API.
 * Delete sections you don't need and keep what's relevant to your plugin.
 *
 * IMPORTANT: Do NOT import React — it's provided by the host app via __PLUGIN_EXTERNALS__.
 * Mark react, react-dom, react/jsx-runtime as external in your bundler.
 */

// React is provided by the host app — access lazily to ensure externals are set
function getReact() {
  // eslint-disable-line no-unused-vars
  return globalThis.__PLUGIN_EXTERNALS__?.React;
}

// ─── Activate ───────────────────────────────────────────────
// Called when the plugin is loaded. Return a Disposable to clean up.

export function activate(api) {
  const disposables = [];

  api.log.info("Plugin activated!");

  // ─── Settings ───────────────────────────────────────────
  // Access user-configured settings from manifest.settingsSchema
  const isEnabled = api.plugin.settings.enabled;
  if (!isEnabled) {
    api.log.info("Plugin is disabled by user settings");
    return;
  }

  // ─── Storage ────────────────────────────────────────────
  // Persistent key-value storage scoped to this plugin
  const runCount = (api.storage.get("runCount") || 0) + 1;
  api.storage.set("runCount", runCount);
  api.log.info(`Plugin has been activated ${runCount} time(s)`);

  // ─── Toast notifications ────────────────────────────────
  // api.toast.success('Message');
  // api.toast.error('Message');
  // api.toast.info('Message');
  // api.toast.warning('Message');

  // ─── UI: Toolbar Action ─────────────────────────────────
  // Adds a button to the email toolbar
  // Requires permission: ui:toolbar
  //
  // disposables.push(
  //   api.ui.registerToolbarAction({
  //     id: 'my-action',
  //     label: 'My Action',
  //     icon: '🔧',
  //     onClick: () => api.toast.info('Toolbar button clicked!'),
  //     order: 100,
  //   })
  // );

  // ─── UI: Email Banner ──────────────────────────────────
  // Shows a banner above email content for matching emails
  // Requires permission: ui:email-banner
  //
  // disposables.push(
  //   api.ui.registerEmailBanner({
  //     shouldShow: (email) => email.subject?.includes('[ALERT]'),
  //     render: ({ email }) => getReact().createElement(
  //       'div',
  //       { style: { padding: '8px', background: '#fef3c7', color: '#92400e' } },
  //       '⚠️ This email contains an alert'
  //     ),
  //   })
  // );

  // ─── UI: Email Footer ─────────────────────────────────
  // Adds content below the email body
  // Requires permission: ui:email-footer
  //
  // disposables.push(
  //   api.ui.registerEmailFooter(() =>
  //     getReact().createElement('div', { style: { padding: '8px' } }, 'Plugin footer')
  //   )
  // );

  // ─── UI: Composer Action ──────────────────────────────
  // Adds a button to the email composer toolbar
  // Requires permission: ui:composer-toolbar
  //
  // disposables.push(
  //   api.ui.registerComposerAction({
  //     id: 'my-composer-btn',
  //     label: 'Insert Snippet',
  //     icon: '📝',
  //     onClick: () => api.toast.info('Composer action clicked!'),
  //   })
  // );

  // ─── UI: Sidebar Widget ───────────────────────────────
  // Adds a widget panel in the sidebar
  // Requires permission: ui:sidebar-widget
  //
  // disposables.push(
  //   api.ui.registerSidebarWidget({
  //     id: 'my-widget',
  //     label: 'My Widget',
  //     render: () => getReact().createElement('div', null, 'Widget content'),
  //     order: 50,
  //   })
  // );

  // ─── UI: Settings Section ─────────────────────────────
  // Adds a section in the Settings page
  // Requires permission: ui:settings-section
  //
  // disposables.push(
  //   api.ui.registerSettingsSection({
  //     id: 'my-settings',
  //     label: 'My Plugin',
  //     icon: '⚙️',
  //     render: () => getReact().createElement('div', null, 'Plugin settings UI'),
  //   })
  // );

  // ─── UI: Context Menu Item ────────────────────────────
  // Adds an item to the email right-click menu
  // Requires permission: ui:context-menu
  //
  // disposables.push(
  //   api.ui.registerContextMenuItem({
  //     id: 'my-context-action',
  //     label: 'Process with Plugin',
  //     icon: '⚡',
  //     onClick: (emailIds) => {
  //       api.log.info('Context menu clicked for:', emailIds);
  //     },
  //   })
  // );

  // ─── UI: Navigation Rail Item ─────────────────────────
  // Adds an item at the bottom of the navigation rail
  // Requires permission: ui:navigation-rail
  //
  // disposables.push(
  //   api.ui.registerNavigationRailItem(() =>
  //     getReact().createElement('button', { onClick: () => api.toast.info('Nav clicked') }, '🔌')
  //   )
  // );

  // ─── Hooks: Email ─────────────────────────────────────
  // Requires permission: email:read or email:write or email:send

  disposables.push(
    api.hooks.onEmailOpen((email) => {
      api.log.info("Email opened:", email.subject);
    }),
  );

  // disposables.push(api.hooks.onEmailClose(() => { ... }));
  // disposables.push(api.hooks.onComposerOpen((draft) => { ... }));
  // disposables.push(api.hooks.onBeforeEmailSend((draft) => { ... }));
  // disposables.push(api.hooks.onAfterEmailSend((email) => { ... }));
  // disposables.push(api.hooks.onNewEmailReceived((notification) => { ... }));
  // disposables.push(api.hooks.onMailboxChange((mailbox) => { ... }));
  // disposables.push(api.hooks.onSearch((filters) => { ... }));
  // disposables.push(api.hooks.onEmailSelectionChange((ids) => { ... }));

  // ─── Hooks: Calendar ──────────────────────────────────
  // Requires permission: calendar:read or calendar:write

  // disposables.push(api.hooks.onCalendarEventOpen((event) => { ... }));
  // disposables.push(api.hooks.onAfterEventCreate((event) => { ... }));
  // disposables.push(api.hooks.onCalendarAlert((alert) => { ... }));

  // ─── Hooks: Contacts ──────────────────────────────────
  // Requires permission: contacts:read or contacts:write

  // disposables.push(api.hooks.onContactOpen((contact) => { ... }));
  // disposables.push(api.hooks.onAfterContactCreate((contact) => { ... }));

  // ─── Hooks: Files ─────────────────────────────────────
  // Requires permission: files:read or files:write

  // disposables.push(api.hooks.onAfterFileUpload((file) => { ... }));
  // disposables.push(api.hooks.onFileDownload((file) => { ... }));

  // ─── Hooks: App Lifecycle ─────────────────────────────
  // Permission: app:lifecycle (implicit, always granted)

  disposables.push(
    api.hooks.onAppReady(() => {
      api.log.info("App is ready!");
    }),
  );

  // Periodic callback (minimum 60 seconds)
  // disposables.push(
  //   api.hooks.onInterval(() => {
  //     api.log.debug('Periodic check...');
  //   }, 120000) // every 2 minutes
  // );

  // disposables.push(api.hooks.onVisibilityChange((visible) => { ... }));

  // ─── Hooks: Theme ─────────────────────────────────────
  // Permission: ui:observe (implicit)

  // disposables.push(api.hooks.onThemeChange((theme) => { ... }));

  // ─── Hooks: Keyboard Shortcuts ────────────────────────
  // Requires permission: ui:keyboard
  //
  // disposables.push(
  //   api.hooks.registerShortcut({
  //     id: 'my-shortcut',
  //     keys: 'ctrl+shift+p',
  //     label: 'My Plugin Action',
  //     category: 'My Plugin',
  //     handler: () => api.toast.info('Shortcut triggered!'),
  //   })
  // );

  // ─── Return disposable ───────────────────────────────
  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      api.log.info("Plugin deactivated");
    },
  };
}

// ─── Deactivate (optional) ──────────────────────────────────
// Called when the plugin is uninstalled or disabled.
// Use for any cleanup not covered by disposables.

export function deactivate() {
  // Extra cleanup if needed
}
