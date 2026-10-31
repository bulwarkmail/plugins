// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { SlotPropsContext } from '@plugin-host/ui';
import { TaskDialog } from '../src/ui/task-dialog.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { locales } = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

const EMAIL = { id: 'M1', subject: 'Re: Quarterly report', from: [{ name: 'Carol', email: 'carol@example.org' }], receivedAt: '2026-10-14T09:00:00', text: 'Could you send the report by Friday?', headers: {} };
const EMAIL2 = { id: 'M2', subject: 'Contract draft', from: [{ name: 'Bob', email: 'bob@example.org' }], receivedAt: '2026-10-14T10:00:00', text: 'Comments until 2026-11-02 please.', headers: {} };

function makeApi({ accounts = [{ credentialId: 'vikunja', origin: 'http://localhost:18456', connected: true }], fetch, locale = 'en', connect } = {}) {
  return fakeApi({
    locale,
    translations: locales,
    handlers: {
      'email.get': async (id) => ({ M1: EMAIL, M2: EMAIL2 })[id] ?? null,
      'proxy.accounts': async () => (typeof accounts === 'function' ? accounts() : accounts),
      'admin.getAllConfig': async () => ({}),
      'tasks.list': async () => { throw new Error('no calendars'); },
      'proxy.fetch': fetch ?? (async (id, url) => (url.includes('/projects?') ? proxyResponse([{ id: 2, title: 'Bulwark inbox' }]) : proxyResponse({ id: 77 }))),
      'proxy.connect': connect ?? (async () => ({ connected: true })),
      'email.setKeyword': async () => {},
    },
  });
}

async function open(api, emailIds = ['M1']) {
  const onResult = vi.fn();
  await act(async () => { render(React.createElement(TaskDialog, { api, emailIds, onResult })); });
  await screen.findByLabelText('Title');
  return onResult;
}

