// Helpers of the "everywhere" tests (package F): the views with the
// app-side-panel, and a calendar event for today through JMAP.

import { expect } from '@playwright/test';
import { BASE } from '../../e2e/helpers.mjs';
import { USER, jmap } from './jmap.mjs';

export const VIEWS = ['calendar', 'contacts', 'files', 'settings'];
const CALENDARS = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'];
const SLOT_FRAME = 'iframe[title="plugin-ai-assistant-slot"]';

/** The host's panel button (reader or view) and the view's panel with the plugin's frame. */
export const toggle = (page) => page.locator('[data-plugin-panel-toggle]');
export function viewPanel(page) {
  const host = page.locator('[data-app-side-panel]');
  return { host, frame: page.frameLocator(`[data-app-side-panel] ${SLOT_FRAME}`) };
}

/** Open a view by its address and wait for its panel button (none on a phone). */
export async function openView(page, view, { button = true } = {}) {
  await page.goto(`${BASE}/${view}`, { waitUntil: 'domcontentloaded' });
  if (button) await expect(toggle(page)).toHaveCount(1, { timeout: 60_000 });
}

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(zone, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** An event today at `time` (local in `zone`) in the user's default calendar, through JMAP. Resolves to its id. */
export async function seedTodayEvent(title, { zone = 'Europe/Berlin', time = '12:00:00', user = USER } = {}) {
  const client = await jmap(user);
  const accountId = client.session.primaryAccounts['urn:ietf:params:jmap:calendars'] ?? client.accountId;
  const [[, calendars]] = await client.call([['Calendar/get', { accountId }]], CALENDARS);
  const calendar = calendars.list.find((c) => c.isDefault) ?? calendars.list[0];
  if (!calendar) throw new Error(`no calendar for ${user}`);
  const day = todayIn(zone);
  const [[, found]] = await client.call([['CalendarEvent/query', { accountId, filter: { text: title } }]], CALENDARS);
  if (found?.ids?.length) await client.call([['CalendarEvent/set', { accountId, destroy: found.ids }]], CALENDARS);
  const [[, res]] = await client.call([['CalendarEvent/set', {
    accountId,
    create: { e: { '@type': 'Event', calendarIds: { [calendar.id]: true }, title, start: `${day}T${time}`, timeZone: zone, duration: 'PT1H' } },
  }]], CALENDARS);
  if (!res.created?.e) throw new Error(`event "${title}" not created: ${JSON.stringify(res.notCreated)}`);
  return res.created.e.id;
}

/** The button's place on screen, measured from the window's right edge and top. */
export async function placeFromRight(page, locator) {
  const box = await locator.boundingBox();
  const width = page.viewportSize().width;
  return box && { right: Math.round(width - (box.x + box.width)), top: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
}
