// Shared steps of the "more actions" end-to-end tests (package C of the 2.2
// work): turning actions on in the plugin's settings, approving an action
// card, and reading through JMAP what an action changed.

import { expect } from '@playwright/test';
import { preparePage, signIn, waitForPlugin } from '../../e2e/helpers.mjs';
import { ID, configure, mockReadsChunked } from './common.mjs';
import { jmap, USER } from './jmap.mjs';

const SLOT_FRAME = `iframe[title="plugin-${ID}-slot"]`;
const SIEVE = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:sieve'];
const VACATION = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:vacationresponse'];
const CALENDARS = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'];
const MAIL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];

/** A word no other run has used, for subjects and names. */
export const runTag = () => `c${Date.now().toString(36)}`;

/** Admin config, sign in, and the plugin running. */
export async function setUp(page, api, test, config = {}) {
  test.skip(!(await mockReadsChunked()), 'the mock AI server is not running');
  await configure(api, config);
  await page.setViewportSize({ width: 1600, height: 900 });
  await preparePage(page, { theme: 'light' });
  await signIn(page);
  await waitForPlugin(page, ID);
}

/** The plugin's settings in Settings > AI Assistant. */
export async function openPluginSettings(page) {
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'AI Assistant' }).click();
  const frame = page.frameLocator(SLOT_FRAME).first();
  await expect(frame.getByTestId('ai-status')).toBeVisible({ timeout: 30_000 });
  return frame;
}

/** Actions on ("Ask me first"), and the named switches of "What the assistant may change" on. */
export async function turnOnActions(page, switches = []) {
  const frame = await openPluginSettings(page);
  await frame.locator('#ai-actions').selectOption('manual');
  for (const name of switches) {
    const sw = frame.getByRole('switch', { name });
    await expect(sw).toBeEnabled();
    if (!(await sw.isChecked())) await sw.click();
    await expect(sw).toBeChecked();
  }
  // Back to the mail; the panel reads the saved settings when it opens.
  await page.getByRole('link', { name: 'Mail' }).first().click();
}

/** The newest action card of a kind (data-action is the tool name). */
export const card = (frame, name) => frame.locator(`[data-action="${name}"]`).last();

/** Wait for the card to ask, check its text, and answer it. */
export async function answerCard(frame, name, { text, ok = true } = {}) {
  const c = card(frame, name);
  await expect(c).toHaveAttribute('data-action-state', 'waiting', { timeout: 60_000 });
  if (text) await expect(c).toContainText(text);
  await c.getByRole('button', { name: ok ? 'Do it' : 'Skip' }).click();
  await expect(c).toHaveAttribute('data-action-state', ok ? 'done' : 'skipped', { timeout: 60_000 });
  return c;
}

/** Poll `read` until `check` holds (JMAP state that the server changes a moment later). */
export async function eventually(read, check, { timeout = 60_000, every = 2000 } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await read();
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, every));
  }
  return last;
}

/** The ids and subjects of the user's messages matching a JMAP filter, with their folders. */
export async function findMail(filter, user = USER) {
  const client = await jmap(user);
  const [[, q], [, g]] = await client.call([
    ['Email/query', { accountId: client.accountId, filter, limit: 50 }, 'q'],
    ['Email/get', { accountId: client.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'mailboxIds', 'keywords', 'to', 'from'] }, 'g'],
  ], MAIL);
  return q.ids.map((id) => g.list.find((e) => e.id === id)).filter(Boolean);
}

/** The folder with `name`, made when it isn't there. */
export async function ensureFolder(name, user = USER) {
  const client = await jmap(user);
  const [[, res]] = await client.call([['Mailbox/get', { accountId: client.accountId, properties: ['id', 'name', 'role'] }]], MAIL);
  const found = res.list.find((m) => m.name === name);
  if (found) return found.id;
  const [[, set]] = await client.call([['Mailbox/set', { accountId: client.accountId, create: { f: { name, parentId: null } } }]], MAIL);
  return set.created.f.id;
}

