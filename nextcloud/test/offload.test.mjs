import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { offerLargeUpload, hooks, activate } from '../src/index.js';
import { offloadFile } from '../src/ui/offload-dialog.js';
import { planUpload } from '../src/lib/save.js';
import manifest from '../manifest.json' with { type: 'json' };

const MB = 1024 * 1024;
const connected = async () => [{ credentialId: 'nextcloud', origin: 'https://c.example', connected: true }];

function apiWith({ size, settings = {}, result, accounts = connected }) {
  return fakeApi({
    settings: { offerLargeUpload: true, largeFileMb: 10, ...settings },
    translations: manifest.locales,
    handlers: {
      'proxy.accounts': accounts,
      'upfiles.get': async () => ({ name: 'video.mp4', size, type: 'video/mp4' }),
      'ui.openDialog': async () => result,
    },
  });
}

describe('the large-file offer', () => {
  it('stays out of the way for small files', async () => {
    const api = apiWith({ size: 9 * MB });
    expect(await offerLargeUpload(api, 'f1')).toBeUndefined();
    expect(api.calls('ui.openDialog')).toHaveLength(0);
  });

  it('asks for files from the threshold on and passes the link back to the composer', async () => {
    const api = apiWith({ size: 10 * MB, result: { externalAttachment: true, html: '<p>L</p>', text: 'L', path: '/x' } });
    expect(await offerLargeUpload(api, 'f1')).toEqual({ externalAttachment: true, html: '<p>L</p>', text: 'L', fileId: 'f1' });
    expect(api.calls('ui.openDialog')[0].args[0]).toMatchObject({ slot: 'plugin-dialog', extraProps: { view: 'offload', fileId: 'f1', name: 'video.mp4', size: 10 * MB } });
  });

  it('attaches as usual when the user says so', async () => {
    expect(await offerLargeUpload(apiWith({ size: 50 * MB, result: { action: 'attach' } }), 'f1')).toBeUndefined();
  });

  it('drops the file when the dialog is closed', async () => {
    const dropped = { externalAttachment: true, html: '', text: '', fileId: 'f1' };
    expect(await offerLargeUpload(apiWith({ size: 50 * MB, result: null }), 'f1')).toEqual(dropped);
    expect(await offerLargeUpload(apiWith({ size: 50 * MB, result: undefined }), 'f1')).toEqual(dropped);
  });

  it('respects the settings and needs a connected account', async () => {
    const off = apiWith({ size: 50 * MB, settings: { offerLargeUpload: false }, result: { externalAttachment: true, html: 'h', text: 't' } });
    expect(await offerLargeUpload(off, 'f1')).toBeUndefined();
    expect(off.calls('ui.openDialog')).toHaveLength(0);
    expect(await offerLargeUpload(apiWith({ size: 15 * MB, settings: { largeFileMb: 20 } }), 'f1')).toBeUndefined();
    const notConnected = apiWith({ size: 50 * MB, accounts: async () => [] });
    expect(await offerLargeUpload(notConnected, 'f1')).toBeUndefined();
    expect(notConnected.calls('upfiles.get')).toHaveLength(0);
  });

  it('is the onBeforeBlobUpload hook', async () => {
    const api = apiWith({ size: 50 * MB, result: { externalAttachment: true, html: 'h', text: 't' } });
    await activate(api);
    expect(await hooks.onBeforeBlobUpload('f9')).toMatchObject({ externalAttachment: true, fileId: 'f9' });
  });
});

describe('offloading a file', () => {
  function fakeClient(taken = []) {
    const calls = [];
    return {
      calls,
      origin: 'https://c.example', userId: 'alice',
      mkdirp: async (p) => calls.push(`mkdirp ${p}`),
      names: async () => taken,
      share: async (path, opts) => { calls.push(`share ${path} ${JSON.stringify(opts)}`); return { url: 'https://c.example/s/abc' }; },
    };
  }

  it('picks a free name in the dated upload folder', async () => {
    const client = fakeClient(['video.mp4']);
    expect(await planUpload(client, '/Mail attachments/2026-10-14', 'video.mp4')).toBe('/Mail attachments/2026-10-14/video (2).mp4');
    expect(client.calls).toEqual(['mkdirp /Mail attachments/2026-10-14']);
  });

  it('uploads, shares and returns the link block for the message', async () => {
    const api = fakeApi({ translations: manifest.locales, settings: { uploadFolder: 'Up', folderLayout: 'flat' }, handlers: { 'proxy.fetch': async () => ({ status: 201, ok: true, headers: {} }) } });
    const client = fakeClient();
    const file = Object.assign(new Blob([new Uint8Array(3)]), { name: 'a.bin' });
    const res = await offloadFile(api, client, file, { share: { usePassword: true, password: ' pw ', includePassword: true, expireDate: '2026-11-01' } });
    expect(res.externalAttachment).toBe(true);
    expect(res.path).toBe('/Up/a.bin');
    expect(client.calls[1]).toBe('share /Up/a.bin {"password":"pw","expireDate":"2026-11-01"}');
    expect(res.html).toContain('https://c.example/s/abc');
    expect(res.text).toContain('password: pw');
    expect(api.calls('proxy.fetch')[0].args[1]).toBe('https://c.example/remote.php/dav/files/alice/Up/a.bin');
  });
});