describe('TaskDialog', () => {
  it('is filled in from the message and creates the task in Vikunja', async () => {
    const api = makeApi();
    const onResult = await open(api);
    expect(screen.getByLabelText('Title').value).toBe('Quarterly report');
    expect(screen.getByLabelText('Due date').value).toBe('2026-10-16');
    expect(screen.getByText('Found in the message: “by Friday”')).toBeTruthy();
    expect(screen.getByLabelText('Description').value).toContain('/mail/message/M1');
    await screen.findByRole('option', { name: 'Bulwark inbox' });
    // Bulwark tasks are not offered: this server has none.
    expect(screen.queryByRole('option', { name: 'Tasks (Bulwark)' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Send the report' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create task' })); });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ created: ['M1'] }));
    const put = api.calls('proxy.fetch').find((c) => c.args[2]?.method === 'PUT');
    expect(put.args[1]).toBe('http://localhost:18456/api/v1/projects/2/tasks');
    expect(JSON.parse(put.args[2].body).title).toBe('Send the report');
    expect(api.calls('toast.success')[0].args[0]).toBe('Task created in Vikunja');
  });

  it('asks to connect a service that is not connected, and then loads its projects', async () => {
    let accounts = [];
    const api = makeApi({
      accounts: () => accounts,
      connect: async () => { accounts = [{ credentialId: 'todoist', origin: 'http://localhost:18099', connected: true }]; return { connected: true }; },
      fetch: async () => proxyResponse({ results: [{ id: 'in', name: 'Inbox', inbox_project: true }], next_cursor: null }),
    });
    await open(api);
    fireEvent.change(screen.getByLabelText('Add to'), { target: { value: 'todoist' } });
    const button = await screen.findByRole('button', { name: 'Connect Todoist' });
    expect(screen.getByRole('button', { name: 'Create task' }).disabled).toBe(true);
    await act(async () => { fireEvent.click(button); });
    expect(api.calls('proxy.connect')[0].args).toEqual(['todoist', { mode: 'password', server: 'https://api.todoist.com' }]);
    expect(await screen.findByRole('option', { name: 'Inbox' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Todoist' })).toBeNull();
  });

  it('creates a Donetick chore without a project or priority field', async () => {
    const api = makeApi({
      accounts: [
        { credentialId: 'vikunja', origin: 'http://localhost:18456', connected: true },
        { credentialId: 'donetick', origin: 'http://localhost:18021', connected: true },
      ],
      fetch: async (id, url) => (url.includes('/projects?') ? proxyResponse([{ id: 2, title: 'Bulwark inbox' }]) : proxyResponse({ id: 5 }, { status: 201 })),
    });
    const onResult = await open(api);
    // Vikunja first: it has a priority.
    await screen.findByRole('option', { name: 'Bulwark inbox' });
    expect(screen.getByLabelText('Priority')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add to'), { target: { value: 'donetick' } });
    await waitFor(() => expect(screen.queryByLabelText('Priority')).toBeNull());
    expect(screen.queryByLabelText('Project')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create task' })); });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ created: ['M1'] }));
    const post = api.calls('proxy.fetch').find((c) => c.args[2]?.method === 'POST');
    expect(post.args.slice(0, 2)).toEqual(['donetick', 'http://localhost:18021/eapi/v1/chore']);
    expect(JSON.parse(post.args[2].body).name).toBe('Quarterly report');
    expect(api.calls('toast.success')[0].args[0]).toBe('Task created in Donetick');
  });

  it('shows a rejected token in plain words with a way to connect again', async () => {
    const api = makeApi({
      fetch: async (id, url) => (url.includes('/projects?') ? proxyResponse([{ id: 2, title: 'P' }]) : proxyResponse({ message: 'invalid token' }, { status: 401 })),
    });
    const onResult = await open(api);
    await screen.findByRole('option', { name: 'P' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create task' })); });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Vikunja did not accept the saved password or token');
    expect(alert.textContent).not.toMatch(/401|Error|stack/);
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeTruthy();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('creates with Enter in the title field (the sandbox has no form submission)', async () => {
    const api = makeApi();
    const onResult = await open(api);
    await screen.findByRole('option', { name: 'Bulwark inbox' });
    await act(async () => { fireEvent.keyDown(screen.getByLabelText('Title'), { key: 'Enter' }); });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ created: ['M1'] }));
  });

  it('asks for a task list address when CalDAV has none, and does not create meanwhile', async () => {
    const api = makeApi({
      accounts: [{ credentialId: 'caldav', origin: 'http://localhost:18025', connected: true }],
      fetch: async () => proxyResponse('', { status: 404 }),
    });
    await open(api);
    fireEvent.change(screen.getByLabelText('Add to'), { target: { value: 'caldav' } });
    expect(await screen.findByText(/No task list was found on this server/)).toBeTruthy();
    expect(screen.getByLabelText('Task list address')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create task' }).disabled).toBe(true);
  });

  it('speaks German', async () => {
    const api = makeApi({ locale: 'de' });
    const onResult = vi.fn();
    await act(async () => { render(React.createElement(TaskDialog, { api, emailIds: ['M1'], onResult })); });
    expect(await screen.findByLabelText('Titel')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aufgabe erstellen' })).toBeTruthy();
    expect(screen.getByLabelText('Fälligkeitsdatum').value).toBe('2026-10-16');
  });

  it('hands Cancel and Create to the host footer instead of drawing them', async () => {
    const api = makeApi();
    const setDialogButtons = vi.fn();
    const onResult = vi.fn();
    await act(async () => {
      render(React.createElement(SlotPropsContext.Provider, { value: { setDialogButtons } },
        React.createElement(TaskDialog, { api, emailIds: ['M1'], onResult })));
    });
    await screen.findByRole('option', { name: 'Bulwark inbox' });
    // Nothing drawn in the frame: the host draws the footer.
    expect(screen.queryByRole('button', { name: 'Create task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    // While loading, Create was there but disabled; now it can be used.
    expect(setDialogButtons.mock.calls[0][0][1]).toMatchObject({ id: 'create', disabled: true });
    const last = setDialogButtons.mock.calls.at(-1)[0];
    expect(last.map((b) => [b.id, b.label, b.variant])).toEqual([['cancel', 'Cancel', 'secondary'], ['create', 'Create task', 'primary']]);
    expect(last[1].disabled).toBeFalsy();
  });

  it('closes with nothing on Cancel', async () => {
    const api = makeApi();
    const onResult = await open(api);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onResult).toHaveBeenCalledWith(null);
    expect(api.calls('proxy.fetch').some((c) => c.args[2]?.method === 'PUT')).toBe(false);
  });

  it('creates a task only for the messages left ticked', async () => {
    const api = makeApi();
    const onResult = vi.fn();
    await act(async () => { render(React.createElement(TaskDialog, { api, emailIds: ['M1', 'M2'], onResult })); });
    await screen.findByRole('option', { name: 'Bulwark inbox' });
    expect(screen.getByLabelText('Due date for “Contract draft”').value).toBe('2026-11-02');
    const box = screen.getByRole('checkbox', { name: 'Create a task for “Re: Quarterly report”' });
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Create 2 tasks' })).toBeTruthy();
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).toBe('false');
    // An unticked message has no fields to fill in.
    expect(screen.queryByLabelText('Task title for “Re: Quarterly report”')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create task' })); });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ created: ['M2'] }));
    const puts = api.calls('proxy.fetch').filter((c) => c.args[2]?.method === 'PUT');
    expect(puts.map((c) => JSON.parse(c.args[2].body).title)).toEqual(['Contract draft']);
  });
});
