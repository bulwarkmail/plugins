// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { makeJitsiButton } from '../src/lib/button.js';

afterEach(cleanup);

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeToken = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`;

describe('Add Jitsi meeting', () => {
  it('is the kit outline button and puts the new link into the event form', async () => {
    let resolve;
    const api = fakeApi({ handlers: { 'http.post': () => new Promise((r) => { resolve = r; }) } });
    const setVirtualLocation = vi.fn(async () => {});
    const Btn = makeJitsiButton(React, api);
    render(React.createElement(Btn, { eventData: { title: 'Planning' }, setVirtualLocation }));
    const button = screen.getByRole('button', { name: 'Add Jitsi meeting' });
    expect(button.getAttribute('data-variant')).toBe('secondary');
    expect(button.querySelector('[data-icon="video"]')).toBeTruthy();
    expect(button.getAttribute('style')).toBeNull();

    fireEvent.click(button);
    // Busy while the sidecar answers: the kit shows its spinner and disables it.
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => { resolve({ ok: true, status: 200, data: { url: 'https://meet.example/abc' } }); });

    expect(api.calls('http.post')[0].args).toEqual(['/api/jitsi', { eventTitle: 'Planning' }]);
    expect(setVirtualLocation).toHaveBeenCalledWith('https://meet.example/abc');
    expect(button.disabled).toBe(false);
  });

  it('never puts a token into the event, even when an old sidecar sends one', async () => {
    const token = fakeToken({ iss: 'bulwark-webmail', aud: 'jitsi' });
    const api = fakeApi({ handlers: { 'http.post': async () => ({ ok: true, status: 200, data: { url: `https://meet.example/abc?jwt=${token}` } }) } });
    const setVirtualLocation = vi.fn(async () => {});
    const Btn = makeJitsiButton(React, api);
    render(React.createElement(Btn, { eventData: { title: 'Planning' }, setVirtualLocation }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add Jitsi meeting' })); });
    expect(setVirtualLocation).toHaveBeenCalledWith('https://meet.example/abc');
  });

  it('takes the token an earlier version put into the event out of the link', async () => {
    const token = fakeToken({ iss: 'bulwark-webmail', aud: 'jitsi', room: 'planning-1a2b3c4d' });
    const api = fakeApi();
    const setVirtualLocation = vi.fn(async () => true);
    const Btn = makeJitsiButton(React, api);
    await act(async () => {
      render(React.createElement(Btn, { eventData: { title: 'Planning', virtualLocation: `https://meet.example/planning-1a2b3c4d?jwt=${token}` }, setVirtualLocation }));
    });
    expect(setVirtualLocation).toHaveBeenCalledWith('https://meet.example/planning-1a2b3c4d');
    expect(api.calls('toast.info')).toHaveLength(1);
  });

  it("leaves another service's link alone", async () => {
    const api = fakeApi();
    const setVirtualLocation = vi.fn(async () => true);
    const Btn = makeJitsiButton(React, api);
    const link = `https://video.example/room?jwt=${fakeToken({ iss: 'someone-else' })}`;
    await act(async () => { render(React.createElement(Btn, { eventData: { virtualLocation: link }, setVirtualLocation })); });
    expect(setVirtualLocation).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Join as moderator' })).toBeNull();
  });

  it('joins as moderator in a new tab without writing that link into the event', async () => {
    const room = 'https://meet.example/planning-1a2b3c4d-0123456789abcdef';
    const api = fakeApi({ handlers: { 'http.post': async () => ({ ok: true, status: 200, data: { url: `${room}?jwt=host-token` } }) } });
    const setVirtualLocation = vi.fn(async () => true);
    const Btn = makeJitsiButton(React, api);
    render(React.createElement(Btn, { eventData: { title: 'Planning', virtualLocation: room }, setVirtualLocation }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Join as moderator' })); });
    expect(api.calls('http.post')[0].args).toEqual(['/api/jitsi', { action: 'join', url: room }]);
    expect(api.calls('ui.openExternalUrl')[0].args).toEqual([`${room}?jwt=host-token`]);
    expect(setVirtualLocation).not.toHaveBeenCalled();
  });

  it('reports a sidecar error as a toast', async () => {
    const api = fakeApi({ handlers: { 'http.post': async () => ({ ok: false, status: 401, data: { error: 'no token' } }) } });
    const Btn = makeJitsiButton(React, api);
    render(React.createElement(Btn, { setVirtualLocation: vi.fn() }));
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(api.calls('toast.error')[0].args[0]).toBe('Could not create Jitsi meeting: no token');
  });
});
