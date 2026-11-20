import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { describeAction, performAction, undoAction } from '../src/lib/actions.js';
import { runTool } from '../src/lib/tools.js';
import { actionCaps } from '../src/lib/areas/actions.js';
import { findAccount, messageRef, parseMessageRef } from '../src/lib/accounts.js';

// Team and shared mailboxes (#39). The webmail names another account's
// folders and calendars "<accountId>:<id>", and the same message id can name
// different messages in two accounts, so every lookup and action has to say
// which account it means.

const OWN = { accountId: 'a', name: 'alice@example.org', kind: 'personal', isReadOnly: false, isOpen: true };
const TEAM = { accountId: 'g', name: 'info@example.org', kind: 'group', isReadOnly: false, isOpen: false };
const FOLDERS = [
  { id: 'inbox', name: 'Inbox', role: 'inbox' },
  { id: 'archive', name: 'Archive', role: 'archive' },
  { id: 'g:inbox', name: 'Inbox', role: 'inbox' },
  { id: 'g:sent', name: 'Sent', role: 'sent' },
  { id: 'g:clients', name: 'Clients', role: null },
];
// Message "1" exists in both accounts: the user's own and the team's.
const OWN_MESSAGE = { id: '1', accountId: 'a', subject: 'Own invoice', mailboxIds: ['inbox'], isRead: false, isFlagged: false, keywords: [] };
const TEAM_MESSAGE = { id: '1', accountId: 'g', subject: 'Team request', mailboxIds: ['inbox'], isRead: false, isFlagged: true, keywords: [] };

function apiWith({ open = OWN, handlers = {} } = {}) {
  return fakeApi({
    translations: allStrings(),
    timeZone: 'UTC',
    hostFeatures: {},
    handlers: {
      'user.getMailAccounts': async () => [OWN, TEAM].map((a) => ({ ...a, isOpen: a.accountId === open.accountId })),
      'mailboxes.list': async () => FOLDERS,
      'email.search': async (q) => [{ id: '1', subject: q.mailboxId?.startsWith('g:') ? 'Team request' : 'Own invoice', from: [{ email: 'bob@example.org' }], receivedAt: '2026-11-18T09:00:00Z' }],
      'email.get': async (id, accountId) => (id !== '1' ? null : accountId === 'g' ? TEAM_MESSAGE : OWN_MESSAGE),
      'keywords.list': async () => [{ id: 'red', label: 'Urgent' }],
      ...handlers,
    },
  });
}

describe('message references', () => {
  it('put the account in front for another account, and read it back', () => {
    expect(messageRef('1', 'g')).toBe('g:1');
    expect(messageRef('1')).toBe('1');
    expect(parseMessageRef('g:1')).toEqual({ id: '1', accountId: 'g' });
    expect(parseMessageRef(' 1 ')).toEqual({ id: '1' });
  });

  it('find an account by its name, its address or the part before the @', () => {
    expect(findAccount([OWN, TEAM], 'INFO@example.org')).toBe(TEAM);
    expect(findAccount([OWN, TEAM], 'info')).toBe(TEAM);
    expect(findAccount([OWN, TEAM], 'example.org')).toBeNull();
  });
});

