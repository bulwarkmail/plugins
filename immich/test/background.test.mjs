import { describe, it, expect } from 'vitest';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { createBackground } from '../src/lib/background.js';
import { activate, hooks, slots } from '../src/index.js';
import manifest from '../manifest.json' with { type: 'json' };

const BASE = 'https://photos.example.com';

function api({ connected = true, confirm = false, dialog = null, extra = {} } = {}) {
  const uploads = [];
  const a = fakeApi({
    translations: manifest.locales,
    handlers: {
      'admin.getConfig': () => '',
      'proxy.accounts': () => (connected ? [{ credentialId: 'personal', scope: 'user', origin: BASE, connected: true }] : []),
      'proxy.fetch': (cred, url, init) => {
        if (url === `${BASE}/api/assets`) { uploads.push({ cred, init }); return proxyResponse('{"id":"n1","status":"created"}'); }
        return proxyResponse('{}');
      },
      'email.get': async () => ({ id: 'e1', receivedAt: '2026-09-09T09:00:00Z' }),
      'email.getAttachment': async () => ({ name: 'beach.jpg', type: 'image/jpeg', size: 1, data: new Uint8Array([1]).buffer }),
      'ui.confirm': async () => confirm,
      'ui.openDialog': async () => dialog,
      ...extra,
    },
  });
  return { api: a, uploads };
}

describe('registerUi', () => {
  it('adds From Immich to the Attach menu and Save to Immich to attachments', async () => {
    const { api: a } = api();
    await createBackground(a).registerUi();
    expect(a.calls('ui.setActions').map((c) => [c.args[0], c.args[1].map((x) => [x.id, x.label, x.icon])])).toEqual([
      ['composer-attach-menu', [['from-immich', 'From Immich', 'photo']]],
      ['attachment-menu', [['save-attachment', 'Save to Immich', 'cloud-upload']]],
    ]);
  });
});

describe('From Immich', () => {
  it('opens the picker for that composer and says how many went in', async () => {
    const { api: a } = api({ dialog: { attached: 3 } });
    expect(await createBackground(a).onAction({ actionId: 'from-immich', context: { composerId: 'c1' } })).toBe(3);
    expect(a.calls('ui.openDialog')[0].args[0]).toMatchObject({ slot: 'plugin-dialog', extraProps: { view: 'picker', composerId: 'c1' } });
    expect(a.calls('toast.success').map((c) => c.args[0])).toEqual(['Attached from Immich: 3']);
  });

  it('ignores a click without a composer', async () => {
    const { api: a } = api();
    await createBackground(a).onAction({ actionId: 'from-immich', context: {} });
    expect(a.calls('ui.openDialog')).toHaveLength(0);
  });
});

describe('Save to Immich', () => {
  it('uploads the attachment with the user key and says it is there', async () => {
    const { api: a, uploads } = api();
    await createBackground(a).onAction({ actionId: 'save-attachment', context: { emailId: 'e1', blobId: 'b1', name: 'beach.jpg', type: 'image/jpeg' } });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].cred).toBe('personal');
    expect(a.calls('toast.success').map((c) => c.args[0])).toEqual(['beach.jpg is in Immich.']);
  });

  it('asks to connect first and uploads nothing when the user says no', async () => {
    const { api: a, uploads } = api({ connected: false, confirm: false });
    await createBackground(a).onAction({ actionId: 'save-attachment', context: { emailId: 'e1', blobId: 'b1', name: 'beach.jpg', type: 'image/jpeg' } });
    expect(a.calls('ui.confirm')).toHaveLength(1);
    expect(a.calls('proxy.connect')).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  it('says why a PDF stays out of Immich', async () => {
    const { api: a, uploads } = api();
    await createBackground(a).onAction({ actionId: 'save-attachment', context: { emailId: 'e1', blobId: 'b1', name: 'invoice.pdf', type: 'application/pdf' } });
    expect(uploads).toHaveLength(0);
    expect(a.calls('toast.error').map((c) => c.args[0])).toEqual(['Immich only takes photos and videos, not invoice.pdf.']);
  });
});

describe('plugin exports', () => {
  it('activates, and onAction answers at once while the dialog is open', async () => {
    const { api: a } = api({ dialog: new Promise(() => {}) });
    await activate(a);
    expect(a.calls('ui.setActions')).toHaveLength(2);
    expect(hooks.onAction({ actionId: 'from-immich', context: { composerId: 'c1' } })).toBeUndefined();
    expect(Object.keys(slots).sort()).toEqual(['plugin-dialog', 'settings-section']);
  });

  it('asks only for the permissions it uses', () => {
    expect(manifest.permissions.sort()).toEqual(['admin:config', 'email:blob-read', 'email:blob-write', 'email:read', 'http:proxy', 'ui:composer-toolbar', 'ui:settings-section']);
    expect(manifest.credentials.personal.inject).toEqual({ type: 'header', name: 'X-API-Key' });
  });
});
