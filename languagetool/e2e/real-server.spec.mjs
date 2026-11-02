// Against a real LanguageTool server, by hand: set LT_REAL_URL to it (and
// add it to the webmail's PLUGIN_PROXY_PRIVATE_ORIGINS). Skipped otherwise.
// Logs every request the plugin sends (what text went where), and takes
// the screenshots for the README and the extension directory in light and
// dark: <plugin>/screenshots/*.png and, with SHOTS_WEBP=1, the directory's
// media/screenshots/*.webp.
//
// Uses mistakes LanguageTool catches without n-gram data: "Wir gehst"
// (agreement), "gelessen" (spelling), "I has" and "teh".

import fs from 'node:fs';
import path from 'node:path';
import { test, expect, request as playwrightRequest } from '@playwright/test';
import { adminApi, installPlugin, uninstallPlugin, preparePage, signIn, waitForPlugin, shoot, BASE, REPO } from '../../e2e/helpers.mjs';
import { ID, configure, composeWith, enableProofreading, overrideSettings, ui } from './common.mjs';

const REAL = process.env.LT_REAL_URL;
const GERMAN = 'Wir gehst morgen ins Kino. Ich habe den Brief schon gelessen.';
const ENGLISH = 'I has two question about teh offer.';
const sent = [];
let api = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!REAL, 'LT_REAL_URL is not set');
  api = await adminApi();
  await installPlugin(api, ID);
  await configure(api, { serverUrl: REAL, preferredVariants: 'de-DE,en-GB' });
});

test.afterAll(async () => {
  if (api) await uninstallPlugin(api, ID).catch(() => {});
  if (sent.length) console.log(`\nSent to ${REAL}:\n${sent.join('\n')}`);
});

function logRequests(page) {
  page.on('request', (req) => {
    if (!req.url().includes('/api/plugin-proxy') || !req.url().includes('plugin=languagetool')) return;
    const form = new URLSearchParams(req.postData() ?? '');
    const target = new URL(req.url()).searchParams.get('url');
    let text = form.get('text') ?? '';
    try { text = text || JSON.parse(form.get('data') ?? '{}').annotation.map((a) => a.text ?? (a.interpretAs ? '·' : '')).join(''); } catch { /* kept as is */ }
    sent.push(`${new Date().toISOString()} ${target} language=${form.get('language')} level=${form.get('level')} text=${JSON.stringify(text)}`);
  });
}

async function webp(page, n, name, theme) {
  if (!process.env.SHOTS_WEBP) return;
  const { default: sharp } = await import('sharp');
  const dir = path.join(REPO, ID, 'media', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  await sharp(await page.screenshot({ type: 'png' })).webp({ quality: 84, effort: 6 }).toFile(path.join(dir, `${n}-${name}${theme === 'dark' ? '-dark' : ''}.webp`));
}

for (const theme of ['light', 'dark']) {
  test(`checks German and English, and fixes a word (${theme})`, async ({ page }) => {
    logRequests(page);
    await preparePage(page, { theme });
    await signIn(page);
    await waitForPlugin(page, ID);
    await enableProofreading(page);
    const box = await composeWith(page, GERMAN);
    const gehst = ui.issue(page, { kind: 'grammar', text: 'Wir gehst' });
    const gelessen = ui.issue(page, { kind: 'spelling', text: 'gelessen' });
    await expect(gehst).toBeVisible({ timeout: 30_000 });
    await expect(gelessen).toBeVisible();
    await gelessen.click();
    const popup = ui.popup(page);
    await expect(popup).toBeVisible();
    await shoot(page, ID, 'composer-popup', theme);
    await webp(page, 1, 'popup', theme);
    await popup.getByRole('button', { name: 'Replace with gelesen' }).click();
    await expect(box).toContainText('Ich habe den Brief schon gelesen.');

    await page.getByTestId('proofreading-status').first().click();
    await expect(page.getByTestId('proofreading-issue-list')).toBeVisible();
    await shoot(page, ID, 'issue-list', theme);
    await webp(page, 2, 'issue-list', theme);
    await page.keyboard.press('Escape');

    await box.press('End');
    await box.press('Enter');
    await box.pressSequentially(ENGLISH, { delay: 5 });
    await expect(ui.issue(page, { kind: 'spelling', text: 'teh' })).toBeVisible({ timeout: 30_000 });
  });
}

test('lists the issues in plain-text mode', async ({ page }) => {
  logRequests(page);
  await overrideSettings(page, { plainTextMode: true, proofreading: true });
  await signIn(page);
  await waitForPlugin(page, ID);
  await composeWith(page, GERMAN, { plain: true });
  const status = page.getByTestId('proofreading-status').first();
  await expect(status).toContainText(/2 issues/, { timeout: 30_000 });
  await status.click();
  await shoot(page, ID, 'plain-text', 'light');
  await webp(page, 3, 'plain-text', 'light');
});

test('settings for users and admins', async ({ page, browser }) => {
  // The address an admin would typically use, for the screenshots.
  await configure(api, { serverUrl: 'http://languagetool:8010', preferredVariants: 'de-DE,en-GB' });
  await preparePage(page);
  await signIn(page);
  await waitForPlugin(page, ID);
  await page.goto(`${BASE}/settings/composing/proofreading`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('settings-proofreading')).toBeVisible({ timeout: 60_000 });
  await shoot(page, ID, 'settings-composing', 'light');
  await page.goto(`${BASE}/settings/${encodeURIComponent(`plugin:${ID}`)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await shoot(page, ID, 'settings-plugin', 'light');
  await webp(page, 4, 'settings', 'light');

  const state = process.env.BULWARK_ADMIN_STATE;
  if (!state) return;
  const admin = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 800 } });
  const adminPage = await admin.newPage();
  await adminPage.goto(`${BASE}/admin/plugins/${ID}`, { waitUntil: 'domcontentloaded' });
  await adminPage.waitForTimeout(4000);
  // The plugin's own configuration, further down the page.
  await adminPage.getByText('LanguageTool server', { exact: true }).first().evaluate((el) => {
    const section = el.closest('section') ?? el;
    (section.querySelector('h2, h3') ?? section).scrollIntoView({ block: 'start' });
  }).catch(() => {});
  await adminPage.waitForTimeout(500);
  await shoot(adminPage, ID, 'admin-config', 'light');
  await webp(adminPage, 5, 'admin', 'light');
  await adminPage.goto(`${BASE}/admin/org-proofreading`, { waitUntil: 'domcontentloaded' });
  await adminPage.waitForTimeout(4000);
  await shoot(adminPage, ID, 'admin-organisation', 'light');
  await admin.close();
  void playwrightRequest;
});
