import { describe, expect, it } from 'vitest';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { vikunja } from '../src/lib/targets/vikunja.js';
import { todoist } from '../src/lib/targets/todoist.js';
import { caldav, discoverTaskLists } from '../src/lib/targets/caldav.js';
import { bulwark } from '../src/lib/targets/bulwark.js';
import { donetick } from '../src/lib/targets/donetick.js';
import { errorForResponse, errorText, request, toTaskError } from '../src/lib/errors.js';

const TASK = { title: 'Pay invoice', description: 'From: Bob\nOpen the message: https://m/mail/message/M1', due: '2026-10-20', priority: 'high', containerId: '2', link: 'https://m/mail/message/M1' };

function proxyApi(route) {
  return fakeApi({ handlers: { 'proxy.fetch': async (id, url, init = {}) => route(id, url, init) } });
}

describe('Vikunja', () => {
  const ctx = (api, config = {}) => ({ api, origin: 'http://localhost:18456', config: { vikunjaUrl: '', ...config } });

  it('lists projects a task can go into, skipping saved filters and archived ones', async () => {
    const api = proxyApi((id, url) => {
      expect(id).toBe('vikunja');
      expect(url).toBe('http://localhost:18456/api/v1/projects?page=1&per_page=50');
      return proxyResponse([{ id: 1, title: 'Inbox' }, { id: 2, title: 'Bulwark inbox' }, { id: -2, title: 'My Open Tasks' }, { id: 3, title: 'Old', is_archived: true }]);
    });
    expect(await vikunja.containers(ctx(api))).toEqual([{ id: '1', name: 'Inbox' }, { id: '2', name: 'Bulwark inbox' }]);
  });

  it('creates the task with PUT, HTML description, priority and a noon due date', async () => {
    let sent;
    const api = proxyApi((id, url, init) => {
      sent = { url, init };
      return proxyResponse({ id: 42, title: 'Pay invoice' });
    });
    const out = await vikunja.create(ctx(api, { vikunjaUrl: 'http://localhost:18456/' }), TASK);
    expect(sent.url).toBe('http://localhost:18456/api/v1/projects/2/tasks');
    expect(sent.init.method).toBe('PUT');
    const body = JSON.parse(sent.init.body);
    expect(body.title).toBe('Pay invoice');
    expect(body.priority).toBe(3);
    expect(new Date(body.due_date).getHours()).toBe(12);
    expect(body.description).toContain('<a href="https://m/mail/message/M1">');
    expect(out).toEqual({ taskId: '42', url: 'http://localhost:18456/tasks/42' });
  });

  it('uses the sub-path of the administrator\'s address on the same server', async () => {
    let url;
    const api = proxyApi((id, u) => { url = u; return proxyResponse({ id: 1 }); });
    const out = await vikunja.create({ api, origin: 'https://example.com', config: { vikunjaUrl: 'https://example.com/vikunja/' } }, TASK);
    expect(url).toBe('https://example.com/vikunja/api/v1/projects/2/tasks');
    expect(out.url).toBe('https://example.com/vikunja/tasks/1');
  });

  it('needs a project', async () => {
    await expect(vikunja.create(ctx(proxyApi(() => proxyResponse({}))), { ...TASK, containerId: '' })).rejects.toMatchObject({ code: 'no_project' });
  });

  it('tells deleted tasks from unreachable servers', async () => {
    expect(await vikunja.exists(ctx(proxyApi(() => proxyResponse({ message: 'nope' }, { status: 404 }))), { taskId: '1' })).toBe(false);
    expect(await vikunja.exists(ctx(proxyApi(() => proxyResponse('', { status: 502 }))), { taskId: '1' })).toBeNull();
    expect(await vikunja.exists(ctx(proxyApi(() => proxyResponse({ id: 1 }))), { taskId: '1' })).toBe(true);
  });
});

