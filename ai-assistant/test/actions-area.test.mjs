import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { actionToolsFor, describeAction, performAction, undoAction } from '../src/lib/actions.js';
import { runTool, toolsFor } from '../src/lib/tools.js';
import { AREAS } from '../src/lib/areas/index.js';
import { actionCaps, zonedInstant } from '../src/lib/areas/actions.js';

// The actions area (package C): answer invitations, change and delete
// events, tags, out-of-office, filters, many messages at once, settings and
// contacts. Offered only where the admin, the user and the webmail allow;
// the risky ones always ask first; each one undoes through the host's token
// or by writing the old values back.

const FEATURES = { answerInvitation: true, filterRules: true, batchMail: true, changeSettings: true };
const MESSAGE = { id: 'M1', subject: 'Team offsite', from: [{ name: 'Aa Bob', email: 'bob@example.org' }], keywords: ['$seen'], mailboxIds: ['inbox'] };
const FOLDERS = [
  { id: 'inbox', name: 'Inbox', role: 'inbox' },
  { id: 'news', name: 'Newsletters', role: null },
  { id: 'trash', name: 'Trash', role: 'trash' },
];
const TAGS = [{ id: 'red', label: 'Urgent', color: 'red' }, { id: 'q3', label: 'Q3 invoices', color: 'blue' }];
const EVENT = { id: 'E1', uid: 'u1', title: 'Dentist', description: '', start: '2026-11-03T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', isAllDay: false, location: 'Main St', participants: [], isRecurring: false };
const VACATION = { isEnabled: false, subject: 'Old', textBody: 'Away', htmlBody: '', fromDate: null, toDate: null, forwardActive: false };

function apiWith(handlers = {}, { hostFeatures = FEATURES, locale = 'en' } = {}) {
  return fakeApi({
    translations: allStrings(),
    locale,
    dateLocale: 'en-GB',
    timeFormat: '24h',
    timeZone: 'Europe/Berlin',
    hostFeatures,
    handlers: {
      'email.get': async (id) => (id === 'M1' ? MESSAGE : id.startsWith('B') ? { id, subject: `Subject ${id}` } : null),
      'mailboxes.list': async () => FOLDERS,
      'keywords.list': async () => TAGS,
      'calendar.getEvent': async (id) => (id === 'E1' ? EVENT : null),
      'vacation.get': async () => VACATION,
      'vacation.set': async (input) => ({ ...VACATION, ...input }),
      'user.getIdentities': async () => [{ email: 'alice@example.org' }],
      ...handlers,
    },
  });
}

const ctxFor = (api, extra = {}) => ({
  actions: 'manual', lookups: true, config: {}, prefs: {}, zone: 'Europe/Berlin',
  doCaps: actionCaps(api), doVacationKnown: true, ...extra,
});
const names = (ctx) => actionToolsFor(ctx).map((t) => t.name);
const lookups = (ctx) => toolsFor(ctx).map((t) => t.name);
const writes = (api) => api.calls().filter((c) => /\.(respond|updateEvent|deleteEvent|updateKeywords|set|create|batch|setSettings|update|move|archive|setKeyword|removeKeyword|open|reply|send)$/.test(c.method));

/** describe, then perform, as the panel does after the user's OK. */
async function run(api, name, args, ctx) {
  const described = await describeAction(api, name, args, ctx ?? ctxFor(api));
  const done = await performAction(api, described.plan);
  return { ...described, done };
}

const NEW_ACTIONS = ['answer_invitation', 'update_event', 'delete_event', 'tag_message', 'untag_message', 'set_vacation', 'turn_off_vacation', 'create_filter', 'batch_messages', 'update_contact'];

