// @vitest-environment jsdom
// "Add Talk meeting" in the event form: hidden until the user turns it on,
// makes a public Talk conversation through the proxy and puts its link into
// the event.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { setApi } from '../src/lib/host.js';
import { AddTalkMeetingButton } from '../src/ui/talk-button.js';
import manifest from '../manifest.json' with { type: 'json' };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const ORIGIN = 'https://cloud.example';
const ROOM = '/ocs/v2.php/apps/spreed/api/v4/room';

function makeApi({ enabled = true, connected = true, room = () => proxyResponse(JSON.stringify({ ocs: { data: { token: 'abc123' } } })) } = {}) {
  const api = fakeApi({
    translations: manifest.locales,
    settings: { talkButton: enabled },
    handlers: {
      'config.get': async () => ({}),
      'proxy.accounts': async () => (connected ? [{ credentialId: 'nextcloud', origin: ORIGIN, username: 'alice', connected: true }] : []),
      'proxy.fetch': async (id, url, init) => {
        if (url.includes('/cloud/user')) return proxyResponse(JSON.stringify({ ocs: { data: { id: 'alice' } } }));
        if (url.includes(ROOM)) return room(url, init);
        return proxyResponse('{}');
      },
    },
  });
  setApi(api);
  return api;
}

const roomCalls = (api) => api.calls('proxy.fetch').filter((c) => c.args[1].includes(ROOM));

async function show(props) {
  await act(async () => { render(React.createElement(AddTalkMeetingButton, props)); });
}

async function click() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add Talk meeting' })); });
}

describe('Add Talk meeting', () => {
  it('stays hidden until the user turns it on', async () => {
    makeApi({ enabled: false });
    await show({ eventData: { title: 'Planning' } });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('creates a public conversation named after the event and puts its link into the event', async () => {
    const api = makeApi();
    const setVirtualLocation = vi.fn(async () => {});
    await show({ eventData: { title: 'Planning', description: 'Q4 roadmap', virtualLocation: '' }, setVirtualLocation });
    await click();
    const [call] = roomCalls(api);
    expect(call.args[2].method).toBe('POST');
    expect(JSON.parse(call.args[2].body)).toEqual({ roomType: 3, roomName: 'Planning', description: 'Q4 roadmap' });
    expect(setVirtualLocation).toHaveBeenCalledWith(`${ORIGIN}/call/abc123`);
    expect(api.calls('toast.success')[0].args[0]).toBe('Talk meeting created');
  });

  it('is disabled when the event already has a meeting link', async () => {
    makeApi();
    await show({ eventData: { title: 'Planning', virtualLocation: 'https://meet.example/x' }, setVirtualLocation: vi.fn() });
    expect(screen.getByRole('button', { name: 'Add Talk meeting' }).disabled).toBe(true);
  });

  it('says Nextcloud is not connected instead of calling it', async () => {
    const api = makeApi({ connected: false });
    const setVirtualLocation = vi.fn();
    await show({ eventData: { title: 'Planning' }, setVirtualLocation });
    await click();
    expect(roomCalls(api)).toHaveLength(0);
    expect(setVirtualLocation).not.toHaveBeenCalled();
    expect(api.calls('toast.error')[0].args[0]).toBe("Couldn't create the Talk meeting: Nextcloud is not connected yet.");
  });

  it('says Talk is missing when the server answers 404', async () => {
    const api = makeApi({ room: () => proxyResponse('', { status: 404 }) });
    await show({ eventData: { title: 'Planning' }, setVirtualLocation: vi.fn() });
    await click();
    expect(api.calls('toast.error')[0].args[0]).toBe("Couldn't create the Talk meeting: Nextcloud Talk isn't installed on your Nextcloud server.");
  });

  it('shows the link when the host offers no way to set it', async () => {
    const api = makeApi();
    await show({ eventData: { title: '' } });
    await click();
    expect(JSON.parse(roomCalls(api)[0].args[2].body).roomName).toBe('Meeting');
    expect(api.calls('ui.alert')[0].args[0]).toEqual({ title: 'Talk meeting created', message: `${ORIGIN}/call/abc123` });
  });
});