describe('Donetick', () => {
  const ctx = (api, config = {}) => ({ api, origin: 'http://localhost:18021', config: { donetickUrl: '', ...config } });

  it('posts a chore to the external API with an HTML description and a noon due date', async () => {
    let sent;
    const api = proxyApi((id, url, init) => { sent = { id, url, init }; return proxyResponse({ id: 9, name: 'Pay invoice' }, { status: 201 }); });
    const out = await donetick.create(ctx(api), TASK);
    expect(sent.id).toBe('donetick');
    expect(sent.url).toBe('http://localhost:18021/eapi/v1/chore');
    expect(sent.init.method).toBe('POST');
    const body = JSON.parse(sent.init.body);
    expect(Object.keys(body).sort()).toEqual(['description', 'dueDate', 'name']);
    expect(body.name).toBe('Pay invoice');
    expect(body.description).toContain('<a href="https://m/mail/message/M1">');
    const due = new Date(body.dueDate);
    expect([due.getFullYear(), due.getMonth() + 1, due.getDate(), due.getHours()]).toEqual([2026, 10, 20, 12]);
    expect(out).toEqual({ taskId: '9', url: 'http://localhost:18021/chores/9' });
  });

  it('leaves the due date out when there is none, and keeps a sub-path of the administrator\'s address', async () => {
    let sent;
    const api = proxyApi((id, url, init) => { sent = { url, body: JSON.parse(init.body) }; return proxyResponse({ id: 3 }); });
    const out = await donetick.create({ api, origin: 'https://example.com', config: { donetickUrl: 'https://example.com/donetick/' } }, { ...TASK, due: null });
    expect(sent.url).toBe('https://example.com/donetick/eapi/v1/chore');
    expect('dueDate' in sent.body).toBe(false);
    expect(out.url).toBe('https://example.com/donetick/chores/3');
  });

  it('reports a rejected token as auth and an answer without an id as a server error', async () => {
    await expect(donetick.create(ctx(proxyApi(() => proxyResponse({ error: 'Invalid API token' }, { status: 401 }))), TASK)).rejects.toMatchObject({ code: 'auth' });
    await expect(donetick.create(ctx(proxyApi(() => proxyResponse({}))), TASK)).rejects.toMatchObject({ code: 'server' });
  });

  it('has no projects and never claims a chore was deleted', async () => {
    const api = proxyApi(() => { throw new Error('no request expected'); });
    expect(await donetick.containers(ctx(api))).toEqual([]);
    expect(await donetick.exists(ctx(api), { taskId: '1' })).toBeNull();
  });
});

describe('Todoist', () => {
  const MOCK = 'http://localhost:18099/todoist/api/v1';

  it('posts to the API address the administrator set, with Todoist priority and due_date', async () => {
    let sent;
    const api = proxyApi((id, url, init) => { sent = { id, url, init }; return proxyResponse({ id: '6Xt0000000000100' }); });
    const out = await todoist.create({ api, origin: 'http://localhost:18099', config: { todoistApiUrl: MOCK } }, TASK);
    expect(sent.id).toBe('todoist');
    expect(sent.url).toBe(`${MOCK}/tasks`);
    expect(JSON.parse(sent.init.body)).toEqual({ content: 'Pay invoice', description: TASK.description, priority: 4, project_id: '2', due_date: '2026-10-20' });
    // No web app link for a server that isn't Todoist's.
    expect(out).toEqual({ taskId: '6Xt0000000000100', url: null });
  });

  it('links to the Todoist web app for the real service', async () => {
    const api = proxyApi(() => proxyResponse({ id: 'abc' }));
    const out = await todoist.create({ api, origin: 'https://api.todoist.com', config: {} }, { ...TASK, containerId: null });
    expect(out.url).toBe('https://app.todoist.com/app/task/abc');
  });

  it('lists projects with the inbox first, following the cursor', async () => {
    const api = proxyApi((id, url) => (url.includes('cursor=c2')
      ? proxyResponse({ results: [{ id: 'in', name: 'Inbox', inbox_project: true }], next_cursor: null })
      : proxyResponse({ results: [{ id: 'w', name: 'Work' }], next_cursor: 'c2' })));
    expect(await todoist.containers({ api, origin: 'https://api.todoist.com', config: {} })).toEqual([{ id: 'in', name: 'Inbox' }, { id: 'w', name: 'Work' }]);
  });

  it('turns a 429 into a rate-limit error with the wait time', async () => {
    const api = proxyApi(() => proxyResponse({ error: 'Too many' }, { status: 429, headers: { 'retry-after': '7' } }));
    const err = await todoist.create({ api, origin: 'https://api.todoist.com', config: {} }, TASK).catch((e) => e);
    expect(err).toMatchObject({ code: 'rate_limited', retryAfter: 7 });
  });
});

