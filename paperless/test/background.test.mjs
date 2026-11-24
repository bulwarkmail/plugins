import { describe, it, expect } from 'vitest';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { createBackground, LINKS_KEY, REMEMBERED_KEY } from '../src/lib/background.js';
import { RULES_KEY, PROCESSED_KEY } from '../src/lib/rules.js';
import { TASKS_KEY } from '../src/lib/tasks.js';
import { activate, hooks, slots } from '../src/index.js';

const BASE = 'https://dms.example.com';
const TASK = '0b1c2d3e-aaaa-bbbb-cccc-0123456789ab';
const enc = (s) => new TextEncoder().encode(s);
const view = { id: 'e1', subject: 'Invoice 10', from: [{ name: 'ACME', email: 'billing@acme.example' }], receivedAt: '2026-10-14T10:00:00Z' };
const rawMail = enc(['Subject: Invoice 10', 'Content-Type: multipart/mixed; boundary=b', '',
  '--b', 'Content-Type: text/plain', '', 'hi',
  '--b', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="inv.pdf"', '', '%PDF',
  '--b--', ''].join('\r\n')).buffer;

/** A connected shared account; Paperless answers uploads with a task id. */
function api({ dialog = null, connected = true, extra = {} } = {}) {
  const uploads = [];
  const a = fakeApi({
    permissions: ['http:proxy'],
    handlers: {
      'admin.getConfig': () => (connected ? BASE : ''),
      'proxy.accounts': () => [],
      'proxy.fetch': (cred, url, init) => {
        if (url.endsWith('/api/ui_settings/')) return connected ? proxyResponse('{}') : { status: 404, ok: false, headers: {}, body: '', proxyError: 'no_credential' };
        if (url.endsWith('/api/documents/post_document/')) { uploads.push({ cred, init }); return proxyResponse(`"${TASK}"`); }
        return proxyResponse('{}');
      },
      'email.get': async () => view,
      'email.getAttachment': async () => ({ name: 'inv.pdf', type: 'application/pdf', size: 4, data: enc('%PDF').buffer }),
      'email.getRaw': async () => rawMail,
      'ui.openDialog': async () => dialog,
      'ui.confirm': async () => false,
      ...extra,
    },
  });
  return { api: a, uploads };
}

const noTimer = () => {};

describe('registerUi', () => {
  it('puts a button on the three mail surfaces and a page in the navigation', async () => {
    const { api: a } = api();
    await createBackground(a, { setTimer: noTimer }).registerUi();
    const surfaces = a.calls('ui.setActions').map((c) => [c.args[0], c.args[1].map((x) => x.id)]);
    expect(surfaces).toEqual([
      ['attachment-menu', ['send-attachment']],
      ['reader-actions', ['send-message']],
      ['message-bulk-actions', ['send-bulk']],
      ['composer-attach-menu', ['from-paperless']],
    ]);
    // Not the webmail's own Archive icon, which sits next to these in the reader toolbar.
    const icons = a.calls('ui.setActions').flatMap((c) => c.args[1].map((x) => x.icon));
    expect(icons).toEqual(['archive-restore', 'archive-restore', 'archive-restore', 'archive']);
    expect(a.calls('ui.setPages')[0].args[0]).toEqual([{ id: 'documents', title: 'page.title', icon: 'archive' }]);
  });
});

describe('From Paperless in the composer', () => {
  it('opens the document browser for that composer and says how many went in', async () => {
    const { api: a } = api({ extra: { 'ui.openDialog': async () => ({ attached: 2 }) } });
    const attached = await createBackground(a, { setTimer: noTimer }).onAction({ surface: 'composer-attach-menu', actionId: 'from-paperless', context: { composerId: 'c-1' } });
    expect(attached).toBe(2);
    expect(a.calls('ui.openDialog')[0].args[0]).toMatchObject({ slot: 'plugin-dialog', extraProps: { view: 'browse', composerId: 'c-1' } });
    expect(a.calls('toast.success').map((c) => c.args[0])).toEqual(['composer.attached']);
  });

  it('says nothing when the dialog was closed without attaching', async () => {
    const { api: a } = api({ extra: { 'ui.openDialog': async () => ({ attached: 0 }) } });
    await createBackground(a, { setTimer: noTimer }).onAction({ actionId: 'from-paperless', context: { composerId: 'c-1' } });
    expect(a.calls('toast.success')).toHaveLength(0);
  });

  it('does nothing without a composer to attach to', async () => {
    const { api: a } = api();
    await createBackground(a, { setTimer: noTimer }).onAction({ actionId: 'from-paperless', context: {} });
    expect(a.calls('ui.openDialog')).toHaveLength(0);
  });
});