describe('which of the new actions are offered', () => {
  it('all of them with actions on and a webmail that has the calls; settings changes stay off', () => {
    const api = apiWith();
    const offered = names(ctxFor(api));
    for (const name of NEW_ACTIONS) expect(offered, name).toContain(name);
    expect(offered).not.toContain('change_setting');
    expect(lookups(ctxFor(api))).toEqual(expect.arrayContaining(['get_vacation', 'list_filters']));
  });

  it('none with actions off or the area switched off by the admin', () => {
    const api = apiWith();
    expect(names(ctxFor(api, { actions: 'off' }))).toEqual([]);
    const blocked = names(ctxFor(api, { config: { allowMoreActions: false } }));
    for (const name of NEW_ACTIONS) expect(blocked).not.toContain(name);
    expect(lookups(ctxFor(api, { config: { allowMoreActions: false } }))).not.toContain('list_filters');
    expect(lookups(ctxFor(api, { lookups: false }))).not.toContain('get_vacation');
  });

  it('not those whose host call an older webmail lacks', () => {
    const api = apiWith({}, { hostFeatures: null });
    const ctx = ctxFor(api, { doVacationKnown: false });
    const offered = names(ctx);
    for (const name of ['answer_invitation', 'set_vacation', 'turn_off_vacation', 'create_filter', 'batch_messages', 'change_setting']) expect(offered, name).not.toContain(name);
    expect(lookups(ctx)).not.toContain('list_filters');
    expect(lookups(ctx)).not.toContain('get_vacation');
    // These use calls webmail 1.17 already has.
    expect(offered).toEqual(expect.arrayContaining(['update_event', 'tag_message', 'update_contact']));
    // Each flag on its own.
    for (const [flag, action] of [['answerInvitation', 'answer_invitation'], ['filterRules', 'create_filter'], ['batchMail', 'batch_messages']]) {
      const one = apiWith({}, { hostFeatures: { ...FEATURES, [flag]: false } });
      expect(names(ctxFor(one)), flag).not.toContain(action);
    }
  });

  it('delete_event only where the webmail can undo it', () => {
    const base = apiWith();
    const calendar = new Proxy({}, { get: (_t, m) => (m === 'undoDelete' ? undefined : base.calendar[m]) });
    const api = new Proxy(base, { get: (target, key) => (key === 'calendar' ? calendar : target[key]) });
    expect(names(ctxFor(api))).not.toContain('delete_event');
    expect(names(ctxFor(api))).toContain('update_event');
  });

  it('the out-of-office only where the webmail says whether it forwards mail', () => {
    const api = apiWith();
    expect(names(ctxFor(api, { doVacationKnown: false }))).not.toContain('set_vacation');
    expect(names(ctxFor(api, { doVacationKnown: false }))).not.toContain('turn_off_vacation');
  });

  it('per the user\'s switch', () => {
    const api = apiWith();
    const off = names(ctxFor(api, { prefs: { doActions: { filters: false, tags: false } } }));
    expect(off).not.toContain('create_filter');
    expect(off).not.toContain('tag_message');
    expect(off).toContain('batch_messages');
  });

  it('settings changes only when the admin allows them, the user turned them on and the webmail offers them', () => {
    const api = apiWith();
    const on = { config: { allowSettingsChanges: true }, prefs: { doActions: { settings: true } } };
    expect(names(ctxFor(api, on))).toContain('change_setting');
    expect(names(ctxFor(api, { ...on, config: {} }))).not.toContain('change_setting');
    expect(names(ctxFor(api, { ...on, prefs: {} }))).not.toContain('change_setting');
    expect(names(ctxFor(api, { ...on, config: { allowSettingsChanges: true, allowMoreActions: false } }))).not.toContain('change_setting');
    const old = apiWith({}, { hostFeatures: { ...FEATURES, changeSettings: false } });
    expect(names(ctxFor(old, on))).not.toContain('change_setting');
  });

  it('never as a forwarding tool, and no filter action that sends mail away', () => {
    const api = apiWith();
    const tools = [...toolsFor(ctxFor(api)), ...actionToolsFor(ctxFor(api, { config: { allowSettingsChanges: true }, prefs: { doActions: { settings: true } } }))];
    expect(tools.map((t) => t.name).filter((n) => /forward|redirect|share/i.test(n))).toEqual([]);
    const filter = tools.find((t) => t.name === 'create_filter');
    expect(filter.parameters.properties.actions.items.properties.type.enum).toEqual(['move', 'copy', 'mark_read', 'star', 'add_label', 'stop']);
    expect(JSON.stringify(filter.parameters)).not.toMatch(/forward|redirect|reject|discard/);
    expect(Object.keys(tools.find((t) => t.name === 'update_event').parameters.properties)).not.toContain('participants');
  });
});

describe('asking first', () => {
  it('always for invitations, deletes, out-of-office, filters, batches, settings and contacts; for event changes when other people take part; as the user chose for tags', () => {
    const always = ['answer_invitation', 'delete_event', 'set_vacation', 'turn_off_vacation', 'create_filter', 'batch_messages', 'change_setting', 'update_contact'];
    for (const action of AREAS.actions.actions) {
      expect(action.alwaysAsk === true, action.name).toBe(always.includes(action.name));
    }
  });
});

