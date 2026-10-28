// "Add Talk meeting" under the event form's meeting link field, once the user
// turns it on in the settings: makes a public Talk conversation named after
// the event and puts its link into the event's meeting link.

import { createElement as h, useState } from 'react';
import { Button } from '@plugin-host/ui';
import { createClient } from '../lib/client.js';
import { getConnection } from '../lib/connection.js';
import { NcError, errorText } from '../lib/errors.js';
import { getApi } from '../lib/host.js';

export function AddTalkMeetingButton({ eventData, setVirtualLocation } = {}) {
  const api = getApi();
  const [busy, setBusy] = useState(false);
  if (!api.plugin.settings?.talkButton) return null;
  const t = (key, vars) => api.i18n.t(key, vars);
  // Never replace a meeting link the event already has.
  const hasLink = !!String(eventData?.virtualLocation ?? '').trim();

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      const conn = await getConnection(api);
      if (!conn) throw new NcError('not_connected');
      const name = String(eventData?.title ?? '').trim() || t('talk.untitled');
      const url = await createClient(api, conn).createTalkRoom(name, String(eventData?.description ?? '').trim());
      if (typeof setVirtualLocation === 'function') {
        // An RPC stub: await it so a host-side error surfaces here.
        await setVirtualLocation(url);
        api.toast.success(t('talk.added'));
      } else {
        await api.ui.alert({ title: t('talk.added'), message: url });
      }
    } catch (err) {
      // Talk answers 404 when the app isn't installed on the server.
      const message = err instanceof NcError && err.code === 'not_found' ? t('talk.unavailable') : errorText(t, err);
      api.toast.error(t('talk.error', { message }));
    } finally {
      setBusy(false);
    }
  }

  return h(Button, { variant: 'secondary', size: 'sm', icon: 'video', busy, disabled: hasLink, onClick: handleClick }, t('talk.add'));
}
