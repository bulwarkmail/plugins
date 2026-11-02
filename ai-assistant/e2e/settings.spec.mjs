import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { installPlugin, uninstallPlugin, preparePage, setPluginConfig, signIn, waitForPlugin, shoot } from '../../e2e/helpers.mjs';

// Settings: which service is used, and connecting the user's own key
// through the host's dialog (the key goes to the server, never the plugin).

const ID = 'ai-assistant';
const MOCK = 'http://localhost:18099';

async function configure(api, extra = {}) {
  const values = {
    anthropicBaseUrl: `${MOCK}/anthropic/v1`,
    anthropicKey: 'test-anthropic-key',
    anthropicModel: 'mock-claude',
    defaultProvider: 'anthropic',
    allowUserKeys: true,
    ...extra,
  };
  for (const [key, value] of Object.entries(values)) await setPluginConfig(api, ID, key, value);
}

function settingsFrame(page) {
  return page.frameLocator(`iframe[title="plugin-${ID}-slot"]`).first();
}

async function openSettings(page) {
  // In-app navigation: plugins start with the mail view.
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'AI Assistant' }).click();
  await expect(settingsFrame(page).getByTestId('ai-status')).toBeVisible({ timeout: 30_000 });
}

for (const theme of ['light', 'dark']) {
  test(`settings show the admin's service and connect an own key (${theme})`, async ({ page }) => {
    const api = await install(await adminApi(), ID, installPlugin);
    try {
      await configure(api);
      await preparePage(page, { theme });
      await signIn(page);
      await waitForPlugin(page, ID);
      await openSettings(page);
      const frame = settingsFrame(page);
      await expect(frame.getByTestId('ai-status')).toHaveText('Uses Anthropic at localhost:18099, model mock-claude, set up by your administrator.');
      // The lookups (calendar, contacts, the original message) are on by default and can be turned off.
      const lookups = frame.getByRole('switch', { name: 'Let the assistant look things up' });
      await expect(lookups).toBeChecked();
      await lookups.click();
      await expect(lookups).not.toBeChecked();
      await lookups.click();
      await expect(lookups).toBeChecked();
      await shoot(page, ID, 'settings', theme);

      // Connect the user's own OpenAI-compatible key (the mock's).
      await frame.getByLabel('Service').last().selectOption('openai');
      await frame.getByLabel('API address').fill(`${MOCK}/openai/v1`);
      await frame.getByLabel('Model').last().fill('mock-gpt-small');
      await frame.getByRole('button', { name: 'Connect your key' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Connect Your OpenAI-compatible API key');
      await expect(dialog.getByLabel('Server address')).toHaveValue(`${MOCK}/openai/v1`);
      await dialog.getByLabel('Password or key').fill('test-openai-key');
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(frame.getByTestId('ai-status')).toHaveText('Uses OpenAI-compatible at localhost:18099, model mock-gpt-small, with your own key.');
      await shoot(page, ID, 'settings-own-key', theme);

      await frame.getByRole('button', { name: 'Stop using my key' }).click();
      await expect(frame.getByTestId('ai-status')).toContainText('set up by your administrator');
    } finally {
      await uninstallPlugin(api, ID);
    }
  });
}
