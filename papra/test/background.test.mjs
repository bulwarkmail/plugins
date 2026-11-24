import { describe, it, expect } from 'vitest';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { createBackground } from '../src/lib/background.js';
import { ORGANIZATION_KEY, chooseOrganization } from '../src/lib/connection.js';
import { MAX_ATTACH_BYTES, attachDocuments, emlName } from '../src/lib/documents.js';
import { activate, hooks, slots } from '../src/index.js';
import manifest from '../manifest.json' with { type: 'json' };

const BASE = 'https://docs.example.com';
const enc = (s) => new TextEncoder().encode(s);

function api({ connected = true, confirm = false, dialog = null, organizations = [{ id: 'o1', name: 'Home' }], extra = {} } = {}) {
  const uploads = [];
  const a = fakeApi({
    translations: manifest.locales,
    handlers: {
      'admin.getConfig': () => '',
      'proxy.accounts': () => (connected ? [{ credentialId: 'personal', scope: 'user', origin: BASE, connected: true }] : []),
      'proxy.fetch': (cred, url, init) => {
        if (url === `${BASE}/api/organizations`) return proxyResponse(JSON.stringify({ organizations }));
        const m = /\/api\/organizations\/([^/]+)\/documents$/.exec(url);
        if (m && init.method === 'POST') {
          const body = new TextDecoder().decode(init.body);
          const name = /filename="([^"]+)"/.exec(body)[1];
          uploads.push({ cred, org: m[1], name, body });
          return proxyResponse(JSON.stringify({ document: { id: 'doc_new', name } }));
        }
        return proxyResponse('{}');
      },
      'email.get': async () => ({ id: 'e1', subject: 'Lease: signed / final' }),
      'email.getRaw': async () => enc('Subject: Lease\r\n\r\nhi').buffer,
      'email.getAttachment': async () => ({ name: 'lease.pdf', type: 'application/pdf', size: 4, data: enc('%PDF').buffer }),
      'ui.confirm': async () => confirm,
      'ui.openDialog': async () => dialog,
      ...extra,
    },
  });
  return { api: a, uploads };
}

describe('registerUi', () => {
  it('adds From Papra to the Attach menu and Save to Papra to attachments and the message', async () => {
    const { api: a } = api();
    await createBackground(a).registerUi();
    expect(a.calls('ui.setActions').map((c) => [c.args[0], c.args[1].map((x) => [x.id, x.label])])).toEqual([
      ['composer-attach-menu', [['from-papra', 'From Papra']]],
      ['attachment-menu', [['save-attachment', 'Save to Papra']]],
      ['reader-actions', [['save-message', 'Save message to Papra']]],
    ]);
  });
});

