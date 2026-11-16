// "Add Jitsi meeting" under the event form's meeting link field: the kit's
// outline button, with its spinner while the link is made. Built from a
// factory so tests can hand in React and a fake api.
//
// The link that goes into the event is the plain room link: the event and
// its invitations reach every attendee. The organizer joins as moderator
// with "Join as moderator", which asks the sidecar for a short-lived token
// for them alone and opens the room in a new tab; that link is never
// stored.

import { Button, Row } from '@plugin-host/ui';
import { isHostedRoom, stripPluginToken, withoutJwt } from './links.js';

export function makeJitsiButton(React, api) {
  const { createElement: h, useEffect, useRef, useState } = React;

  return function JitsiAddButton(props) {
    const [busy, setBusy] = useState(false);
    const [joining, setJoining] = useState(false);
    const eventTitle = props?.eventData?.title || 'meeting';
    const link = String(props?.eventData?.virtualLocation ?? '').trim();
    const setVirtualLocation = props?.setVirtualLocation;
    const cleaned = useRef('');

    // An event made with an earlier version carries the organizer's token in
    // its link. Take it out of the form; saving sends attendees the clean link.
    useEffect(() => {
      if (!link || cleaned.current === link || typeof setVirtualLocation !== 'function') return;
      const clean = stripPluginToken(link);
      if (clean === null) return;
      cleaned.current = link;
      Promise.resolve(setVirtualLocation(clean)).then(
        () => api.toast.info('Removed your Jitsi sign-in from the meeting link. Save the event so attendees get the link without it.'),
        () => {},
      );
    }, [link, setVirtualLocation]);

    async function handleClick() {
      if (busy) return;
      setBusy(true);
      try {
        // api.http.post resolves to { ok, status, data }: the parsed body is in `data`.
        const response = await api.http.post('/api/jitsi', { eventTitle });
        if (!response || !response.ok) {
          throw new Error(response?.data?.error || `HTTP ${response?.status ?? 'error'}`);
        }
        const answer = response.data?.url;
        if (!answer) throw new Error('No url in response');
        // A sidecar older than 1.4.0 still adds the organizer's token.
        const url = withoutJwt(answer);

        if (typeof setVirtualLocation === 'function') {
          // An RPC stub: await it so a host-side error surfaces here.
          await setVirtualLocation(url);
          api.toast.success('Jitsi meeting added to event');
        } else {
          // No host setter: show the URL so the user can still copy it.
          await api.ui.alert({ title: 'Jitsi meeting created', message: url });
        }
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        api.toast.error(`Could not create Jitsi meeting: ${message}`);
      } finally {
        setBusy(false);
      }
    }

    async function handleJoin() {
      if (joining) return;
      setJoining(true);
      try {
        const response = await api.http.post('/api/jitsi', { action: 'join', url: withoutJwt(link) });
        if (!response || !response.ok) {
          throw new Error(response?.data?.error || `HTTP ${response?.status ?? 'error'}`);
        }
        const url = response.data?.url;
        if (!url) throw new Error('No url in response');
        await api.ui.openExternalUrl(url);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        api.toast.error(`Could not join as moderator: ${message}`);
      } finally {
        setJoining(false);
      }
    }

    const add = h(Button, { variant: 'secondary', size: 'sm', icon: 'video', busy, onClick: handleClick }, 'Add Jitsi meeting');
    if (!isHostedRoom(link)) return add;
    return h(Row, null,
      add,
      h(Button, { variant: 'secondary', size: 'sm', icon: 'external-link', busy: joining, onClick: handleJoin }, 'Join as moderator'),
    );
  };
}
