/**
 * Send Later Plugin — UI extension example.
 *
 * Demonstrates:
 * - Registering composer toolbar actions
 * - Registering regular toolbar actions
 * - Registering keyboard shortcuts
 * - Using select-type settings
 * - Using toast for user feedback
 * - Intercepting the send flow with onBeforeEmailSend
 */

const DELAY_LABELS = {
  '30m': '30 minutes',
  '1h': '1 hour',
  '2h': '2 hours',
  '4h': '4 hours',
  'tomorrow-9am': 'Tomorrow at 9:00 AM',
};

function getScheduledTime(delay) {
  const now = new Date();
  switch (delay) {
    case '30m':
      return new Date(now.getTime() + 30 * 60 * 1000);
    case '1h':
      return new Date(now.getTime() + 60 * 60 * 1000);
    case '2h':
      return new Date(now.getTime() + 2 * 60 * 60 * 1000);
    case '4h':
      return new Date(now.getTime() + 4 * 60 * 60 * 1000);
    case 'tomorrow-9am': {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return tomorrow;
    }
    default:
      return new Date(now.getTime() + 60 * 60 * 1000);
  }
}

export function activate(api) {
  const disposables = [];
  const defaultDelay = api.plugin.settings.defaultDelay || '1h';
  const showConfirmation = api.plugin.settings.showConfirmation !== false;

  let scheduledSends = api.storage.get('scheduledCount') || 0;

  function scheduleSend() {
    const scheduledTime = getScheduledTime(defaultDelay);
    const label = DELAY_LABELS[defaultDelay] || defaultDelay;

    scheduledSends++;
    api.storage.set('scheduledCount', scheduledSends);

    api.log.info(`Email scheduled for ${scheduledTime.toISOString()} (${label})`);

    if (showConfirmation) {
      api.toast.success(`Email scheduled — sending in ${label}`);
    }

    // In production, this would use EmailSubmission with a futureRelease date
    // or store the draft and trigger send via onInterval
  }

  // Add "Send Later" button to composer toolbar
  disposables.push(
    api.ui.registerComposerAction({
      id: 'send-later-btn',
      label: `Send Later (${DELAY_LABELS[defaultDelay]})`,
      icon: '⏰',
      onClick: scheduleSend,
      order: 90,
    })
  );

  // Add keyboard shortcut: Ctrl+Shift+L
  disposables.push(
    api.hooks.registerShortcut({
      id: 'send-later-shortcut',
      keys: 'ctrl+shift+l',
      label: 'Send Later',
      category: 'Send Later Plugin',
      handler: scheduleSend,
    })
  );

  // Log when composer opens (for debugging)
  disposables.push(
    api.hooks.onComposerOpen((draft) => {
      api.log.debug('Composer opened, Send Later is available');
    })
  );

  api.log.info(`Send Later plugin activated (default: ${DELAY_LABELS[defaultDelay]})`);

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
    },
  };
}
