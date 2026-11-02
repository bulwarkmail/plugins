// Proofreading in the rich composer against a mock LanguageTool.
//
// Needs the webmail started with PLUGIN_PROXY_PRIVATE_ORIGINS=http://localhost:18110
// (or the LT_MOCK_URL you set), no OpenPGP plugin, and BULWARK_ADMIN_PASSWORD.
// See common.mjs. Skips when the webmail isn't reachable.

import { test, expect } from '@playwright/test';
import { adminApi, installPlugin, uninstallPlugin, preparePage, signIn, waitForPlugin } from '../../e2e/helpers.mjs';
import { ID, MOCK_PORT, GERMAN, ENGLISH, configure, composeWith, editorText, enableProofreading, ui, webmailUp } from './common.mjs';
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

test.beforeEach(async ({ page }) => {
  mock.requests.length = 0;
  await preparePage(page);
  await signIn(page);
  await waitForPlugin(page, ID);
  await enableProofreading(page);
});

test('underlines "dem", puts "den" in from the popup, and Ctrl+Z takes it back', async ({ page }) => {
  const box = await composeWith(page, GERMAN);
  const dem = ui.issue(page, { kind: 'grammar', text: 'dem' });
  await expect(dem).toBeVisible({ timeout: 30_000 });
  await expect(ui.issue(page, { kind: 'spelling', text: 'Feler' })).toBeVisible();
  // Sent through the proxy as a form with the text and no token.
  expect(mock.requests.length).toBeGreaterThan(0);
  expect(mock.requests.at(-1)).toMatchObject({ language: 'auto', enabledOnly: 'false' });
  expect(mock.requests.at(-1).full).toContain(GERMAN);
  expect(mock.requests.at(-1).authorization).toBeNull();

  await dem.click();
  const popup = ui.popup(page);
  await expect(popup).toBeVisible();
  await ui.replacement(popup, 'den').click();
  await expect.poll(() => editorText(page)).toBe(GERMAN.replace('dem Brief', 'den Brief'));
  await expect(ui.issue(page, { text: 'dem' })).toHaveCount(0);

  await box.press('ControlOrMeta+z');
  await expect.poll(() => editorText(page)).toBe(GERMAN);
});

test('Ignore hides one issue, Add to dictionary keeps a word from being marked again', async ({ page }) => {
  await composeWith(page, ENGLISH);
  const teh = ui.issue(page, { kind: 'spelling', text: 'teh' });
  const has = ui.issue(page, { kind: 'grammar', text: 'has' });
  await expect(teh).toBeVisible({ timeout: 30_000 });
  await expect(has).toBeVisible();

  await has.click();
  await ui.ignore(ui.popup(page)).click();
  await expect(has).toHaveCount(0);

  await teh.click();
  await ui.addToDictionary(ui.popup(page)).click();
  await expect(teh).toHaveCount(0);
  // The recheck the plugin asks for is answered from its cache: the word
  // stays unmarked, and the paragraph isn't sent again.
  const sent = mock.requests.length;
  await page.waitForTimeout(2500);
  await expect(teh).toHaveCount(0);
  expect(mock.requests.length).toBe(sent);
});

test('the keyboard moves to the next issue and opens its popup', async ({ page }) => {
  const box = await composeWith(page, GERMAN);
  await expect(ui.issue(page, { kind: 'grammar', text: 'dem' })).toBeVisible({ timeout: 30_000 });
  await box.press('Home');
  await box.press("ControlOrMeta+'");
  const popup = ui.popup(page);
  await expect(popup).toBeVisible();
  await expect(popup.locator('[data-testid="proofreading-replacement"]').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
});
