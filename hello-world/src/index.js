/**
 * Hello World Plugin — minimal example using the sandboxed plugin contract.
 *
 * Plugins now export three top-level fields:
 *   - `slots`:   { [SlotName]: { component, shouldShow?, order? } } — React components
 *                rendered inside the plugin's own slot iframe.
 *   - `hooks`:   { [HookName]: handler } — handlers dispatched into the
 *                background iframe via postMessage RPC.
 *   - `activate(api)` — one-shot side effects (storage init, http calls,
 *                       timers). Runs once in the background iframe.
 *
 * `api.storage`, `api.http`, `api.admin` and `api.toast` are async because
 * every call crosses the postMessage boundary. `api.log` is local.
 */

export async function activate(api) {
  api.log.info('Hello World plugin activated!');

  const previous = (await api.storage.get('activationCount')) || 0;
  const next = previous + 1;
  await api.storage.set('activationCount', next);

  if (next === 1) {
    api.toast.success('Hello World plugin installed successfully!');
  }
}

export const hooks = {
  onAppReady() {
    console.info('[hello-world] App is ready');
  },
  onEmailOpen(email) {
    console.info('[hello-world] Email opened:', email?.subject, 'from', email?.from?.[0]?.email);
  },
  onNewEmailReceived(notification) {
    console.info('[hello-world] New email received:', notification);
  },
};