describe('send flow', () => {
  it('attachment menu: dialog with the file, upload with the choice, task followed, choice remembered', async () => {
    const choice = { selected: ['a:b1'], title: 'October', correspondent: 1, documentType: 2, storagePath: null, tags: [5], remember: true, senderEmail: 'billing@acme.example' };
    const { api: a, uploads } = api({ dialog: choice });
    const bg = createBackground(a, { setTimer: noTimer });
    const result = await bg.onAction({ surface: 'attachment-menu', actionId: 'send-attachment', context: { emailId: 'e1', blobId: 'b1', name: 'inv.pdf', type: 'application/pdf' } });
    expect(result).toEqual({ sent: 1, failed: 0 });

    const opened = a.calls('ui.openDialog')[0].args[0];
    expect(opened.slot).toBe('plugin-dialog');
    expect(opened.extraProps.view).toBe('send');
    expect(opened.extraProps.groups[0].items.map((i) => i.key)).toEqual(['a:b1']);
    expect(opened.extraProps.groups[0].items[0].data).toBeUndefined();

    expect(uploads).toHaveLength(1);
    expect(uploads[0].cred).toBe('shared');
    const body = new TextDecoder().decode(uploads[0].init.body);
    expect(body).toContain('name="title"\r\n\r\nOctober');
    expect(body).toContain('%PDF');

    expect((await a.storage.get(TASKS_KEY)).map((t) => [t.taskId, t.name, t.base])).toEqual([[TASK, 'October', BASE]]);
    expect((await a.storage.get(REMEMBERED_KEY))['billing@acme.example'].correspondent).toBe(1);
    expect(a.calls('toast.info')[0].args[0]).toBe('send.queued');
  });

  it('a cancelled dialog sends nothing', async () => {
    const { api: a, uploads } = api({ dialog: null });
    await createBackground(a, { setTimer: noTimer }).onAction({ actionId: 'send-message', context: { emailId: 'e1' } });
    expect(a.calls('ui.openDialog')).toHaveLength(1);
    expect(uploads).toHaveLength(0);
  });

  it('bulk reads every selected message', async () => {
    const { api: a } = api({ dialog: null });
    await createBackground(a, { setTimer: noTimer }).onAction({ actionId: 'send-bulk', context: { emailIds: ['e1', 'e2'] } });
    expect(a.calls('email.getRaw').map((c) => c.args[0])).toEqual(['e1', 'e2']);
    expect(a.calls('ui.openDialog')[0].args[0].extraProps.groups).toHaveLength(2);
  });

  it('asks to connect first when there is no account, and stops when the user says no', async () => {
    const { api: a } = api({ connected: false });
    await createBackground(a, { setTimer: noTimer }).onAction({ actionId: 'send-message', context: { emailId: 'e1' } });
    expect(a.calls('ui.confirm')).toHaveLength(1);
    expect(a.calls('proxy.connect')).toHaveLength(0);
    expect(a.calls('ui.openDialog')).toHaveLength(0);
    expect(a.calls('email.getRaw')).toHaveLength(0);
  });

  it('shows a refused upload as a plain error and stops at a bad token', async () => {
    const choice = { selected: ['e1:0', 'e1:eml'] };
    const { api: a } = api({ dialog: choice, extra: {
      'proxy.fetch': (cred, url) => (url.endsWith('/api/ui_settings/') ? proxyResponse('{}') : proxyResponse('{"detail":"Invalid token."}', { status: 401 })),
    } });
    const result = await createBackground(a, { setTimer: noTimer }).onAction({ actionId: 'send-message', context: { emailId: 'e1' } });
    expect(result).toEqual({ sent: 0, failed: 2 });
    expect(a.calls('proxy.fetch').filter((c) => c.args[1].endsWith('post_document/'))).toHaveLength(1);
    expect(a.calls('toast.error')[0].args[0]).toBe('error.token');
  });
});

