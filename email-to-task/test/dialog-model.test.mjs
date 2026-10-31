import { describe, expect, it } from 'vitest';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { checkExisting, createTasks, prepareDialog } from '../src/lib/dialog-model.js';
import { TASK_KEYWORD } from '../src/lib/mark-done.js';

const LOCATION = { origin: 'http://localhost:3100', pathname: '/plugin-sandbox' };

const EMAILS = {
  M1: { id: 'M1', subject: 'Re: Invoice 2026-10', from: [{ name: 'ACME', email: 'billing@acme.example' }], receivedAt: '2026-10-14T09:00:00', text: 'Please pay by Friday.', headers: {} },
  M2: { id: 'M2', subject: 'URGENT: contract', from: [{ name: '', email: 'bob@example.org' }], receivedAt: '2026-10-14T09:00:00', text: 'Sign it bis zum 30.10.2026', headers: {} },
};

function api({ accounts = [{ credentialId: 'vikunja', origin: 'http://localhost:18456', connected: true }], tasks = true, fetch, store } = {}) {
  const a = fakeApi({
    handlers: {
      'email.get': async (id) => EMAILS[id] ?? null,
      'proxy.accounts': async () => accounts,
      'admin.getAllConfig': async () => ({ vikunjaUrl: 'http://localhost:18456' }),
      'tasks.list': async () => { if (!tasks) throw new Error('no calendars'); return []; },
      'tasks.create': async (input) => ({ id: 'T-new', ...input }),
      'proxy.fetch': fetch ?? (async () => proxyResponse({ id: 7 })),
      'email.setKeyword': async () => {},
    },
  });
  if (store) for (const [k, v] of Object.entries(store)) a.storage.set(k, v);
  return a;
}

describe('prepareDialog', () => {
  it('fills in title, description with a link back, due date and priority from each message', async () => {
    const s = await prepareDialog(api(), { emailIds: ['M1', 'M2'], location: LOCATION });
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({ emailId: 'M1', title: 'Invoice 2026-10', due: '2026-10-16', dueMatch: 'by Friday', priority: 'none', link: 'http://localhost:3100/mail/message/M1' });
    expect(s.items[0].description).toContain('description.link');
    expect(s.items[1]).toMatchObject({ title: 'URGENT: contract', due: '2026-10-30', priority: 'high' });
  });

  it('offers Bulwark tasks only when the server has them', async () => {
    expect((await prepareDialog(api(), { emailIds: ['M1'], location: LOCATION })).targets.map((x) => x.id)).toEqual(['bulwark', 'vikunja', 'todoist', 'caldav', 'donetick']);
    expect((await prepareDialog(api({ tasks: false }), { emailIds: ['M1'], location: LOCATION })).targets.map((x) => x.id)).toEqual(['vikunja', 'todoist', 'caldav', 'donetick']);
  });

  it('marks which services are connected and picks the last one used', async () => {
    const s = await prepareDialog(api({ store: { prefs: { target: 'todoist' } } }), { emailIds: ['M1'], location: LOCATION });
    expect(Object.fromEntries(s.targets.map((x) => [x.id, x.connected]))).toEqual({ bulwark: true, vikunja: true, todoist: false, caldav: false, donetick: false });
    expect(s.target).toBe('todoist');
  });

  it('starts with a connected service when there is no last choice', async () => {
    const s = await prepareDialog(api({ tasks: false }), { emailIds: ['M1'], location: LOCATION });
    expect(s.target).toBe('vikunja');
  });

  it('counts messages it could not read', async () => {
    const s = await prepareDialog(api(), { emailIds: ['M1', 'gone'], location: LOCATION });
    expect(s.items.map((i) => i.emailId)).toEqual(['M1']);
    expect(s.missing).toEqual(['gone']);
  });

  it('shows the tasks already made from a message', async () => {
    const ref = { target: 'vikunja', taskId: '5', title: 'Old', createdAt: '2026-10-01T00:00:00Z' };
    const s = await prepareDialog(api({ store: { tasks: { M1: [ref] } } }), { emailIds: ['M1'], location: LOCATION });
    expect(s.items[0].existing).toEqual([ref]);
  });
});

describe('checkExisting', () => {
  it('forgets tasks that were deleted in the service and keeps the rest', async () => {
    const refs = [{ target: 'vikunja', taskId: '5', title: 'gone' }, { target: 'vikunja', taskId: '6', title: 'still there' }];
    const a = api({
      store: { tasks: { M1: refs } },
      fetch: async (id, url) => (url.endsWith('/tasks/5') ? proxyResponse({}, { status: 404 }) : proxyResponse({ id: 6 })),
    });
    const s = await prepareDialog(a, { emailIds: ['M1'], location: LOCATION });
    const items = await checkExisting(a, s);
    expect(items[0].existing.map((r) => r.taskId)).toEqual(['6']);
    expect((await a.storage.get('tasks')).M1.map((r) => r.taskId)).toEqual(['6']);
  });
});

