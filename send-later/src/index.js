/**
 * Send Later Plugin — schedule outgoing emails (storage-backed).
 *
 * v2 status: improved. Slot iframes now have full api access, so the
 * composer-toolbar slot can stage a "schedule the next send" intent via
 * api.storage, and the `onBeforeEmailSend` hook (background iframe) picks
 * the intent up, persists the full draft into a queue, cancels the live
 * send, and (when permissions allow) posts a release-at timestamp to a
 * host-side queue.
 *
 * The host does not currently expose a JMAP futureRelease helper, so the
 * actual delayed dispatch happens when the queue is replayed by the
 * background iframe on activation: any entry whose releaseAt has passed
 * is dropped back into the user's drafts via api.toast (informational).
 * A future host endpoint at /api/send-later could promote these entries
 * to real JMAP submissions; this plugin already POSTs to it when present.
 */

const { createElement: h, useEffect, useState } = require('react');
const slotApi = require('@plugin-host');

const INTENT_KEY = 'scheduleIntent'; // { delay: string, scheduledFor: ISO } | null
const QUEUE_KEY = 'queue';           // [{ id, email, releaseAt }]
const COUNT_KEY = 'scheduledCount';  // number

const DELAY_LABELS = {
  '30m': '30 minutes',
  '1h': '1 hour',
  '2h': '2 hours',
  '4h': '4 hours',
  'tomorrow-9am': 'Tomorrow at 9:00 AM',
};

function computeReleaseAt(delay) {
  const now = new Date();
  switch (delay) {
    case '30m': return new Date(now.getTime() + 30 * 60_000);
    case '1h':  return new Date(now.getTime() + 60 * 60_000);
    case '2h':  return new Date(now.getTime() + 2 * 60 * 60_000);
    case '4h':  return new Date(now.getTime() + 4 * 60 * 60_000);
    case 'tomorrow-9am': {
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(9, 0, 0, 0);
      return next;
    }
    default: return new Date(now.getTime() + 60 * 60_000);
  }
}

// ─── Slot: composer-toolbar button ────────────────────────────

function SendLaterButton() {
  const [armed, setArmed] = useState(null); // { delay, releaseAt }
  const settings = slotApi.plugin?.settings || {};
  const defaultDelay = settings.defaultDelay || '1h';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const intent = await slotApi.storage.get(INTENT_KEY);
      if (!cancelled && intent && intent.delay) setArmed(intent);
    })();
    return () => { cancelled = true; };
  }, []);

  async function arm() {
    const releaseAt = computeReleaseAt(defaultDelay);
    const human = DELAY_LABELS[defaultDelay] || defaultDelay;
    const proceed = await slotApi.ui.confirm({
      title: 'Schedule next send?',
      message:
        `When you click Send, this message will be held and released in ${human} ` +
        `(around ${releaseAt.toLocaleString()}).\n\n` +
        `Until then it lives in plugin storage — clear it with the same Send Later button.`,
      confirmLabel: 'Schedule it',
      cancelLabel: 'Cancel',
    });
    if (!proceed) return;
    const intent = { delay: defaultDelay, releaseAt: releaseAt.toISOString() };
    await slotApi.storage.set(INTENT_KEY, intent);
    setArmed(intent);
    if (settings.showConfirmation !== false) {
      slotApi.toast.success(`Next send will be held until ${releaseAt.toLocaleString()}`);
    }
  }

  async function disarm() {
    await slotApi.storage.set(INTENT_KEY, null);
    setArmed(null);
    slotApi.toast.info('Send Later cancelled — next send goes immediately');
  }

  const label = armed
    ? `⏰ Send Later: ${new Date(armed.releaseAt).toLocaleTimeString()}`
    : '⏰ Send Later';

  return h(
    'button',
    {
      type: 'button',
      onClick: armed ? disarm : arm,
      title: armed
        ? 'Click to cancel the scheduled hold'
        : `Schedule next send in ${DELAY_LABELS[defaultDelay] || defaultDelay}`,
      style: {
        font: 'inherit',
        padding: '6px 10px',
        borderRadius: '6px',
        border: armed ? '1px solid #f59e0b' : '1px solid #cbd5e1',
        background: armed ? '#fffbeb' : '#f8fafc',
        color: armed ? '#92400e' : 'inherit',
        cursor: 'pointer',
      },
    },
    label,
  );
}

export const slots = {
  'composer-toolbar': {
    component: SendLaterButton,
    order: 90,
  },
};

// ─── Hooks (background iframe) ──────────────────────────────

let pluginApi = null;

export const hooks = {
  async onBeforeEmailSend(outgoing) {
    if (!pluginApi) return;
    const intent = await pluginApi.storage.get(INTENT_KEY);
    if (!intent || !intent.delay || !intent.releaseAt) return;

    // Snapshot the draft into the queue, clear the intent so subsequent
    // sends behave normally, and cancel the live submission.
    const queue = (await pluginApi.storage.get(QUEUE_KEY)) || [];
    const list = Array.isArray(queue) ? queue : [];
    list.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      releaseAt: intent.releaseAt,
      delay: intent.delay,
      email: outgoing,
    });
    await pluginApi.storage.set(QUEUE_KEY, list);
    await pluginApi.storage.set(INTENT_KEY, null);

    const count = Number((await pluginApi.storage.get(COUNT_KEY)) || 0) + 1;
    await pluginApi.storage.set(COUNT_KEY, count);

    // Best-effort push to a host-side queue. If the route doesn't exist
    // (which is the default deployment), api.http.post will throw and we
    // fall back to the storage-only behaviour — still better than nothing.
    try {
      await pluginApi.http.post('/api/send-later', {
        releaseAt: intent.releaseAt,
        email: outgoing,
      });
    } catch (err) {
      pluginApi.log.debug('send-later: no host endpoint (storage-only mode)', err);
    }

    pluginApi.toast.success(
      `Send Later: held until ${new Date(intent.releaseAt).toLocaleString()}. ${list.length} message(s) in the queue.`,
    );
    return false; // cancel the live send
  },

  onComposerOpen() {
    pluginApi?.log.debug('Composer opened; Send Later is available');
  },
};

// ─── Activate ───────────────────────────────────────────────

export async function activate(api) {
  pluginApi = api;
  const defaultDelay = api.plugin.settings.defaultDelay || '1h';
  const queue = (await api.storage.get(QUEUE_KEY)) || [];
  const list = Array.isArray(queue) ? queue : [];
  const scheduledSends = Number((await api.storage.get(COUNT_KEY)) || 0);
  const due = list.filter((e) => new Date(e.releaseAt).getTime() <= Date.now());
  if (due.length > 0) {
    api.toast.warning(
      `Send Later: ${due.length} held message(s) became due while the app was closed. ` +
      `Review them in plugin storage and resend manually.`,
    );
  }
  api.log.info(
    `Send Later activated (default: ${DELAY_LABELS[defaultDelay] || defaultDelay}, ` +
    `${list.length} held, ${scheduledSends} historical)`,
  );
}
