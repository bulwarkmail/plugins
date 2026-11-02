// Shared steps of the LanguageTool plugin's end-to-end tests.
//
// Needs, besides what e2e/helpers.mjs says (a running webmail signed in to
// the test Stalwart, BULWARK_ADMIN_PASSWORD):
// - the webmail started with PLUGIN_PROXY_PRIVATE_ORIGINS listing the mock
//   (default http://localhost:18110), or the proxy refuses the private
//   address. A webmail in Docker reaches the mock on the host as
//   http://host.docker.internal:18110: set LT_MOCK_URL to that and list it.
// - no OpenPGP plugin running: the webmail checks nothing while a plugin
//   that signs or encrypts without saying so in the Options menu runs.
// The specs start the mock themselves (mock-server.mjs) and skip when the
// webmail isn't reachable.

import { expect } from '@playwright/test';
import { BASE, setPluginConfig } from '../../e2e/helpers.mjs';

export const ID = 'languagetool';
export const MOCK_URL = process.env.LT_MOCK_URL || 'http://localhost:18110';
export const MOCK_PORT = Number(process.env.LT_MOCK_PORT) || Number(new URL(MOCK_URL).port) || 18110;

export const GERMAN = 'Ich habe gestern dem Brief geschrieben. Das ist ein Feler.';
export const ENGLISH = 'I has two question about teh offer.';

/** Whether the webmail answers at all; specs skip without it. */
export async function webmailUp() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    return res.status > 0;
  } catch {
    return false;
  }
}

/** Admin config pointing at the mock; pass overrides. */
export async function configure(api, overrides = {}) {
  const values = {
    serverUrl: MOCK_URL,
    allowPublicApi: false,
    level: 'default',
    defaultLanguage: 'auto',
    preferredVariants: '',
    disabledRules: '',
    disabledCategories: '',
    wordList: '',
    userMayChange: true,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) await setPluginConfig(api, ID, key, value);
}

/**
 * Every selector of the webmail's proofreading UI, in one place, so a
 * change there is one edit here.
 */
export const ui = {
  /** An underline, optionally of one kind and around one word. */
  issue: (page, { kind, text } = {}) => {
    let loc = page.locator(kind ? `[data-text-issue].text-issue-${kind}` : '[data-text-issue]');
    if (text) loc = loc.filter({ hasText: new RegExp(`^${text}$`) });
    return loc;
  },
  popup: (page) => page.locator('[data-testid="proofreading-popup"]'),
  replacement: (scope, text) => scope.locator('[data-testid="proofreading-replacement"]').filter({ hasText: new RegExp(`^${text}$`) })
    .or(scope.getByRole('button', { name: `Replace with ${text}`, exact: true })).first(),
  ignore: (scope) => scope.getByRole('button', { name: 'Ignore', exact: true }),
  addToDictionary: (scope) => scope.getByRole('button', { name: 'Add to dictionary', exact: true }),
  disableRule: (scope) => scope.getByRole('button', { name: 'Turn off this rule', exact: true }),
  status: (page) => page.locator('[data-testid="proofreading-status"]').first(),
  panel: (page) => page.locator('[data-testid="proofreading-panel"]'),
  turnOn: (page) => page.locator('[data-testid="proofreading-turn-on"]'),
  issueList: (page) => page.locator('[data-testid="proofreading-issue-list"]'),
  notice: (page) => page.locator('[data-testid="proofreading-notice"]'),
  settingSwitch: (page) => page.locator('[data-testid="settings-proofreading"]'),
  editor: (page) => page.locator('[contenteditable="true"]').first(),
  plainBody: (page) => page.getByRole('textbox', { name: 'Message', exact: true }),
};

/** Turn on the webmail's Proofreading setting (Settings > Composing). */
export async function enableProofreading(page) {
  await page.goto(`${BASE}/settings/composing`, { waitUntil: 'domcontentloaded' });
  const toggle = ui.settingSwitch(page);
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
}

/**
 * Answer the page's settings reads with these values merged in (the
 * account's synced settings win over localStorage after load). Used for
 * plain-text mode, which has no switch in the composer.
 */
export async function overrideSettings(page, values, { theme = 'light' } = {}) {
  await page.route(/\/api\/settings(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch();
    let json = null;
    try { json = await response.json(); } catch { /* not JSON */ }
    if (json && json.settings && typeof json.settings === 'object') {
      Object.assign(json.settings, { theme, ...values });
      await route.fulfill({ response, json });
    } else {
      await route.fulfill({ response });
    }
  });
}

/** Open the composer and type one paragraph (rich editor or plain text). */
export async function composeWith(page, text, { plain = false } = {}) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Compose' }).first().click();
  const box = plain ? ui.plainBody(page) : ui.editor(page);
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.click();
  await box.pressSequentially(text, { delay: 5 });
  // The one-time notice would cover the text on small screens.
  const notice = ui.notice(page);
  if (await notice.isVisible().catch(() => false)) await notice.getByRole('button', { name: 'OK' }).click();
  return box;
}

export async function editorText(page) {
  return (await ui.editor(page).innerText()).replace(/\r/g, '').split('\n')[0];
}