describe('Save to Papra', () => {
  it('saves an attachment straight into the only organization', async () => {
    const { api: a, uploads } = api();
    await createBackground(a).onAction({ actionId: 'save-attachment', context: { emailId: 'e1', blobId: 'b1', name: 'lease.pdf', type: 'application/pdf' } });
    expect(a.calls('ui.openDialog')).toHaveLength(0);
    expect(uploads.map((u) => [u.cred, u.org, u.name])).toEqual([['personal', 'o1', 'lease.pdf']]);
    expect(a.calls('toast.success').map((c) => c.args[0])).toEqual(['lease.pdf is in Papra.']);
  });

  it('saves the whole message as .eml', async () => {
    const { api: a, uploads } = api();
    await createBackground(a).onAction({ actionId: 'save-message', context: { emailId: 'e1' } });
    expect(uploads[0].name).toBe('Lease signed final.eml');
    expect(uploads[0].body).toContain('Content-Type: message/rfc822');
    expect(uploads[0].body).toContain('Subject: Lease');
  });

  it('asks which organization with several, starting at the last one picked, and remembers the choice', async () => {
    const organizations = [{ id: 'o1', name: 'Home' }, { id: 'o2', name: 'Work' }];
    const { api: a, uploads } = api({ organizations, dialog: { organizationId: 'o1' } });
    await a.storage.set(ORGANIZATION_KEY, 'o2');
    await createBackground(a).onAction({ actionId: 'save-attachment', context: { emailId: 'e1', blobId: 'b1', name: 'lease.pdf' } });
    expect(a.calls('ui.openDialog')[0].args[0].extraProps).toMatchObject({ view: 'save', kind: 'attachment', name: 'lease.pdf', organizationId: 'o2' });
    expect(uploads.map((u) => u.org)).toEqual(['o1']);
    expect(await a.storage.get(ORGANIZATION_KEY)).toBe('o1');
  });

  it('saves nothing when the organization dialog is cancelled', async () => {
    const { api: a, uploads } = api({ organizations: [{ id: 'o1', name: 'A' }, { id: 'o2', name: 'B' }], dialog: null });
    await createBackground(a).onAction({ actionId: 'save-message', context: { emailId: 'e1' } });
    expect(uploads).toHaveLength(0);
    expect(a.calls('email.getRaw')).toHaveLength(0);
  });

  it('says so when the account has no organization', async () => {
    const { api: a, uploads } = api({ organizations: [] });
    await createBackground(a).onAction({ actionId: 'save-message', context: { emailId: 'e1' } });
    expect(uploads).toHaveLength(0);
    expect(a.calls('toast.error').map((c) => c.args[0])).toEqual(["Your Papra account isn't in an organization yet. Create one in Papra first."]);
  });

  it('asks to connect first and saves nothing when the user says no', async () => {
    const { api: a, uploads } = api({ connected: false });
    await createBackground(a).onAction({ actionId: 'save-attachment', context: { emailId: 'e1', blobId: 'b1' } });
    expect(a.calls('ui.confirm')).toHaveLength(1);
    expect(uploads).toHaveLength(0);
  });
});

describe('From Papra', () => {
  it('opens the picker for that composer and says how many went in', async () => {
    const { api: a } = api({ dialog: { attached: 2 } });
    expect(await createBackground(a).onAction({ actionId: 'from-papra', context: { composerId: 'c1' } })).toBe(2);
    expect(a.calls('ui.openDialog')[0].args[0].extraProps).toEqual({ view: 'picker', composerId: 'c1' });
    expect(a.calls('toast.success').map((c) => c.args[0])).toEqual(['Attached from Papra: 2']);
  });

  it('attaches documents to the composer and skips downloading one too big for mail', async () => {
    const a = fakeApi({ handlers: { 'jmap.uploadBlob': async (b, name, type) => ({ blobId: `b-${name}`, size: b.byteLength, type }), 'composer.attach': async () => true } });
    const downloads = [];
    const client = { async download(org, doc) { downloads.push([org, doc.id]); return { data: new Uint8Array([1]).buffer, type: doc.type, name: doc.name }; } };
    const n = await attachDocuments(a, client, 'o1', 'c1', [{ id: 'd1', name: 'a.pdf', type: 'application/pdf', size: 1 }]);
    expect(n).toBe(1);
    expect(a.calls('composer.attach')[0].args).toEqual(['c1', { blobId: 'b-a.pdf', name: 'a.pdf', type: 'application/pdf', size: 1 }]);
    await expect(attachDocuments(a, client, 'o1', 'c1', [{ id: 'd2', name: 'big.zip', size: MAX_ATTACH_BYTES + 1 }])).rejects.toMatchObject({ key: 'error.attach_too_large' });
    expect(downloads).toEqual([['o1', 'd1']]);
  });
});

describe('helpers and exports', () => {
  it('picks the stored organization while it exists, else the first', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    expect(chooseOrganization(list, 'b')).toBe('b');
    expect(chooseOrganization(list, 'gone')).toBe('a');
    expect(chooseOrganization([], 'a')).toBe('');
    expect(emlName('')).toBe('message.eml');
  });

  it('activates and answers hooks at once', async () => {
    const { api: a } = api({ dialog: new Promise(() => {}) });
    await activate(a);
    expect(a.calls('ui.setActions')).toHaveLength(3);
    expect(hooks.onAction({ actionId: 'from-papra', context: { composerId: 'c1' } })).toBeUndefined();
    expect(Object.keys(slots).sort()).toEqual(['plugin-dialog', 'settings-section']);
    expect(manifest.credentials.personal.inject).toEqual({ type: 'header', name: 'Authorization', prefix: 'Bearer ' });
  });
});
