/**
 * Hello World Plugin — the simplest possible Bulwark Mail plugin.
 *
 * Demonstrates:
 * - activate() / deactivate() lifecycle
 * - Logging with api.log
 * - Subscribing to hooks
 * - Using storage
 * - Showing toast notifications
 */

export function activate(api) {
  api.log.info('Hello World plugin activated!');

  // Track how many times the plugin has been loaded
  const count = (api.storage.get('activationCount') || 0) + 1;
  api.storage.set('activationCount', count);

  // Show a welcome toast on first activation
  if (count === 1) {
    api.toast.success('Hello World plugin installed successfully!');
  }

  // Log when the app is fully ready
  const appReady = api.hooks.onAppReady(() => {
    api.log.info('App is ready — Hello World is running');
  });

  // Log when an email is opened
  const emailOpen = api.hooks.onEmailOpen((email) => {
    api.log.info(`Email opened: "${email.subject}" from ${email.from}`);
  });

  // Log new email notifications
  const newEmail = api.hooks.onNewEmailReceived((notification) => {
    api.log.info('New email received:', notification);
  });

  return {
    dispose: () => {
      appReady.dispose();
      emailOpen.dispose();
      newEmail.dispose();
      api.log.info('Hello World plugin deactivated');
    },
  };
}

export function deactivate() {
  // Nothing extra to clean up
}