describe('answering an invitation', () => {
  it('names the event and the sender, sends the answer, and has no undo', async () => {
    const api = apiWith({ 'calendar.respond': async () => ({ status: 'accepted', title: 'Team offsite', start: '2026-11-10', organizer: 'bob@example.org' }) });
    const { summary, alwaysAsk, done } = await run(api, 'answer_invitation', { status: 'accepted' }, ctxFor(api, { openEmailId: 'M1' }));
    // The second line says where the answer goes; this message carries no .ics to read it from.
    expect(summary).toBe('Accept the invitation “Team offsite” from Aa Bob? Bulwark sends your answer to the organiser.\nThe invitation names no organiser address.');
    expect(alwaysAsk).toBe(true);
    expect(api.calls('calendar.respond').map((c) => c.args)).toEqual([['M1', 'accepted']]);
    expect(done.undo).toBeNull();
    expect(done.text).toMatch(/can't be undone/);
  });

  it('fails when another plugin stopped it, and checks the answer', async () => {
    const api = apiWith({ 'calendar.respond': async () => null });
    await expect(run(api, 'answer_invitation', { status: 'declined', emailId: 'M1' })).rejects.toThrow(/stopped/);
    await expect(describeAction(api, 'answer_invitation', { status: 'yes', emailId: 'M1' }, ctxFor(api))).rejects.toThrow(/status must be/);
    await expect(describeAction(api, 'answer_invitation', { status: 'accepted' }, ctxFor(api))).rejects.toThrow(/no invitation/);
  });
});

describe('changing an event', () => {
  it('shows old and new, changes only the fields given, and writes the old values back on undo', async () => {
    const api = apiWith();
    const { summary, alwaysAsk, done } = await run(api, 'update_event', { id: 'E1', title: 'Dentist (moved)', start: '2026-11-04T11:00', participants: [{ email: 'x@example.com' }] });
    expect(alwaysAsk).toBe(false);
    expect(summary.split('\n')).toEqual([
      'Changes to the event “Dentist”:',
      'Title: Dentist → Dentist (moved)',
      'Time: Tuesday 3 November, 10:00–11:00 → Wednesday 4 November, 11:00–12:00',
    ]);
    expect(api.calls('calendar.updateEvent').map((c) => c.args)).toEqual([['E1', { title: 'Dentist (moved)', start: '2026-11-04T11:00' }]]);
    await undoAction(api, done.undo);
    expect(api.calls('calendar.updateEvent').at(-1).args).toEqual(['E1', { title: 'Dentist', isAllDay: false, start: '2026-11-03T10:00', duration: 'PT1H', timeZone: 'Europe/Berlin' }]);
  });

  it('turns an all-day end into the day after, and refuses nothing to change', async () => {
    const api = apiWith();
    await run(api, 'update_event', { id: 'E1', start: '2026-11-05', end: '2026-11-06' });
    expect(api.calls('calendar.updateEvent')[0].args[1]).toEqual({ isAllDay: true, start: '2026-11-05', end: '2026-11-07' });
    await expect(describeAction(api, 'update_event', { id: 'E1', title: 'Dentist' }, ctxFor(api))).rejects.toThrow(/nothing to change/);
    await expect(describeAction(api, 'update_event', { id: 'E1', start: 'tomorrow' }, ctxFor(api))).rejects.toThrow(/start must look like/);
  });
});

describe('deleting an event', () => {
  it('asks with the day and time, and undoes with the host\'s token', async () => {
    const api = apiWith({ 'calendar.deleteEvent': async () => ({ undoToken: 'tok-1' }) });
    const { summary, alwaysAsk, done } = await run(api, 'delete_event', { id: 'E1' });
    expect(summary).toBe('Delete “Dentist” on Tuesday 3 November, 10:00?');
    expect(alwaysAsk).toBe(true);
    expect(api.calls('calendar.deleteEvent').map((c) => c.args)).toEqual([['E1']]);
    await undoAction(api, done.undo);
    expect(api.calls('calendar.undoDelete').map((c) => c.args)).toEqual([['tok-1']]);
  });

  it('says it can\'t be undone when the webmail gives no token', async () => {
    const api = apiWith({ 'calendar.deleteEvent': async () => undefined });
    const { done } = await run(api, 'delete_event', { id: 'E1' });
    expect(done.undo).toBeNull();
    expect(done.text).toMatch(/can't be undone/);
  });

  it('refuses a repeating event, an occurrence and someone else\'s event', async () => {
    for (const extra of [{ isRecurring: true }, { recurrenceId: '2026-11-03T10:00:00' }]) {
      const api = apiWith({ 'calendar.getEvent': async () => ({ ...EVENT, ...extra }) });
      const err = await describeAction(api, 'delete_event', { id: 'E1' }, ctxFor(api)).catch((e) => e);
      expect(err.reason).toBe('do.refuse.repeating');
      expect(api.calls('calendar.deleteEvent')).toEqual([]);
    }
    const invited = { ...EVENT, participants: [{ name: 'Bob', email: 'bob@example.org', role: 'owner', status: 'accepted' }, { name: 'Alice', email: 'alice@example.org', role: 'attendee', status: 'needs-action' }] };
    const api = apiWith({ 'calendar.getEvent': async () => invited });
    expect((await describeAction(api, 'delete_event', { id: 'E1' }, ctxFor(api)).catch((e) => e)).reason).toBe('do.refuse.not_own_event');
    const mine = apiWith({ 'calendar.getEvent': async () => ({ ...invited, participants: [{ ...invited.participants[0], email: 'Alice@example.org' }, invited.participants[1]] }) });
    expect((await describeAction(mine, 'delete_event', { id: 'E1' }, ctxFor(mine))).summary).toMatch(/^Delete “Dentist”/);
  });
});

describe('tags', () => {
  it('by the tag\'s name, and undo puts the keyword back as it was', async () => {
    const api = apiWith();
    const { summary, alwaysAsk, done } = await run(api, 'tag_message', { id: 'M1', tag: 'urgent' });
    expect(summary).toBe('Tag “Team offsite” with Urgent');
    expect(alwaysAsk).toBe(false);
    expect(api.calls('email.updateKeywords').map((c) => c.args)).toEqual([['M1', { '$label:red': true }]]);
    await undoAction(api, done.undo);
    expect(api.calls('email.updateKeywords').at(-1).args).toEqual(['M1', { '$label:red': false }]);
    const removed = await run(api, 'untag_message', { id: 'M1', tag: 'Q3' });
    expect(removed.summary).toBe('Remove the tag Q3 invoices from “Team offsite”');
    expect(api.calls('email.updateKeywords').at(-1).args).toEqual(['M1', { '$label:q3': false }]);
    await expect(describeAction(api, 'tag_message', { id: 'M1', tag: 'Holiday' }, ctxFor(api))).rejects.toThrow(/the tags are: Urgent, Q3 invoices/);
  });
});

describe('the out-of-office', () => {
  it('shows subject, text and dates, sets it in the user\'s zone, and undo restores the old one', async () => {
    const api = apiWith();
    const { summary, alwaysAsk, done } = await run(api, 'set_vacation', { subject: 'Away', text: 'Back on Monday.', from: '2026-11-09', to: '2026-11-13' });
    expect(alwaysAsk).toBe(true);
    expect(summary.split('\n')).toEqual(['Set your out-of-office from Monday 9 November to Friday 13 November?', 'Subject: Away', 'Text: Back on Monday.']);
    expect(api.calls('vacation.set').map((c) => c.args[0])).toEqual([{ isEnabled: true, subject: 'Away', textBody: 'Back on Monday.', htmlBody: null, fromDate: '2026-11-08T23:00:00.000Z', toDate: '2026-11-13T23:00:00.000Z' }]);
    await undoAction(api, done.undo);
    expect(api.calls('vacation.set').at(-1).args[0]).toEqual({ isEnabled: false, subject: 'Old', textBody: 'Away', htmlBody: null, fromDate: null, toDate: null });
  });

  it('refuses while it forwards mail, and never writes then', async () => {
    const api = apiWith({ 'vacation.get': async () => ({ ...VACATION, isEnabled: true, forwardActive: true }) });
    for (const [name, args] of [['set_vacation', { subject: 'A', text: 'B' }], ['turn_off_vacation', {}]]) {
      const err = await describeAction(api, name, args, ctxFor(api)).catch((e) => e);
      expect(err.reason, name).toBe('do.refuse.vacation_forward');
    }
    expect(api.calls('vacation.set')).toEqual([]);
    expect(api.i18n.t('do.refuse.vacation_forward')).toBe('Your out-of-office forwards mail. Change it in Settings > Out of office.');
  });

  it('turns it off and back on', async () => {
    const on = { ...VACATION, isEnabled: true, subject: 'Holiday' };
    const api = apiWith({ 'vacation.get': async () => on });
    const { summary, done } = await run(api, 'turn_off_vacation', {});
    expect(summary).toBe('Turn off your out-of-office?\nSubject: Holiday');
    expect(api.calls('vacation.set')[0].args[0]).toEqual({ isEnabled: false });
    await undoAction(api, done.undo);
    expect(api.calls('vacation.set').at(-1).args[0]).toMatchObject({ isEnabled: true, subject: 'Holiday' });
  });

  it('is read by get_vacation, which says when it forwards', async () => {
    const api = apiWith({ 'vacation.get': async () => ({ ...VACATION, isEnabled: true, forwardActive: true }) });
    const out = await runTool(api, 'get_vacation', {}, ctxFor(api));
    expect(out).toMatch(/is on/);
    expect(out).toMatch(/forwards mail/);
  });

  it('converts wall-clock times in the user\'s zone', () => {
    expect(zonedInstant('2026-07-01T09:00', 'Europe/Berlin')).toBe('2026-07-01T07:00:00.000Z');
    expect(zonedInstant('2026-11-09', 'America/New_York')).toBe('2026-11-09T05:00:00.000Z');
  });
});

describe('filters', () => {
  const NEWSLETTER = { name: 'News', conditions: [{ field: 'from', op: 'is', value: 'newsletter@shop.example' }], actions: [{ type: 'move', folder: 'newsletters' }, { type: 'mark_read' }] };

  it('shows the rule in plain words, creates it, and undoes with the host\'s token', async () => {
    const api = apiWith({ 'filters.create': async () => ({ id: 'r1', undoToken: 'ftok' }) });
    const { summary, alwaysAsk, done } = await run(api, 'create_filter', NEWSLETTER);
    expect(alwaysAsk).toBe(true);
    expect(summary).toBe('Create the filter “News”?\nIf the sender is “newsletter@shop.example”: move to “Newsletters”, mark as read');
    expect(api.calls('filters.create').map((c) => c.args[0])).toEqual([{
      name: 'News', match: 'all',
      conditions: [{ field: 'from', op: 'is', value: 'newsletter@shop.example' }],
      actions: [{ type: 'move', mailboxId: 'news' }, { type: 'mark_read' }],
    }]);
    await undoAction(api, done.undo);
    expect(api.calls('filters.undo').map((c) => c.args)).toEqual([['ftok']]);
  });

  it('refuses forward, redirect, reject, discard and keep, even when the model asks', async () => {
    const api = apiWith({ 'filters.create': async () => ({ id: 'r1', undoToken: 'x' }) });
    for (const type of ['forward', 'redirect', 'reject', 'discard', 'keep', 'fileinto']) {
      const err = await describeAction(api, 'create_filter', { ...NEWSLETTER, actions: [{ type: 'mark_read' }, { type, value: 'x@example.com', folder: 'x@example.com' }] }, ctxFor(api)).catch((e) => e);
      expect(err.reason, type).toBe('do.refuse.filter_action');
    }
    expect(api.calls('filters.create')).toEqual([]);
  });

  it('never moves to the trash', async () => {
    const api = apiWith();
    const err = await describeAction(api, 'create_filter', { ...NEWSLETTER, actions: [{ type: 'move', folder: 'trash' }] }, ctxFor(api)).catch((e) => e);
    expect(err.reason).toBe('do.refuse.trash');
  });

  it('are listed in plain words for the model', async () => {
    const api = apiWith({
      'filters.list': async () => ({
        supported: true, editable: true,
        rules: [
          { id: 'a', name: 'News', isActive: true, editable: true, match: 'all', conditions: [{ field: 'from', op: 'domain_is', value: 'shop.example' }], actions: [{ type: 'move', folder: 'Newsletters' }, { type: 'add_label', tagId: 'red' }] },
          { id: 'b', name: 'Old', isActive: false, editable: false, match: 'any', conditions: [{ field: 'size', op: 'greater_than', value: '5242880' }], actions: [{ type: 'forward', value: 'me@example.net' }] },
        ],
      }),
    });
    const out = await runTool(api, 'list_filters', {}, ctxFor(api));
    expect(out).toContain('- "News": If the sender is at shop.example: move to “Newsletters”, tag with Urgent');
    expect(out).toContain('- "Old" (off): If the size is over 5 MB: forward me@example.net');
  });
});

describe('many messages at once', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => `B${i + 1}`);

  it('asks with the count and the first five subjects, and undoes with the host\'s token', async () => {
    const api = apiWith({ 'email.batch': async () => ({ done: 7, failed: 0, undoToken: 'btok' }) });
    const { summary, alwaysAsk, done } = await run(api, 'batch_messages', { ids: ids(7), action: 'move', folder: 'Newsletters' });
    expect(alwaysAsk).toBe(true);
    expect(summary.split('\n')).toEqual(['Move 7 messages to “Newsletters”?', '• Subject B1', '• Subject B2', '• Subject B3', '• Subject B4', '• Subject B5', 'and 2 more']);
    expect(api.calls('email.batch').map((c) => c.args[0])).toEqual([{ emailIds: ids(7), action: 'move', mailboxId: 'news' }]);
    await undoAction(api, done.undo);
    expect(api.calls('email.undoBatch').map((c) => c.args)).toEqual([['btok']]);
  });

  it('refuses more than the admin\'s limit', async () => {
    const api = apiWith();
    const ctx = ctxFor(api, { config: { batchLimit: 3 } });
    const err = await describeAction(api, 'batch_messages', { ids: ids(4), action: 'archive' }, ctx).catch((e) => e);
    expect(err.reason).toBe('do.refuse.batch_limit');
    expect(err.message).toMatch(/at most 3/);
    expect((await describeAction(api, 'batch_messages', { ids: ids(3), action: 'archive' }, ctx)).summary).toMatch(/^Archive 3 messages\?/);
    // Default 50.
    expect((await describeAction(api, 'batch_messages', { ids: ids(51), action: 'read' }, ctxFor(api)).catch((e) => e)).reason).toBe('do.refuse.batch_limit');
    expect(api.calls('email.batch')).toEqual([]);
  });

  it('takes a search, asking for one more than allowed', async () => {
    const found = ids(4).map((id) => ({ id, subject: `Found ${id}` }));
    const api = apiWith({ 'email.search': async () => found });
    const ctx = ctxFor(api, { config: { batchLimit: 3 } });
    const err = await describeAction(api, 'batch_messages', { search: { from: 'shop.example' }, action: 'archive' }, ctx).catch((e) => e);
    expect(err.reason).toBe('do.refuse.batch_limit');
    expect(api.calls('email.search')[0].args[0]).toEqual({ from: 'shop.example', limit: 4 });
  });

  it('never moves to the trash, and sends one message to the single actions', async () => {
    const api = apiWith();
    expect((await describeAction(api, 'batch_messages', { ids: ids(2), action: 'move', folder: 'Trash' }, ctxFor(api)).catch((e) => e)).reason).toBe('do.refuse.trash');
    await expect(describeAction(api, 'batch_messages', { ids: ['B1'], action: 'archive' }, ctxFor(api))).rejects.toThrow(/only one message/);
  });
});