/** Every folder: id → { name, role }. */
export async function folders(user = USER) {
  const client = await jmap(user);
  const [[, res]] = await client.call([['Mailbox/get', { accountId: client.accountId, properties: ['id', 'name', 'role'] }]], MAIL);
  return Object.fromEntries(res.list.map((m) => [m.id, m]));
}

/** The out-of-office as the server has it. */
export async function vacation(user = USER) {
  const client = await jmap(user);
  const [[, res]] = await client.call([['VacationResponse/get', { accountId: client.accountId, ids: ['singleton'] }]], VACATION);
  return res.list[0];
}

export async function setVacation(patch, user = USER) {
  const client = await jmap(user);
  await client.call([['VacationResponse/set', { accountId: client.accountId, update: { singleton: patch } }]], VACATION);
}

/** The text of every Sieve script of the account, joined. */
export async function sieveText(user = USER) {
  const client = await jmap(user);
  const [[, res]] = await client.call([['SieveScript/get', { accountId: client.accountId }]], SIEVE);
  const parts = [];
  for (const script of res.list) {
    const url = client.session.downloadUrl
      .replace('{accountId}', encodeURIComponent(client.accountId)).replace('{blobId}', encodeURIComponent(script.blobId))
      .replace('{name}', 'script.sieve').replace('{type}', 'application%2Fsieve');
    const abs = url.startsWith('http') ? url : new URL(url, client.session.apiUrl.startsWith('http') ? client.session.apiUrl : process.env.BULWARK_JMAP_URL).href;
    const auth = `Basic ${Buffer.from(`${user}:${process.env.BULWARK_PASSWORD || 'test-pass-123'}`).toString('base64')}`;
    const r = await fetch(abs, { headers: { authorization: auth } });
    parts.push(`# ${script.name}\n${await r.text()}`);
  }
  return parts.join('\n');
}

/** The user's events with `uid` (calendar capability). */
export async function eventsWithUid(uid, user = USER) {
  const client = await jmap(user);
  const [[, q], [, g]] = await client.call([
    ['CalendarEvent/query', { accountId: client.accountId, filter: { uid } }, 'q'],
    ['CalendarEvent/get', { accountId: client.accountId, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' } }, 'g'],
  ], CALENDARS);
  return q.ids?.length ? g.list : [];
}

/**
 * `organizer` invites `attendee` from their own calendar: the server sends
 * the invitation by mail. Resolves to the event's uid.
 */
export async function inviteFrom(organizer, attendee, title, start = '2026-12-10T09:00:00') {
  const client = await jmap(organizer);
  const [[, cals]] = await client.call([['Calendar/get', { accountId: client.accountId }]], CALENDARS);
  const calendar = cals.list.find((c) => c.isDefault) ?? cals.list[0];
  const uid = `${title.replace(/\W+/g, '-')}@e2e.bulwark.test`;
  const [[, set]] = await client.call([['CalendarEvent/set', {
    accountId: client.accountId, sendSchedulingMessages: true,
    create: { e: {
      '@type': 'Event', uid, title, start, duration: 'PT1H', timeZone: 'Etc/UTC', calendarIds: { [calendar.id]: true },
      organizerCalendarAddress: `mailto:${organizer}`,
      participants: {
        o: { '@type': 'Participant', calendarAddress: `mailto:${organizer}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
        a: { '@type': 'Participant', calendarAddress: `mailto:${attendee}`, roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true },
      },
    } },
  }]], CALENDARS);
  if (!set.created?.e) throw new Error(`invitation not created: ${JSON.stringify(set.notCreated)}`);
  return uid;
}

/** What `attendee` answered, as the organiser's copy of the event says. */
export async function answerOf(organizer, uid, attendee) {
  const events = await eventsWithUid(uid, organizer).catch(() => []);
  for (const event of events) {
    for (const p of Object.values(event.participants ?? {})) {
      if ((p.calendarAddress ?? p.email ?? '').toLowerCase().includes(attendee.toLowerCase())) return p.participationStatus;
    }
  }
  return null;
}
