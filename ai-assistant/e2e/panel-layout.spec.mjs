import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { installPlugin, uninstallPlugin, preparePage, signIn, waitForPlugin } from '../../e2e/helpers.mjs';
import { ID, acceptPrivacy, ask, chatInput, configure, mockReadsChunked, mockRequests, mockScript, openMessage, readerPanel, waitDone } from './common.mjs';
import { seedReaderMail } from './jmap.mjs';

// Where the panel's button is, whether the chip row fits at every panel
// width, and which day the model is told it is (package A of the 2.2 work).

const SUBJECT = 'Can we meet on Thursday?';
const toggle = (page) => page.locator('[data-plugin-panel-toggle]');

test.beforeAll(async () => {
  if (process.env.BULWARK_JMAP_URL) await seedReaderMail();
});

async function setUp(page, api, { viewport = { width: 1600, height: 900 }, theme = 'light' } = {}) {
  test.skip(!(await mockReadsChunked()), 'the mock AI server is not running');
  await configure(api);
  await page.setViewportSize(viewport);
  await preparePage(page, { theme });
  await signIn(page);
  await waitForPlugin(page, ID);
}

/** The button's place on screen, rounded to whole pixels. */
async function place(locator) {
  const box = await locator.boundingBox();
  return box && { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
}

test('the panel button sits in the same place with and without a message, folded and open', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api);
    // No message open: the toolbar row with only the button.
    await expect(toggle(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('[data-toolbar-toggle-only]')).toBeVisible();
    const empty = await place(toggle(page));
    await toggle(page).click();
    await expect(page.locator('[data-plugin-detail-panel]')).toBeVisible();
    const emptyOpen = await place(toggle(page));
    // Nothing in the panel above the plugin's own header: no strip, no second button.
    await expect(page.locator('[data-plugin-detail-panel] button')).toHaveCount(0);
    await toggle(page).click();
    await expect(page.locator('[data-plugin-detail-panel]')).toHaveCount(0);

    await openMessage(page, SUBJECT, page.getByText('send me the slides').first());
    await expect(page.locator('[data-viewer-top-toolbar="full-width"]:not([data-toolbar-toggle-only])')).toBeVisible();
    await expect(toggle(page)).toHaveCount(1);
    const withMessage = await place(toggle(page));
    await toggle(page).click();
    const withMessageOpen = await place(toggle(page));

    expect(emptyOpen).toEqual(empty);
    expect(withMessage).toEqual(empty);
    expect(withMessageOpen).toEqual(empty);
  } finally {
    await uninstallPlugin(api, ID);
  }
});

for (const width of [200, 280, 500]) {
  test(`the chip row doesn't overlap in a ${width} px panel`, async ({ page }) => {
    const api = await install(await adminApi(), ID, installPlugin);
    try {
      await page.addInitScript((w) => { try { localStorage.setItem('emailDetailSidebarWidth', String(w)); } catch { /* blocked */ } }, width);
      await setUp(page, api);
      await openMessage(page, SUBJECT, page.getByText('send me the slides').first());
      const { host, frame } = await readerPanel(page);
      expect(Math.round((await host.boundingBox()).width)).toBe(width);
      const chip = frame.locator('[data-context-chip]').first();
      const actions = frame.locator('[data-assistant-actions]');
      const send = frame.getByRole('button', { name: 'Send' });
      const box = frame.locator('[data-assistant-input]');
      await expect(chip).toBeVisible();
      const boxes = await Promise.all([chip, actions, send, box].map((l) => l.boundingBox()));
      const [c, a, s, b] = boxes;
      const apart = (p, q) => p.x + p.width <= q.x + 0.5 || q.x + q.width <= p.x + 0.5;
      expect(apart(c, a), 'chip and Actions').toBe(true);
      expect(apart(a, s), 'Actions and Send').toBe(true);
      expect(apart(c, s), 'chip and Send').toBe(true);
      for (const inner of [c, a, s]) {
        expect(inner.x).toBeGreaterThanOrEqual(b.x - 0.5);
        expect(inner.x + inner.width).toBeLessThanOrEqual(b.x + b.width + 0.5);
      }
      // No text paints past the chip, and the remove button doesn't sit on the text.
      expect(await chip.evaluate((el) => [...el.querySelectorAll('[data-chip-label],[data-chip-detail]')].every((t) => t.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5))).toBe(true);
      const label = await chip.locator('[data-chip-label]').boundingBox();
      const remove = await chip.locator('[data-chip-remove]').boundingBox();
      if (label.width > 2) expect(label.x + label.width).toBeLessThanOrEqual(remove.x + 0.5);
      // The full text stays in the name.
      await expect(chip).toHaveAttribute('aria-label', `This message: ${SUBJECT}`);
    } finally {
      await uninstallPlugin(api, ID);
    }
  });
}

test.describe('the date', () => {
  test.use({ timezoneId: 'Europe/Berlin' });

  test('at 00:30 in Berlin the model hears the local date, and tomorrow is the next local day', async ({ page }) => {
    const api = await install(await adminApi(), ID, installPlugin);
    try {
      // Saturday 31 October 2026, 00:30 in Berlin (CET) = 23:30 UTC on Friday.
      await page.clock.setFixedTime(new Date('2026-10-30T23:30:00Z'));
      await setUp(page, api);
      await mockScript('date-berlin', [{ text: 'Noted.' }]);
      await toggle(page).click();
      const frame = page.frameLocator('[data-plugin-detail-panel] iframe');
      await expect(chatInput(frame)).toBeVisible({ timeout: 60_000 });
      await ask(frame, '[[mock:date-berlin]] What do I have tomorrow?');
      await acceptPrivacy(page, { frame });
      await waitDone(frame);
      const [request] = await mockRequests('date-berlin');
      expect(request, 'the request reached the mock').toBeTruthy();
      const system = typeof request.body.system === 'string' ? request.body.system : request.body.system.map((b) => b.text).join('\n');
      expect(system).toContain("Now it is Saturday, 2026-10-31, 00:30 in the user's time zone (Europe/Berlin).");
      expect(system).toContain('Tomorrow is Sunday, 2026-11-01');
      expect(system).not.toContain('2026-10-30, 00:30');
    } finally {
      await uninstallPlugin(api, ID);
    }
  });
});
