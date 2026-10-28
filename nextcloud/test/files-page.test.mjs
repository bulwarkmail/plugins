// @vitest-environment jsdom
// The Nextcloud page: an empty state with Connect before connecting, then
// the Files app layout (toolbar with the path and actions, file rows).
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { setApi } from '../src/lib/host.js';
import { FilesPage } from '../src/ui/files-page.js';
import manifest from '../manifest.json' with { type: 'json' };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const ORIGIN = 'http://localhost:18080';
const LISTING = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>/remote.php/dav/files/alice/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/alice/Documents/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Tue, 13 Oct 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/alice/notes.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>2048</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype><d:getlastmodified>Tue, 13 Oct 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

function makeApi({ connected, onPut }) {
  const api = fakeApi({
    translations: manifest.locales,
    handlers: {
      'config.get': async () => ({ serverUrl: ORIGIN }),
      'proxy.accounts': async () => (connected ? [{ credentialId: 'nextcloud', origin: ORIGIN, username: 'alice', connected: true }] : []),
      'proxy.fetch': async (id, url, init) => {
        if (url.includes('/cloud/user')) return proxyResponse(JSON.stringify({ ocs: { data: { id: 'alice', displayname: 'Alice Example' } } }));
        if (init?.method === 'PROPFIND') return proxyResponse(LISTING, { status: 207 });
        if (init?.method === 'PUT' && onPut) return onPut(url, init);
        return proxyResponse('{}');
      },
    },
  });
  setApi(api);
  return api;
}

describe('the Nextcloud page', () => {
  it('offers to connect in an empty state before connecting', async () => {
    makeApi({ connected: false });
    await act(async () => { render(React.createElement(FilesPage)); });
    await screen.findByText("Nextcloud isn't connected");
    expect(screen.getByText(/Server: localhost:18080/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Nextcloud' })).toBeTruthy();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('shows the folder like the Files app, with the account and the selection actions', async () => {
    makeApi({ connected: true });
    await act(async () => { render(React.createElement(FilesPage)); });
    const toolbar = await screen.findByRole('toolbar');
    await screen.findByText('notes.txt');
    expect(within(toolbar).getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    expect(within(toolbar).getByRole('searchbox', { name: 'Search' })).toBeTruthy();
    for (const name of ['Upload', 'New folder', 'Refresh', 'Alice Example (alice)']) {
      expect(within(toolbar).getByRole('button', { name }), name).toBeTruthy();
    }
    const rows = within(screen.getByRole('list', { name: 'Folder path' })).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Documents—'), expect.stringContaining('notes.txt2 KB')]);

    fireEvent.click(rows[1]);
    const selection = screen.getByRole('toolbar');
    for (const name of ['Clear selection', 'Download', 'Share link', 'Attach to new message', 'Open in Nextcloud']) {
      expect(within(selection).getByRole('button', { name }), name).toBeTruthy();
    }
  });
});


describe('multi-file uploads', () => {
  function deferredUploads() {
    const started = [];
    const api = makeApi({
      connected: true,
      onPut: (url) => new Promise((resolve) => { started.push({ url, resolve }); }),
    });
    return { api, started };
  }

  async function selectFiles(...names) {
    await act(async () => { render(React.createElement(FilesPage)); });
    await screen.findByText('notes.txt');
    const files = names.map((name) => new File([name], name, { type: 'application/octet-stream' }));
    await act(async () => {
      fireEvent.change(screen.getByTestId('nc-upload-input'), { target: { files } });
    });
  }

  it('uploads multiple selected files one at a time, without dropping any', async () => {
    const { started } = deferredUploads();
    await selectFiles('one.json', 'two.asc', 'three.txt');

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0].url).toContain('/one.json');
    await act(async () => { started[0].resolve(proxyResponse('', { status: 201 })); });

    await waitFor(() => expect(started).toHaveLength(2));
    expect(started[1].url).toContain('/two.asc');
    await act(async () => { started[1].resolve(proxyResponse('', { status: 201 })); });

    await waitFor(() => expect(started).toHaveLength(3));
    expect(started[2].url).toContain('/three.txt');
    await act(async () => { started[2].resolve(proxyResponse('', { status: 201 })); });

    await waitFor(() => expect(screen.getAllByText('Uploaded')).toHaveLength(3));
  });

  it('can cancel a queued upload and resume it later', async () => {
    const { started } = deferredUploads();
    await selectFiles('first.json', 'second.asc');

    await waitFor(() => expect(started).toHaveLength(1));
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButtons[1]);
    await screen.findByText('Paused');

    await act(async () => { started[0].resolve(proxyResponse('', { status: 201 })); });
    expect(started).toHaveLength(1); // The cancelled upload is not started.

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(started).toHaveLength(2));
    expect(started[1].url).toContain('/second.asc');
    await act(async () => { started[1].resolve(proxyResponse('', { status: 201 })); });
    await waitFor(() => expect(screen.getAllByText('Uploaded')).toHaveLength(2));
  });
});