describe('createTasks', () => {
  it('creates one task per message, remembers it and marks the message', async () => {
    let n = 10;
    const a = api({ fetch: async () => proxyResponse({ id: n++ }) });
    const s = await prepareDialog(a, { emailIds: ['M1', 'M2'], location: LOCATION });
    const progress = [];
    const out = await createTasks(a, s, { target: 'vikunja', containerId: '2', after: 'both', items: s.items }, (d, total) => progress.push(`${d}/${total}`));
    expect(out.failed).toEqual([]);
    expect(out.created.map((c) => c.ref.taskId)).toEqual(['10', '11']);
    expect(progress).toEqual(['0/2', '1/2', '2/2']);
    const stored = await a.storage.get('tasks');
    expect(stored.M1[0]).toMatchObject({ target: 'vikunja', taskId: '10', title: 'Invoice 2026-10', url: 'http://localhost:18456/tasks/10' });
    expect(a.calls('email.setKeyword').map((c) => c.args)).toEqual([['M1', TASK_KEYWORD], ['M1', '$seen'], ['M2', TASK_KEYWORD], ['M2', '$seen']]);
    expect(await a.storage.get('prefs')).toMatchObject({ target: 'vikunja', after: 'both', containers: { vikunja: '2' } });
  });

  it('leaves the message alone when asked to', async () => {
    const a = api();
    const s = await prepareDialog(a, { emailIds: ['M1'], location: LOCATION });
    await createTasks(a, s, { target: 'vikunja', containerId: '2', after: 'none', items: s.items });
    expect(a.calls('email.setKeyword')).toEqual([]);
  });

  it('stops after a rejected token instead of trying every message', async () => {
    const a = api({ fetch: async () => proxyResponse({ message: 'invalid token' }, { status: 401 }) });
    const s = await prepareDialog(a, { emailIds: ['M1', 'M2'], location: LOCATION });
    const out = await createTasks(a, s, { target: 'vikunja', containerId: '2', after: 'keyword', items: s.items });
    expect(out.created).toEqual([]);
    expect(out.failed.map((f) => [f.emailId, f.error.code])).toEqual([['M1', 'auth'], ['M2', 'auth']]);
    expect(a.calls('proxy.fetch').filter((c) => c.args[2]?.method === 'PUT')).toHaveLength(1);
    expect(a.calls('email.setKeyword')).toEqual([]);
    expect(await a.storage.get('tasks')).toBeNull();
  });

  it('keeps going after one bad message and reports it', async () => {
    let call = 0;
    const a = api({ fetch: async () => (call++ === 0 ? proxyResponse({}, { status: 400 }) : proxyResponse({ id: 3 })) });
    const s = await prepareDialog(a, { emailIds: ['M1', 'M2'], location: LOCATION });
    const out = await createTasks(a, s, { target: 'vikunja', containerId: '2', after: 'keyword', items: s.items });
    expect(out.failed.map((f) => f.error.code)).toEqual(['bad_request']);
    expect(out.created.map((c) => c.emailId)).toEqual(['M2']);
    expect(a.calls('email.setKeyword').map((c) => c.args[0])).toEqual(['M2']);
  });

  it('refuses an empty title', async () => {
    const a = api();
    const s = await prepareDialog(a, { emailIds: ['M1'], location: LOCATION });
    const out = await createTasks(a, s, { target: 'vikunja', containerId: '2', after: 'none', items: [{ ...s.items[0], title: '  ' }] });
    expect(out.failed[0].error.code).toBe('no_title');
    expect(a.calls('proxy.fetch').filter((c) => c.args[2]?.method === 'PUT')).toHaveLength(0);
  });

  it('needs the account to be connected', async () => {
    const a = api({ accounts: [] });
    const s = await prepareDialog(a, { emailIds: ['M1'], location: LOCATION });
    await expect(createTasks(a, s, { target: 'vikunja', containerId: '2', after: 'none', items: s.items })).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('creates Bulwark tasks without any account', async () => {
    const a = api({ accounts: [] });
    const s = await prepareDialog(a, { emailIds: ['M2'], location: LOCATION });
    const out = await createTasks(a, s, { target: 'bulwark', after: 'keyword', items: s.items });
    expect(out.created[0].ref).toMatchObject({ target: 'bulwark', taskId: 'T-new' });
    expect(a.calls('tasks.create')[0].args[0]).toMatchObject({ title: 'URGENT: contract', due: '2026-10-30', priority: 1 });
  });
});