describe('settings', () => {
  const ON = { config: { allowSettingsChanges: true }, prefs: { doActions: { settings: true } } };
  const described = (over = {}) => async (changes) => Object.fromEntries(Object.keys(changes).map((key) => [key, {
    key, label: 'Time format', page: 'appearance', pageLabel: 'Appearance', current: '12h', currentLabel: '12-hour', next: changes[key], nextLabel: '24-hour', allowed: true, ...over,
  }]));

  it('shows the change from describeSettings, applies it, and undoes with the host\'s token', async () => {
    const api = apiWith({
      'app.describeSettings': described(),
      'app.setSettings': async () => ({ applied: { timeFormat: { old: '12h', new: '24h' } }, refused: {}, undoToken: 'stok' }),
      'app.undoSettings': async () => ({ restored: ['timeFormat'], refused: {} }),
    });
    const { summary, alwaysAsk, done } = await run(api, 'change_setting', { key: 'timeFormat', value: '24h' }, ctxFor(api, ON));
    expect(alwaysAsk).toBe(true);
    expect(summary).toBe('Change Time format: 12-hour → 24-hour?');
    expect(api.calls('app.setSettings').map((c) => c.args[0])).toEqual([{ timeFormat: '24h' }]);
    await undoAction(api, done.undo);
    expect(api.calls('app.undoSettings').map((c) => c.args)).toEqual([['stok']]);
  });

  it('refuses a locked setting and one it may not change, with the reason the user reads', async () => {
    for (const [reason, key, text] of [
      ['locked', 'do.refuse.setting_locked', 'This setting is set by your organisation.'],
      ['not_allowed', 'do.refuse.setting', 'The assistant can\'t change this setting.'],
      ['hidden', 'do.refuse.setting', 'The assistant can\'t change this setting.'],
    ]) {
      const api = apiWith({ 'app.describeSettings': described({ allowed: false, reason }) });
      const err = await describeAction(api, 'change_setting', { key: 'timeFormat', value: '24h' }, ctxFor(api, ON)).catch((e) => e);
      expect(err.reason, reason).toBe(key);
      expect(api.i18n.t(err.reason)).toBe(text);
      expect(api.calls('app.setSettings')).toEqual([]);
    }
  });

  it('is not run when the admin doesn\'t allow it, even if the model calls it', async () => {
    const api = apiWith({ 'app.describeSettings': described() });
    await expect(describeAction(api, 'change_setting', { key: 'timeFormat', value: '24h' }, ctxFor(api, { prefs: ON.prefs }))).rejects.toThrow(/not available/);
    expect(api.calls('app.describeSettings')).toEqual([]);
  });
});