// A small CalDAV server: Stalwart's layout, where /.well-known/caldav answers
// 307 (which the proxy can't follow with a PROPFIND body).
function davServer({ puts = [], status = {} } = {}) {
  const ms = (inner) => proxyResponse(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:caldav">${inner}</D:multistatus>`, { status: 207 });
  return proxyApi((id, url, init) => {
    expect(id).toBe('caldav');
    const path = new URL(url).pathname;
    if (status[path]) return proxyResponse('', { status: status[path] });
    if (init.method === 'PUT') { puts.push({ url, init }); return proxyResponse('', { status: 201 }); }
    if (path === '/.well-known/caldav') return { status: 502, ok: false, headers: {}, proxyError: 'redirect_with_body', body: 'The server redirected an upload' };
    if (path === '/') return proxyResponse('', { status: 405 });
    if (path === '/dav/') return proxyResponse('not dav', { status: 200 });
    if (path === '/dav/cal/') {
      return ms('<D:response><D:href>/dav/cal/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav/pal/alice%40example.org/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>');
    }
    if (path === '/dav/pal/alice%40example.org/') {
      return ms('<D:response><D:href>/dav/pal/alice%40example.org/</D:href><D:propstat><D:prop><A:calendar-home-set><D:href>/dav/cal/alice%40example.org/</D:href></A:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>');
    }
    if (path === '/dav/cal/alice%40example.org/') {
      expect(init.headers.Depth).toBe('1');
      return ms('<D:response><D:href>/dav/cal/alice%40example.org/default/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><A:calendar/></D:resourcetype><D:displayname>Calendar</D:displayname><A:supported-calendar-component-set><A:comp name="VEVENT"/><A:comp name="VTODO"/></A:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
        + '<D:response><D:href>/dav/cal/alice%40example.org/tasks/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><A:calendar/></D:resourcetype><D:displayname>Tasks</D:displayname><A:supported-calendar-component-set><A:comp name="VTODO"/></A:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
        + '<D:response><D:href>http://evil.example/dav/x/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><A:calendar/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>');
    }
    return proxyResponse('', { status: 404 });
  });
}

describe('CalDAV', () => {
  const ORIGIN = 'http://localhost:18025';

  it('finds task lists through the principal and calendar home, past a 307 on .well-known', async () => {
    const lists = await discoverTaskLists({ api: davServer(), origin: ORIGIN, config: {} });
    // The list made for tasks comes first; the one on another server is left out.
    expect(lists).toEqual([
      { id: `${ORIGIN}/dav/cal/alice%40example.org/tasks/`, name: 'Tasks' },
      { id: `${ORIGIN}/dav/cal/alice%40example.org/default/`, name: 'Calendar' },
    ]);
  });

  it('stops at a wrong password instead of trying every path', async () => {
    const api = davServer({ status: { '/.well-known/caldav': 401 } });
    await expect(caldav.containers({ api, origin: ORIGIN, config: {} })).rejects.toMatchObject({ code: 'auth' });
    expect(api.calls('proxy.fetch')).toHaveLength(1);
  });

  it('puts a VTODO into the chosen list, never overwriting', async () => {
    const puts = [];
    const api = davServer({ puts });
    const out = await caldav.create({ api, origin: ORIGIN, config: {} }, { ...TASK, containerId: `${ORIGIN}/dav/cal/alice%40example.org/tasks/` });
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toMatch(/^http:\/\/localhost:18025\/dav\/cal\/alice%40example\.org\/tasks\/[0-9a-f]{32}%40bulwark-email-to-task\.ics$/);
    expect(puts[0].init.headers['If-None-Match']).toBe('*');
    expect(puts[0].init.headers['Content-Type']).toMatch(/^text\/calendar/);
    expect(puts[0].init.body).toContain('SUMMARY:Pay invoice');
    expect(puts[0].init.body).toContain('DUE;VALUE=DATE:20261020');
    expect(puts[0].init.body).toContain('PRIORITY:1');
    expect(out.taskId).toBe(puts[0].url);
  });

  it('refuses a list on another server', async () => {
    await expect(caldav.create({ api: davServer(), origin: ORIGIN, config: {} }, { ...TASK, containerId: 'https://other.example/tasks/' })).rejects.toMatchObject({ code: 'no_task_list' });
  });
});

describe('Bulwark tasks', () => {
  it('is available only when the task list can be read', async () => {
    expect(await bulwark.available(fakeApi({ handlers: { 'tasks.list': async () => [] } }))).toBe(true);
    expect(await bulwark.available(fakeApi({ handlers: { 'tasks.list': async () => { throw new Error('tasks.list: no active session'); } } }))).toBe(false);
  });

  it('creates through api.tasks with JSCalendar priority', async () => {
    const api = fakeApi({ handlers: { 'tasks.create': async (input) => ({ id: 'T1', ...input }) } });
    const out = await bulwark.create({ api }, TASK);
    expect(api.calls('tasks.create')[0].args[0]).toEqual({ title: 'Pay invoice', description: TASK.description, due: '2026-10-20', priority: 1 });
    expect(out).toEqual({ taskId: 'T1', url: null });
  });

  it('reports a server without a task calendar and a plugin that stopped it', async () => {
    const noCal = fakeApi({ handlers: { 'tasks.create': async () => { throw new Error('tasks.create: there is no calendar to put it in'); } } });
    await expect(bulwark.create({ api: noCal }, TASK)).rejects.toMatchObject({ code: 'no_task_list' });
    const stopped = fakeApi({ handlers: { 'tasks.create': async () => null } });
    await expect(bulwark.create({ api: stopped }, TASK)).rejects.toMatchObject({ code: 'stopped' });
  });
});

describe('errors', () => {
  it.each([
    [401, 'auth'], [403, 'forbidden'], [404, 'not_found'], [412, 'conflict'], [413, 'too_large'],
    [429, 'rate_limited'], [507, 'quota'], [504, 'timeout'], [400, 'bad_request'], [500, 'server'],
  ])('HTTP %i is %s', (status, code) => {
    expect(errorForResponse({ status, ok: false, headers: {} }).code).toBe(code);
  });

  it('tells the proxy\'s own refusals from the server\'s answers', () => {
    expect(errorForResponse({ status: 404, ok: false, headers: {}, proxyError: 'no_credential' }).code).toBe('not_connected');
    expect(errorForResponse({ status: 429, ok: false, headers: { 'retry-after': '12' }, proxyError: 'rate_limited' })).toMatchObject({ code: 'rate_limited', retryAfter: 12 });
    expect(errorForResponse({ status: 403, ok: false, headers: {}, proxyError: 'blocked_address' }).code).toBe('blocked');
    expect(errorForResponse({ status: 504, ok: false, headers: {}, proxyError: 'timeout' }).code).toBe('timeout');
  });

  it('maps thrown host errors', () => {
    expect(toTaskError(new Error('API call proxy.fetch timed out after 30s')).code).toBe('timeout');
    expect(toTaskError(new Error('Plugin "x" lacks permission "tasks:write"')).code).toBe('permission');
  });

  it('gives plain words, never the raw error', async () => {
    const t = (key, vars) => `${key} ${JSON.stringify(vars)}`;
    const api = proxyApi(() => { throw new Error('TypeError: x is undefined at foo.js:1'); });
    const err = await request(api, 'vikunja', 'https://x/').catch((e) => e);
    expect(errorText(t, err, 'Vikunja')).toBe('error.unknown {"service":"Vikunja","seconds":60}');
    expect(errorText(t, errorForResponse({ status: 429, ok: false, headers: {} }), 'Todoist')).toMatch(/^error\.rate_limited_later/);
  });
});
