import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { installPlugin, uninstallPlugin, preparePage, signIn, waitForPlugin } from '../../e2e/helpers.mjs';
import { ID, acceptPrivacy, assistantDialog, chatInput, configure, mockReadsChunked, mockRequests, mockScript, openMessage, waitDone } from './common.mjs';
import { USER, importMessages } from './jmap.mjs';
import { VIEWS, openView, placeFromRight, seedTodayEvent, toggle, viewPanel } from './everywhere.mjs';

// The assistant everywhere (package F of the 2.2 work): the panel next to
// Calendar, Contacts, Files and Settings, its button in the same place as
// in Mail, Alt+A in every view, Catch me up, and the dialog on a phone.

// A message of its own for the reader, so the search finds one row.
const SUBJECT = `Everywhere reader ${Date.now()}`;
test.use({ timezoneId: 'Europe/Berlin' });

test.beforeAll(async () => {
  if (process.env.BULWARK_JMAP_URL) {
    await importMessages([{ messageId: `everywhere-reader-${Date.now()}@e2e.bulwark.test`, from: 'Carol <carol@example.org>', to: USER, subject: SUBJECT, text: 'Shall we go through the plan on Thursday?' }]);
  }
});

async function setUp(page, api, { viewport = { width: 1600, height: 900 }, config = {} } = {}) {
  test.skip(!(await mockReadsChunked()), 'the mock AI server is not running');
  await configure(api, config);
  await page.setViewportSize(viewport);
  await preparePage(page);
  await signIn(page);
  await waitForPlugin(page, ID);
}

