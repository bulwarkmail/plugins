/**
 * Jitsi Meet Plugin — adds "Add Jitsi Meeting" to calendar events.
 *
 * v2 status: improved. The calendar-event-actions slot now receives
 * `setVirtualLocation` as an RPC callback prop (the host marshals function-
 * valued extraProps for us). Slot iframes also have full api access, so
 * we generate the meeting URL via api.http.post('/api/jitsi') with proper
 * auth headers and surface success/error via api.toast. The clipboard
 * fallback that v1 needed is gone — the URL flows straight into the event
 * form's virtual-location field.
 */

const { createElement: h, useState } = require('react');
const slotApi = require('@plugin-host');

function JitsiAddButton(props) {
  const [busy, setBusy] = useState(false);
  const eventTitle = props?.eventData?.title || 'meeting';
  const setVirtualLocation = props?.setVirtualLocation;

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      const data = await slotApi.http.post('/api/jitsi', { eventTitle });
      const url = data?.url;
      if (!url) throw new Error('No url in response');

      if (typeof setVirtualLocation === 'function') {
        // setVirtualLocation arrives as an RPC stub — it's async even though
        // the host treats the local React setter as sync. await it so any
        // host-side error surfaces here.
        await setVirtualLocation(url);
        slotApi.toast.success('Jitsi meeting added to event');
      } else {
        // No host setter available (e.g. host changed extraProps); show the
        // URL so the user can still copy it manually.
        await slotApi.ui.alert({
          title: 'Jitsi meeting created',
          message: url,
        });
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      slotApi.toast.error(`Could not create Jitsi meeting: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  return h(
    'button',
    {
      type: 'button',
      onClick: handleClick,
      disabled: busy,
      style: {
        font: 'inherit',
        padding: '6px 10px',
        borderRadius: '6px',
        border: '1px solid #cbd5e1',
        background: '#f8fafc',
        cursor: busy ? 'progress' : 'pointer',
      },
    },
    busy ? 'Generating…' : '📹 Add Jitsi Meeting',
  );
}

export const slots = {
  'calendar-event-actions': {
    component: JitsiAddButton,
    order: 10,
  },
};

export async function activate(api) {
  api.log.info('Jitsi Meet plugin activated');
}
