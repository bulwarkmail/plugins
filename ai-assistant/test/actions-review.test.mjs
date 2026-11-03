import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { allStrings } from '../src/lib/i18n.js';
import { describeAction, performAction, undoAction } from '../src/lib/actions.js';
import { MAX_SHOWN_TEXT, actionCaps } from '../src/lib/areas/actions.js';

// Fixes after the review of package C: what an action saves is what its card
// shows, a description other people read and an answer to an invitation say
// where they go, an address from a message is pointed out, and switching an
// out-of-office back on checks its forward again.

const FEATURES = { answerInvitation: true, filterRules: true, batchMail: true, changeSettings: true };
const EVENT = { id: 'E1', uid: 'u1', title: 'Planning', description: 'old', start: '2026-11-03T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', isAllDay: false, participants: [], isRecurring: false };
const VACATION = { isEnabled: false, subject: 'Old', textBody: 'Away', htmlBody: '', fromDate: null, toDate: null, forwardActive: false };

function apiWith(handlers = {}) {
  return fakeApi({
    translations: allStrings(), locale: 'en', dateLocale: 'en-GB', timeFormat: '24h', timeZone: 'Europe/Berlin', hostFeatures: FEATURES,
    handlers: {
      'calendar.getEvent': async (id) => (id === 'E1' ? EVENT : id === 'E2' ? { ...EVENT, id: 'E2', participants: [{ email: 'alice@example.org', role: 'owner' }, { email: 'carol@example.org', role: 'attendee' }] } : null),
      'vacation.get': async () => VACATION,
      'vacation.set': async (input) => ({ ...VACATION, ...input }),
      'user.getIdentities': async () => [{ email: 'alice@example.org' }],
      ...handlers,
    },
  });
}
const ctxFor = (api, extra = {}) => ({ actions: 'auto', lookups: true, config: {}, prefs: {}, zone: 'Europe/Berlin', doCaps: actionCaps(api), doVacationKnown: true, ...extra });

describe('the card shows what is saved', () => {
  it('shows the whole out-of-office text, and refuses one longer than it can show', async () => {
    const api = apiWith();
    const body = 'Back on Monday.'.padEnd(MAX_SHOWN_TEXT, '!');
    const { summary } = await describeAction(api, 'set_vacation', { subject: 'Away', text: body }, ctxFor(api));
    expect(summary).toContain(body);
    await expect(describeAction(api, 'set_vacation', { subject: 'Away', text: `${body}x` }, ctxFor(api))).rejects.toThrow(/longer than 1000/);
    expect(api.calls('vacation.set')).toHaveLength(0);
  });

  it('shows a new event description whole, and refuses one longer than it can show', async () => {
    const api = apiWith();
    const description = 'Agenda: '.padEnd(900, 'x');
    const { summary } = await describeAction(api, 'update_event', { id: 'E1', description }, ctxFor(api));
    expect(summary).toContain(description);
    await expect(describeAction(api, 'update_event', { id: 'E1', description: 'y'.repeat(MAX_SHOWN_TEXT + 1) }, ctxFor(api))).rejects.toThrow(/longer than 1000/);
  });

  it('asks first, whatever the mode, before changing a description other people read', async () => {
    const api = apiWith();
    expect((await describeAction(api, 'update_event', { id: 'E2', description: 'new words' }, ctxFor(api))).alwaysAsk).toBe(true);
    // Only the user in it, or no description change: the user's mode decides.
    expect((await describeAction(api, 'update_event', { id: 'E1', description: 'new words' }, ctxFor(api))).alwaysAsk).toBe(false);
    expect((await describeAction(api, 'update_event', { id: 'E2', title: 'Planning 2' }, ctxFor(api))).alwaysAsk).toBe(false);
  });

  it('says "changes to" rather than asking, so a card that ran by itself reads right', async () => {
    const api = apiWith();
    const { summary } = await describeAction(api, 'update_event', { id: 'E1', title: 'Planning 2' }, ctxFor(api));
    expect(summary.split('\n')[0]).toBe('Changes to the event “Planning”:');
  });
});

describe('the out-of-office undo', () => {
  it('checks the forward again before switching the reply back on', async () => {
    let forward = false;
    const api = apiWith({ 'vacation.get': async () => ({ ...VACATION, isEnabled: true, forwardActive: forward }) });
    const { plan } = await describeAction(api, 'turn_off_vacation', {}, ctxFor(api));
    const done = await performAction(api, plan);
    forward = true;
    await expect(undoAction(api, done.undo)).rejects.toThrow(/forwards mail/);
    expect(api.calls('vacation.set')).toHaveLength(1);
  });

  it('refuses when the webmail can\'t tell whether it forwards (forwardActive null)', async () => {
    let state = false;
    const api = apiWith({ 'vacation.get': async () => ({ ...VACATION, forwardActive: state }) });
    const { plan } = await describeAction(api, 'set_vacation', { subject: 'Away', text: 'Back Monday' }, ctxFor(api));
    const done = await performAction(api, plan);
    state = null;
    await expect(undoAction(api, done.undo)).rejects.toThrow(/can't tell whether the out-of-office forwards/);
    expect(api.calls('vacation.set')).toHaveLength(1);
  });
});

describe('update_contact', () => {
  const CARD = { id: 'C1', name: { full: 'Anna Berg' }, emails: { e1: { address: 'anna@old.example' } }, phones: { p1: { number: '+49 30 1111' } } };
  const contactsApi = () => apiWith({ 'contacts.get': async () => CARD, 'contacts.update': async () => null });

  it('points out every new address and number the user didn\'t type', async () => {
    const api = contactsApi();
    const { summary } = await describeAction(api, 'update_contact', {
      id: 'C1', emails: ['anna@old.example', 'anna@evil.example'], phones: ['+49 30 1111', '+1 555 0100'],
    }, ctxFor(api, { userText: 'update Anna from her signature' }));
    expect(summary).toContain('New address from a message: check anna@evil.example');
    expect(summary).toContain('New phone number from a message: check +1 555 0100');
    // Entries the card had already are not new.
    expect(summary).not.toContain('check anna@old.example');
  });

  it('leaves out the warning for what the user typed themselves', async () => {
    const api = contactsApi();
    const { summary } = await describeAction(api, 'update_contact', {
      id: 'C1', emails: ['anna@new.example'], phones: ['+1 555 0100'],
    }, ctxFor(api, { userText: 'Anna is now anna@new.example, phone +1 (555) 0100' }));
    expect(summary).not.toContain('from a message');
  });
});

describe('answer_invitation', () => {
  it('names the organiser address the answer goes to, from the invitation itself', async () => {
    const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nORGANIZER;CN=Aa Bob:mailto:organiser-with-a-very-long\r\n -address@example.org\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const api = apiWith({
      'email.get': async () => ({ id: 'M1', subject: 'Invitation: Planning', from: [{ name: 'Aa Bob', email: 'bob@example.org' }], attachments: [{ blobId: 'b1', name: 'invite.ics', type: 'text/calendar' }] }),
      'email.getAttachment': async () => ({ name: 'invite.ics', type: 'text/calendar', size: ics.length, data: new TextEncoder().encode(ics).buffer }),
    });
    const { summary, alwaysAsk } = await describeAction(api, 'answer_invitation', { status: 'accepted' }, ctxFor(api, { openEmailId: 'M1' }));
    expect(alwaysAsk).toBe(true);
    expect(summary).toContain('Your answer goes to organiser-with-a-very-long-address@example.org.');
  });
});
