import { createElement as h, useState } from 'react';
import { Button } from '@plugin-host/ui';
import { createClient } from '../lib/client';
import { getConnection } from '../lib/connection';
import { getApi } from '../lib/host';

export function AddTalkMeetingButton(props) {
    // props contains eventData object {start, end, title, description, isAllDay, location, virtualLocation}
    const [busy, setBusy] = useState(false);
    const eventTitle = props?.eventData?.title || 'meeting';
    const eventDescription = props?.eventData?.description || '';
    const setVirtualLocation = props?.setVirtualLocation;
    const api = getApi()
    const t = api.i18n.t;
    const enabled = api.plugin.settings.enableTalkMeetingsButton

    if (!enabled) {
        return null
    }

    let client
    getConnection(api).then(connection => {
        client = createClient(api, connection)
    })

    const virtualLocationSet = props.virtualLocation != null && props.virtualLocation != ""

    async function handleClick() {
        if (busy) return;
        setBusy(true);
        try {
            const roomUrl = await client.createTalkRoom(eventTitle, eventDescription)

            if (typeof setVirtualLocation === 'function') {
                await setVirtualLocation(roomUrl);
                api.toast.success(t('talkMeeting.added'));
            } else {
                await api.ui.alert({ title: t('talkMeeting.added'), message: url });
            }
        } catch (err) {
            console.error("Error creating talk meeting", err)
            const message = err && err.message ? err.message : String(err);
            api.toast.error(t('talkMeeting.error', { message }));
        } finally {
            setBusy(false);
        }
    }

    return h(Button, { variant: 'secondary', size: 'sm', icon: 'video', busy, onClick: handleClick, disabled: virtualLocationSet }, t('talkMeeting.add'));
}