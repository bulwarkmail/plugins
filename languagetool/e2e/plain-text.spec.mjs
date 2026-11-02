// Proofreading in the plain-text composer: no underlines in a textarea, so
// the issues are in the list behind the status control.
//
// Plain-text mode is the `plainTextMode` setting; the spec sets it by
// answering the page's settings read (overrideSettings), as there is no
// switch for it in the composer. Same needs as composer.spec.mjs:
// PLUGIN_PROXY_PRIVATE_ORIGINS with the mock, no OpenPGP, BULWARK_ADMIN_PASSWORD.

import { test, expect } from '@playwright/test';
import { adminApi, installPlugin, uninstallPlugin, preparePage, signIn, waitForPlugin } from '../../e2e/helpers.mjs';
import { ID, MOCK_PORT, GERMAN, configure, composeWith, enableProofreading, overrideSettings, ui, webmailUp } from './common.mjs';
import { startMock } from './mock-server.mjs';

let mock = null;
let api = null;

test.beforeAll(async () => {
  test.skip(!(await webmailUp()), 'the webmail is not running (BULWARK_URL)');
  test.skip(!process.env.BULWARK_ADMIN_PASSWORD, 'BULWARK_ADMIN_PASSWORD is not set');
  mock = await startMock(MOCK_PORT);
  api = await adminApi();
  await installPlugin(api, ID);
  await configure(api);
});

test.afterAll(async () => {
  if (api) await uninstallPlugin(api, ID).catch(() => {});
  await mock?.close();
});

test('lists the issues and a suggestion changes the textarea', async ({ page }) => {
  await preparePage(page);
  await overrideSettings(page, { plainTextMode: true });
  await signIn(page);
  await waitForPlugin(page, ID);
  await enableProofreading(page);

  const body = await composeWith(page, GERMAN, { plain: true });
  const status = ui.status(page);
  await expect(status).toBeVisible({ timeout: 30_000 });
  await expect(status).toHaveText(/2/, { timeout: 30_000 });
  await status.click();
  const list = ui.issueList(page);
  await expect(list).toBeVisible();
  const item = list.locator('li').filter({ hasText: 'dem' }).first();
  await expect(item).toBeVisible();
  await ui.replacement(item, 'den').click();
  await expect(body).toHaveValue(GERMAN.replace('dem Brief', 'den Brief'));
});

test('the status control turns proofreading on when it is off', async ({ page }) => {
  await preparePage(page);
  await overrideSettings(page, { plainTextMode: true, proofreading: false });
  await signIn(page);
  await waitForPlugin(page, ID);
  await composeWith(page, GERMAN, { plain: true });
  await ui.status(page).click();
  await expect(ui.panel(page)).toBeVisible();
  await ui.turnOn(page).click();
  // The panel may close on the click; open it again until the list shows.
  const item = ui.issueList(page).locator('li').filter({ hasText: 'Feler' });
  await expect(async () => {
    if (!(await ui.panel(page).isVisible())) await ui.status(page).click();
    await expect(item).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
});
