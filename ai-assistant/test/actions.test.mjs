import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { allStrings } from '../src/lib/i18n.js';
import {
  actionToolsFor, describeAction, effectiveActionMode, findFolder, performAction, undoAction,
} from '../src/lib/actions.js';

// What the assistant may do for the user: offered by mode, checked and
// described before it happens, carried out through the api, taken back.

const MESSAGE = { id: 'M1', subject: 'Invoice 42', mailboxIds: ['inbox-id'], isRead: false, isFlagged: true };
const FOLDERS = [
  { id: 'inbox-id', name: 'Inbox', role: 'inbox' },
  { id: 'archive-id', name: 'Archive', role: 'archive' },
  { id: 'proj-id', name: 'Projects 2026', role: null },
  { id: 'trash-id', name: 'Deleted Items', role: 'trash' },
];

const apiWith = (handlers = {}) => fakeApi({
  translations: allStrings(),
  handlers: {
    'email.get': async (id) => (id === 'M1' ? MESSAGE : null),
    'mailboxes.list': async () => FOLDERS,
    ...handlers,
  },
});

describe('which actions are offered', () => {
  it('none when off; a reply only next to an open message; a new message not from the composer', () => {
    expect(actionToolsFor({ actions: 'off' })).toEqual([]);
    expect(actionToolsFor({})).toEqual([]);
    const names = (ctx) => actionToolsFor(ctx).map((t) => t.name);
    expect(names({ actions: 'manual' })).toEqual(['archive_message', 'move_message', 'mark_message', 'create_event', 'create_task', 'create_contact', 'draft_email']);
    expect(names({ actions: 'auto', openEmailId: 'M1' })).toContain('draft_reply');
    expect(names({ actions: 'auto', mode: 'composer' })).not.toContain('draft_email');
    for (const tool of actionToolsFor({ actions: 'auto', openEmailId: 'M1' })) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('in the mode the user chose, at most what the administrator allows', () => {
    expect(effectiveActionMode({}, {})).toBe('off');
    expect(effectiveActionMode({}, { actions: 'auto' })).toBe('auto');
    expect(effectiveActionMode({ actions: 'manual' }, { actions: 'auto' })).toBe('manual');
    expect(effectiveActionMode({ actions: 'off' }, { actions: 'manual' })).toBe('off');
    expect(effectiveActionMode({ actions: 'auto' }, { actions: 'nonsense' })).toBe('off');
  });
});

describe('finding a folder', () => {
  it('by role, by name, or by a part that fits one folder only', () => {
    expect(findFolder(FOLDERS, 'archive').id).toBe('archive-id');
    expect(findFolder(FOLDERS, 'Trash').id).toBe('trash-id');
    expect(findFolder(FOLDERS, 'deleted items').id).toBe('trash-id');
    expect(findFolder(FOLDERS, 'projects').id).toBe('proj-id');
    expect(findFolder(FOLDERS, 'i')).toBeNull();
    expect(findFolder(FOLDERS, '')).toBeNull();
  });
});

describe('describing an action', () => {
  it('names the message and the folder in the user\'s language', async () => {
    const api = apiWith();
    expect((await describeAction(api, 'archive_message', { id: 'M1' })).summary).toBe('Archive “Invoice 42”');
    expect((await describeAction(api, 'move_message', { id: 'M1', folder: 'projects' })).summary).toBe('Move “Invoice 42” to Projects 2026');
    expect((await describeAction(api, 'mark_message', { id: 'M1', read: true, starred: false })).summary)
      .toBe('Mark “Invoice 42” as read · Remove the star from “Invoice 42”');
    api.setLocale('de');
    expect((await describeAction(api, 'archive_message', { id: 'M1' })).summary).toBe('„Invoice 42“ archivieren');
  });

  it('turns wrong arguments into errors the model can act on', async () => {
    const api = apiWith();
    await expect(describeAction(api, 'archive_message', { id: 'nope' })).rejects.toThrow(/no message with that id/);
    await expect(describeAction(api, 'move_message', { id: 'M1', folder: 'Holidays' })).rejects.toThrow(/the folders are: Inbox, Archive, Projects 2026, Deleted Items/);
    await expect(describeAction(api, 'mark_message', { id: 'M1' })).rejects.toThrow(/give read, starred or both/);
    await expect(describeAction(api, 'create_event', { title: 'X', start: 'next tuesday' })).rejects.toThrow(/start must look like/);
    await expect(describeAction(api, 'create_event', { title: 'X', start: '2026-11-17T10:00', end: '2026-11-17' })).rejects.toThrow(/same form as start/);
    await expect(describeAction(api, 'create_contact', { name: 'Anna', email: 'anna' })).rejects.toThrow(/not an address/);
    await expect(describeAction(api, 'draft_reply', { text: 'Hi' }, {})).rejects.toThrow(/only for the open message/);
    await expect(describeAction(api, 'draft_email', { to: ['Anna'], subject: 's', body: 'b' })).rejects.toThrow(/"Anna" is not an address/);
  });

  it('plans a timed event of one hour, an all-day event up to the day after its last day', async () => {
    const api = apiWith();
    const timed = await describeAction(api, 'create_event', { title: 'Formnext', start: '2026-11-17T09:00', location: 'Frankfurt' });
    expect(timed.plan.input).toEqual({ title: 'Formnext', start: '2026-11-17T09:00', isAllDay: false, duration: 'PT1H', location: 'Frankfurt' });
    expect(timed.summary).toBe('Add “Formnext” to your calendar: Tue, Nov 17, 2026, 09:00');
    const allDay = await describeAction(api, 'create_event', { title: 'Formnext', start: '2026-11-17', end: '2026-11-20' });
    expect(allDay.plan.input).toEqual({ title: 'Formnext', start: '2026-11-17', isAllDay: true, end: '2026-11-21' });
    expect(allDay.summary).toBe('Add “Formnext” to your calendar: Tue, Nov 17, 2026 – Fri, Nov 20, 2026');
  });
});

describe('carrying out and taking back', () => {
  it('archives, and moves the message back on undo', async () => {
    const api = apiWith();
    const { plan } = await describeAction(api, 'archive_message', { id: 'M1' });
    const done = await performAction(api, plan);
    expect(api.calls('email.archive').map((c) => c.args)).toEqual([[['M1']]]);
    expect(done.text).toContain('archived');
    await undoAction(api, done.undo);
    expect(api.calls('email.move').map((c) => c.args)).toEqual([[['M1'], 'inbox-id']]);
  });

  it('moves to the folder found', async () => {
    const api = apiWith();
    const { plan } = await describeAction(api, 'move_message', { id: 'M1', folder: 'trash' });
    await performAction(api, plan);
    expect(api.calls('email.move').map((c) => c.args)).toEqual([[['M1'], 'trash-id']]);
  });

  it('marks, and restores what was there before on undo', async () => {
    const api = apiWith();
    const { plan } = await describeAction(api, 'mark_message', { id: 'M1', read: true, starred: false });
    const done = await performAction(api, plan);
    expect(api.calls('email.setKeyword').map((c) => c.args)).toEqual([['M1', '$seen']]);
    expect(api.calls('email.removeKeyword').map((c) => c.args)).toEqual([['M1', '$flagged']]);
    await undoAction(api, done.undo);
    // It was unread and starred.
    expect(api.calls('email.removeKeyword').map((c) => c.args).at(-1)).toEqual(['M1', '$seen']);
    expect(api.calls('email.setKeyword').map((c) => c.args).at(-1)).toEqual(['M1', '$flagged']);
  });

  it('creates an event, a task and a contact, and deletes each on undo', async () => {
    const api = apiWith({
      'calendar.createEvent': async () => ({ id: 'ev1' }),
      'tasks.create': async () => ({ id: 'task1' }),
      'contacts.create': async (card) => ({ ...card, id: 'card1' }),
    });
    for (const [name, args] of [
      ['create_event', { title: 'Call', start: '2026-11-03T15:00', end: '2026-11-03T15:30' }],
      ['create_task', { title: 'Pay invoice 42', due: '2026-11-01' }],
      ['create_contact', { name: 'Anna Berg', email: 'anna@example.org', company: 'ACME' }],
    ]) {
      const { plan } = await describeAction(api, name, args);
      const done = await performAction(api, plan);
      await undoAction(api, done.undo);
    }
    expect(api.calls('calendar.createEvent')[0].args[0]).toEqual({ title: 'Call', start: '2026-11-03T15:00', end: '2026-11-03T15:30', isAllDay: false });
    expect(api.calls('tasks.create')[0].args[0]).toEqual({ title: 'Pay invoice 42', due: '2026-11-01' });
    expect(api.calls('contacts.create')[0].args[0]).toMatchObject({
      name: { full: 'Anna Berg', components: [{ kind: 'given', value: 'Anna' }, { kind: 'surname', value: 'Berg' }] },
      emails: { e1: { address: 'anna@example.org' } },
      organizations: { o1: { name: 'ACME' } },
    });
    expect(api.calls('calendar.deleteEvent')[0].args).toEqual(['ev1']);
    expect(api.calls('tasks.delete')[0].args).toEqual(['task1']);
    expect(api.calls('contacts.remove')[0].args).toEqual(['card1']);
  });

  it('opens a reply or a new message in the composer and sends nothing', async () => {
    const api = apiWith({ 'compose.reply': async () => true, 'compose.open': async () => 'opened' });
    const reply = await describeAction(api, 'draft_reply', { text: 'Thanks, paid.', all: true }, { openEmailId: 'M1' });
    expect(reply.summary).toBe('Open a reply to all for “Invoice 42” with the drafted text');
    const done = await performAction(api, reply.plan);
    expect(done.undo).toBeNull();
    expect(api.calls('compose.reply')[0].args).toEqual(['M1', { text: 'Thanks, paid.', all: true }]);
    const mail = await describeAction(api, 'draft_email', { to: 'anna@example.org; ben@example.org', subject: 'Slides', body: 'Here they are.' });
    await performAction(api, mail.plan);
    expect(api.calls('compose.open')[0].args).toEqual([{ to: ['anna@example.org', 'ben@example.org'], subject: 'Slides', body: 'Here they are.' }]);
    expect(api.calls().some((c) => /send|submit|destroy|delete/i.test(c.method) && !c.method.startsWith('calendar') && !c.method.startsWith('tasks'))).toBe(false);
  });

  it('fails when the composer did not open', async () => {
    const api = apiWith({ 'compose.reply': async () => false });
    const { plan } = await describeAction(api, 'draft_reply', { text: 'Hi' }, { openEmailId: 'M1' });
    await expect(performAction(api, plan)).rejects.toThrow(/did not open/);
  });
});