describe('when a task finishes', () => {
  it('notifies with an "Open in Paperless" link to the document, which a click on the notification opens too', async () => {
    const { api: a } = api();
    const bg = createBackground(a, { setTimer: noTimer });
    await bg.reportDone({ name: 'October', base: BASE }, { state: 'success', documentId: 42 });
    expect(a.calls('notifications.show')[0].args[0]).toEqual({
      title: 'done.title', body: 'done.body', tag: 'doc-42',
      action: { label: 'browse.open_in_paperless', url: `${BASE}/documents/42/details` },
    });
    expect((await a.storage.get(LINKS_KEY))['doc-42']).toBe(`${BASE}/documents/42/details`);
    await bg.onNotificationClick({ tag: 'doc-42' });
    expect(a.calls('ui.openExternalUrl')[0].args[0]).toBe(`${BASE}/documents/42/details`);
  });

  it('links to the list filtered by title when the id is unknown or polling gave up', async () => {
    const { api: a } = api();
    const bg = createBackground(a, { setTimer: noTimer });
    const entry = { name: 'Invoice 10/2026 & co', base: BASE };
    const list = `${BASE}/documents?title__icontains=Invoice%2010%2F2026%20%26%20co`;
    await bg.reportDone(entry, { state: 'success', documentId: null });
    await bg.reportDone(entry, { state: 'timeout' });
    await bg.reportDone(entry, { state: 'error', errorKey: 'error.token' });
    const shown = a.calls('notifications.show').map((c) => c.args[0]);
    expect(shown.map((n) => n.action)).toEqual([
      { label: 'browse.open_in_paperless', url: list },
      { label: 'browse.open_in_paperless', url: list },
      { label: 'browse.open_in_paperless', url: list },
    ]);
    expect(shown[0]).toMatchObject({ title: 'done.title', body: 'done.body' });
    expect(shown[0].tag).toBeUndefined();
    expect(shown[1]).toMatchObject({ title: 'failed.title', body: 'failed.timeout' });
  });

  it('keeps the link on the server the document went to, under its path', async () => {
    const { api: a } = api();
    const bg = createBackground(a, { setTimer: noTimer });
    await bg.reportDone({ name: 'x', base: 'https://dms.example.com/paperless' }, { state: 'success', documentId: 7 });
    expect(a.calls('notifications.show')[0].args[0].action.url).toBe('https://dms.example.com/paperless/documents/7/details');
  });

  it('links a duplicate to the copy already in Paperless', async () => {
    const { api: a } = api();
    await createBackground(a, { setTimer: noTimer }).reportDone({ name: 'x', base: BASE }, { state: 'failure', error: 'It is a duplicate of y (#3)', duplicateOf: 3 });
    expect(a.calls('notifications.show')[0].args[0]).toMatchObject({ body: 'failed.duplicate', tag: 'doc-3', action: { url: `${BASE}/documents/3/details` } });
  });

  it('still notifies, without the link, when the host refuses it', async () => {
    const { api: a } = api({ extra: { 'notifications.show': (n) => { if (n.action) throw new Error('action.url must be on a server the plugin talks to'); } } });
    await createBackground(a, { setTimer: noTimer }).reportDone({ name: 'x', base: BASE }, { state: 'success', documentId: 1 });
    const shown = a.calls('notifications.show').map((c) => c.args[0]);
    expect(shown).toHaveLength(2);
    expect(shown[1]).toEqual({ title: 'done.title', body: 'done.body', tag: 'doc-1' });
    expect(a.calls('toast.success')).toHaveLength(0);
  });

  it('says when the document was a duplicate or failed, as an error toast without notifications', async () => {
    const { api: a } = api();
    a.changeSettings({ notify: false });
    const bg = createBackground(a, { setTimer: noTimer });
    await bg.reportDone({ name: 'x' }, { state: 'failure', error: 'It is a duplicate of y (#3)', duplicateOf: 3 });
    await bg.reportDone({ name: 'x' }, { state: 'failure', error: 'Unsupported mime type' });
    expect(a.calls('notifications.show')).toHaveLength(0);
    expect(a.calls('toast.error').map((c) => c.args[0])).toEqual(['failed.title: failed.duplicate', 'failed.title: failed.body']);
  });
});

describe('rules on new mail', () => {
  const rule = { id: 'r', from: '@acme.example', enabled: true, enabledAt: Date.parse('2026-10-14T09:00:00Z'), tags: [5], correspondent: 1 };

  it('sends the attachments of matching new mail without a dialog, once', async () => {
    const { api: a, uploads } = api();
    await a.storage.set(RULES_KEY, [rule]);
    const bg = createBackground(a, { setTimer: noTimer });
    const email = { ...view, hasAttachment: true };
    expect(await bg.onNewEmail(email)).toEqual({ sent: 1, failed: 0 });
    expect(await bg.onNewEmail(email)).toBeNull();
    expect(uploads).toHaveLength(1);
    expect(a.calls('ui.openDialog')).toHaveLength(0);
    const body = new TextDecoder().decode(uploads[0].init.body);
    expect(body).toContain('filename="inv.pdf"');
    expect(body).toContain('name="tags"\r\n\r\n5');
    expect(await a.storage.get(PROCESSED_KEY)).toEqual(['e1']);
  });

  it('leaves mail alone when the rule is off or does not fit', async () => {
    const { api: a, uploads } = api();
    await a.storage.set(RULES_KEY, [{ ...rule, enabled: false }, { ...rule, from: '@other.example' }]);
    expect(await createBackground(a, { setTimer: noTimer }).onNewEmail({ ...view, hasAttachment: true })).toBeNull();
    expect(uploads).toHaveLength(0);
    expect(a.calls('email.getRaw')).toHaveLength(0);
  });
});

describe('plugin exports', () => {
  it('activates, and hooks answer at once while the work runs on', async () => {
    const { api: a } = api({ dialog: new Promise(() => {}) });
    await activate(a);
    expect(a.calls('ui.setActions')).toHaveLength(4);
    // onAction must not wait for the dialog (the host gives hooks only seconds).
    expect(hooks.onAction({ actionId: 'send-message', context: { emailId: 'e1' } })).toBeUndefined();
    expect(Object.keys(slots).sort()).toEqual(['app-page', 'plugin-dialog', 'settings-section']);
  });
});
