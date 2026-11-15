// @vitest-environment jsdom
// The large-file offer when Nextcloud can't be used right now (the sign-in
// expired): Cancel attaches the file as usual instead of dropping it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { setApi } from '../src/lib/host.js';
import { PluginDialog } from '../src/ui/dialog.js';
import manifest from '../manifest.json' with { type: 'json' };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const ORIGIN = 'https://cloud.example';

function expiredApi() {
  return fakeApi({
    translations: manifest.locales,
    handlers: {
      'proxy.accounts': async () => [{ credentialId: 'nextcloud', origin: ORIGIN, username: 'alice', connected: true }],
      'proxy.fetch': async () => proxyResponse('', { status: 401 }),
    },
  });
}

async function renderDialog(view) {
  const api = expiredApi();
  setApi(api);
  const onResult = vi.fn();
  await act(async () => {
    render(React.createElement(PluginDialog, { view, fileId: 'f1', name: 'video.mp4', size: 50 * 1024 * 1024, onResult }));
  });
  await screen.findByText('Sign in again');
  return onResult;
}

describe('the large-file offer without a working connection', () => {
  it('attaches the file as usual on Cancel', async () => {
    const onResult = await renderDialog('offload');
    fireEvent.click(screen.getByText('Cancel'));
    expect(onResult).toHaveBeenCalledWith({ action: 'attach' });
  });

  it('still cancels the other views', async () => {
    const onResult = await renderDialog('picker');
    fireEvent.click(screen.getByText('Cancel'));
    expect(onResult).toHaveBeenCalledWith(null);
  });
});