/** The h-14 row a button sits in, and whether the button is its last one. */
async function rowOf(button) {
  return button.evaluate((el) => {
    const row = el.closest('.h-14');
    if (!row) return null;
    const buttons = [...row.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
    // The row's own height, without its bottom border.
    return { height: row.clientHeight, last: buttons[buttons.length - 1] === el };
  });
}

test('the panel button sits at the end of the h-14 row in every view, where Mail has it', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api);
    await expect(toggle(page)).toHaveCount(1, { timeout: 60_000 });
    const mailEmpty = await placeFromRight(page, toggle(page));
    expect(await rowOf(toggle(page))).toEqual({ height: 56, last: true });
    await openMessage(page, SUBJECT, page.getByRole('row', { name: new RegExp(SUBJECT) }).first());
    await expect(page.locator('[data-viewer-top-toolbar="full-width"]:not([data-toolbar-toggle-only])')).toBeVisible();
    const mailMessage = await placeFromRight(page, toggle(page));
    expect(mailMessage).toEqual(mailEmpty);

    for (const view of VIEWS) {
      await openView(page, view);
      const button = toggle(page);
      // Named for screen readers, and says whether the panel is open.
      await expect(button).toHaveAccessibleName('Show plugin panel');
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      expect(await rowOf(button), `${view}: the button ends an h-14 row`).toEqual({ height: 56, last: true });
      expect(await placeFromRight(page, button), `${view}: the same place as in Mail`).toEqual(mailEmpty);
      await button.click();
      const { host, frame } = viewPanel(page);
      await expect(host).toBeVisible();
      await expect(chatInput(frame)).toBeVisible({ timeout: 60_000 });
      // Open, it stays where it was, under its new name.
      await expect(button).toHaveAccessibleName('Hide plugin panel');
      expect(await placeFromRight(page, button), `${view}: open`).toEqual(mailEmpty);
      // The panel runs from under the row to the bottom, at the window's right edge.
      const panelBox = await host.boundingBox();
      expect(Math.round(panelBox.x + panelBox.width)).toBe(page.viewportSize().width);
      expect(Math.round(panelBox.y)).toBeGreaterThanOrEqual(mailEmpty.top + mailEmpty.height);
      await expect(page.getByRole('separator', { name: /side panel/i })).toBeVisible();
      await button.click();
      await expect(host).toHaveCount(0);
    }
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('Alt+A opens the panel of each view, and Escape closes it with the focus back on its button', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api);
    for (const view of VIEWS) {
      await openView(page, view);
      const { host, frame } = viewPanel(page);
      await expect(host).toHaveCount(0);
      // The shortcut skips text fields, and Contacts puts the focus into its
      // search once its list is in: start from the panel button, as a
      // keyboard user would, and again if the page took the focus away.
      await expect(async () => {
        if (await host.isVisible()) return;
        await toggle(page).focus();
        await page.keyboard.press('Alt+a');
        await expect(host).toBeVisible({ timeout: 3000 });
      }, `${view}: Alt+A opens the panel`).toPass({ timeout: 30_000 });
      await expect(chatInput(frame), `${view}: the input takes the focus`).toBeFocused({ timeout: 60_000 });
      await chatInput(frame).press('Escape');
      await expect(host, `${view}: Escape closes it`).toHaveCount(0);
      await expect(toggle(page), `${view}: the focus goes back to the button`).toBeFocused();
    }
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('Catch me up lists the unread mail and today\'s events', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    const stamp = Date.now();
    const title = `Everywhere check-in ${stamp}`;
    const subject = `Catch-up test ${stamp}`;
    await seedTodayEvent(title);
    const [emailId] = await importMessages([{ messageId: `catch-up-${stamp}@e2e.bulwark.test`, from: 'Carol <carol@example.org>', to: USER, subject, text: 'Can you sign the contract by Friday?' }]);
    // The model's answer: the message as one that needs an answer.
    await mockScript('everywhere-brief', [{ text: `Needs an answer\n<widget>${JSON.stringify({ type: 'emails', items: [{ id: emailId, subject, from: 'Carol' }] })}</widget>\nSign the contract first.` }]);
    await setUp(page, api, { config: { instructions: '[[mock:everywhere-brief]]' } });
    await openView(page, 'calendar');
    await toggle(page).click();
    const { frame } = viewPanel(page);
    await frame.getByRole('button', { name: 'Catch me up' }).click();
    await acceptPrivacy(page, { frame, expectText: 'Catch me up also sends your unread mail' });
    await waitDone(frame);

    // The newest request of this script (earlier runs used it too).
    const request = (await mockRequests('everywhere-brief')).at(-1);
    expect(request, 'the request reached the mock').toBeTruthy();
    const last = request.body.messages.at(-1);
    const sent = typeof last.content === 'string' ? last.content : last.content.map((b) => b.text ?? '').join('\n');
    expect(sent).toContain(subject);
    expect(sent).toContain(title);

    const turn = frame.locator('[data-turn="assistant"]').last();
    await expect(turn.locator('[data-widget="emails"]').first()).toContainText(subject);
    await expect(turn.locator('[data-widget="calendar"]')).toContainText(title);
    await expect(turn.getByText('Today', { exact: true })).toBeVisible();
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('on a phone the header button opens the assistant as a dialog with the view', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api, { viewport: { width: 390, height: 844 } });
    await openView(page, 'calendar', { button: false });
    const phone = page.locator('[data-app-side-panel-phone]');
    await expect(phone).toBeVisible({ timeout: 60_000 });
    await expect(phone).toHaveAccessibleName('Show plugin panel');
    await expect(toggle(page)).toHaveCount(0);
    // By keyboard: focus it and press Enter.
    await phone.focus();
    await page.keyboard.press('Enter');
    const { box, frame } = assistantDialog(page);
    await expect(box).toBeVisible();
    await expect(chatInput(frame)).toBeVisible({ timeout: 60_000 });
    await expect(frame.locator('[data-assistant-view-dialog="calendar"]')).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Catch me up' })).toBeVisible();
    const dialogBox = await box.boundingBox();
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(390);
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('Settings below 1024 px has no panel, and its header button opens the dialog', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api, { viewport: { width: 900, height: 800 } });
    await openView(page, 'settings', { button: false });
    await expect(toggle(page)).toHaveCount(0);
    const phone = page.locator('[data-app-side-panel-phone]').first();
    await expect(phone).toBeVisible({ timeout: 60_000 });
    await phone.click();
    const { box, frame } = assistantDialog(page);
    await expect(box).toBeVisible();
    await expect(frame.locator('[data-assistant-view-dialog="settings"]')).toBeVisible({ timeout: 60_000 });
  } finally {
    await uninstallPlugin(api, ID);
  }
});