describe('contacts', () => {
  const CARD = {
    id: 'C1', addressBookIds: { ab: true },
    name: { full: 'Anna Berg', components: [{ kind: 'given', value: 'Anna' }, { kind: 'surname', value: 'Berg' }] },
    emails: { work: { address: 'anna@old.example', contexts: { work: true } } },
  };

  it('changes the fields given, keeps entries that stay, and undo writes the old card back', async () => {
    const api = apiWith({ 'contacts.get': async (id) => (id === 'C1' ? CARD : null), 'contacts.search': async () => [CARD] });
    const { summary, alwaysAsk, done } = await run(api, 'update_contact', { query: 'Anna', emails: ['anna@old.example', 'anna@new.example'], company: 'Shop GmbH' });
    expect(alwaysAsk).toBe(true);
    expect(summary.split('\n')).toEqual([
      'Change the contact Anna Berg?',
      'Email: anna@old.example → anna@old.example, anna@new.example',
      // The user didn't type the new address in this chat.
      'New address from a message: check anna@new.example',
      'Company: none → Shop GmbH',
    ]);
    expect(api.calls('contacts.update')[0].args).toEqual(['C1', {
      emails: { work: CARD.emails.work, e1: { address: 'anna@new.example' } },
      organizations: { o1: { name: 'Shop GmbH' } },
    }]);
    await undoAction(api, done.undo);
    expect(api.calls('contacts.update').at(-1).args).toEqual(['C1', { emails: CARD.emails, organizations: null }]);
  });

  it('asks for the id when a query finds several', async () => {
    const api = apiWith({ 'contacts.search': async () => [{ ...CARD }, { ...CARD, id: 'C2' }] });
    await expect(describeAction(api, 'update_contact', { query: 'Anna', company: 'X' }, ctxFor(api))).rejects.toThrow(/2 contacts match "Anna"; give the id of one/);
  });
});

describe('the area\'s texts', () => {
  it('stay in the user\'s language', async () => {
    const api = apiWith({}, { locale: 'de' });
    const { summary } = await describeAction(api, 'batch_messages', { ids: ['B1', 'B2'], action: 'archive' }, ctxFor(api));
    expect(summary.split('\n')[0]).toBe(allStrings().de['do.batch.archive'].replace('{count}', '2'));
    expect(summary).not.toMatch(/Archive/);
  });

  it('never let a refusal write', async () => {
    const api = apiWith({ 'vacation.get': async () => ({ ...VACATION, forwardActive: true }) });
    await describeAction(api, 'set_vacation', { subject: 'a', text: 'b' }, ctxFor(api)).catch(() => {});
    await describeAction(api, 'create_filter', { conditions: [{ field: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'forward' }] }, ctxFor(api)).catch(() => {});
    await describeAction(api, 'batch_messages', { ids: Array.from({ length: 60 }, (_, i) => `B${i}`), action: 'archive' }, ctxFor(api)).catch(() => {});
    expect(writes(api)).toEqual([]);
  });
});