describe('searching a team mailbox', () => {
  it('searches the named account\'s inbox and lists its messages with the account', async () => {
    const api = apiWith();
    const { text } = await runTool(api, 'search_mail', { text: 'request', account: 'info@example.org' });
    expect(api.calls('email.search').map((c) => c.args[0])).toEqual([{ text: 'request', mailboxId: 'g:inbox', limit: 5 }]);
    expect(text).toContain('Messages in info@example.org, folder Inbox matching');
    expect(text).toContain('- id g:1 |');
  });

  it('searches another folder of it by name', async () => {
    const api = apiWith();
    await runTool(api, 'search_mail', { text: 'x', account: 'info', folder: 'clients' });
    expect(api.calls('email.search')[0].args[0].mailboxId).toBe('g:clients');
    await expect(runTool(api, 'search_mail', { text: 'x', account: 'info', folder: 'Archive' })).rejects.toThrow(/no folder "Archive" in info@example.org; the folders are: Inbox, Sent, Clients/);
  });

  it('searches the account of the open folder unless told otherwise', async () => {
    const api = apiWith({ open: TEAM });
    const { text } = await runTool(api, 'search_mail', { text: 'request' });
    expect(api.calls('email.search')[0].args[0].mailboxId).toBe('g:inbox');
    expect(text).toContain('give account "alice@example.org" for the user\'s own mail');
    await runTool(api, 'search_mail', { text: 'request', account: 'alice@example.org' });
    expect(api.calls('email.search')[1].args[0]).toEqual({ text: 'request', limit: 5 });
  });

  it('searches all of the user\'s own mail as before, and names the accounts when one is unknown', async () => {
    const api = apiWith();
    const { text } = await runTool(api, 'search_mail', { text: 'invoice' });
    expect(api.calls('email.search')[0].args[0]).toEqual({ text: 'invoice', limit: 5 });
    expect(text).toContain('- id 1 |');
    await expect(runTool(api, 'search_mail', { text: 'x', account: 'sales' })).rejects.toThrow(/no account "sales"; the user's accounts are: alice@example.org, info@example.org/);
  });

  it('reads a found message from its account', async () => {
    const api = apiWith();
    const text = await runTool(api, 'read_message', { id: 'g:1' });
    expect(api.calls('email.get').map((c) => c.args)).toEqual([['1', 'g']]);
    expect(text).toContain('Subject: Team request');
  });
});

describe('the calendar lookup', () => {
  it('names each event\'s calendar, with the account for a team calendar', async () => {
    const api = apiWith({ handlers: {
      'calendar.getEvents': async () => [
        { title: 'Standup', calendarId: 'cal', utcStart: '2026-11-18T08:00:00Z', utcEnd: '2026-11-18T08:15:00Z' },
        { title: 'Fair', calendarId: 'g:cal', start: '2026-11-19', isAllDay: true },
      ],
      'calendar.listCalendars': async () => [{ id: 'cal', name: 'Calendar' }, { id: 'g:cal', name: 'Events' }],
    } });
    const { text } = await runTool(api, 'check_calendar', { from: '2026-11-18', to: '2026-11-19' });
    expect(text).toContain('Standup [Calendar]');
    expect(text).toContain('2026-11-19 (all day): Fair [Events of info@example.org]');
  });
});

describe('actions on a team mailbox\'s message', () => {
  it('refuses archive and move before asking the user, with words for the model', async () => {
    const api = apiWith();
    await expect(describeAction(api, 'archive_message', { id: 'g:1' })).rejects.toThrow(/"Team request" is in a team or shared mailbox; archive_message works only for the user's own mail/);
    await expect(describeAction(api, 'move_message', { id: 'g:1', folder: 'Archive' })).rejects.toThrow(/team or shared mailbox; move_message/);
    expect(api.calls('email.archive')).toEqual([]);
    expect(api.calls('email.move')).toEqual([]);
  });

  it('still archives the user\'s own message, and moves only into the user\'s own folders', async () => {
    const api = apiWith();
    await performAction(api, (await describeAction(api, 'archive_message', { id: '1' })).plan);
    expect(api.calls('email.archive').map((c) => c.args)).toEqual([[['1']]]);
    await expect(describeAction(api, 'move_message', { id: '1', folder: 'Clients' })).rejects.toThrow(/the folders are: Inbox, Archive$/);
  });

  it('marks the message in its own account, and undoes it there', async () => {
    const api = apiWith();
    const { plan } = await describeAction(api, 'mark_message', { id: 'g:1', read: true });
    const done = await performAction(api, plan);
    expect(api.calls('email.setKeyword').map((c) => c.args)).toEqual([['1', '$seen', 'g']]);
    await undoAction(api, done.undo);
    expect(api.calls('email.removeKeyword').map((c) => c.args)).toEqual([['1', '$seen', 'g']]);
  });

  it('tags the message in its own account', async () => {
    const api = apiWith();
    const ctx = { actions: 'manual', lookups: true, config: {}, prefs: {}, doCaps: actionCaps(api) };
    const { plan } = await describeAction(api, 'tag_message', { id: 'g:1', tag: 'Urgent' }, ctx);
    const done = await performAction(api, plan);
    expect(api.calls('email.updateKeywords').map((c) => c.args)).toEqual([['1', { '$label:red': true }, 'g']]);
    await undoAction(api, done.undo);
    expect(api.calls('email.updateKeywords').at(-1).args).toEqual(['1', { '$label:red': false }, 'g']);
  });
});
