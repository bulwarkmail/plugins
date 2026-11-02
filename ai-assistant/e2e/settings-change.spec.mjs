import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { BASE, installPlugin, uninstallPlugin } from '../../e2e/helpers.mjs';
import { ID, acceptPrivacy, ask, mockScript, openMessage, readerPanel, waitDone } from './common.mjs';
import { importMessages, USER } from './jmap.mjs';
import { answerCard, card, runTag, setUp, turnOnActions } from './actions.mjs';

// Changing a setting from the assistant's panel (package C of the 2.2
// work): only when the admin allows it and the user turned it on, only
// after the user's OK, shown on the settings page at once, undone with
// Undo; a setting off the allow-list and one the admin locked are refused.

const CONFIG = { allowSettingsChanges: true };

async function panel(page, tag) {
  const subject = `Settings note ${tag}`;
  await importMessages([{ messageId: `settings-${tag}@e2e.bulwark.test`, from: 'Carol <carol@example.org>', to: USER, subject, text: `Settings test ${tag}.` }]);
  await openMessage(page, subject);
  return (await readerPanel(page)).frame;
}

/** Settings > General, where the time format is chosen. */
async function openGeneral(page) {
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'General', exact: true }).first().click();
  await expect(page.getByText('Time format', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
}

/** Settings > General in `tab` shows `label` chosen (reloading while the sync catches up). */
async function showsTimeFormat(tab, label) {
  await expect(async () => {
    await tab.reload();
    await openGeneral(tab);
    await expect(tab.getByRole('group', { name: 'Time format' }).getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
  }).toPass({ timeout: 60_000 });
}

/** The admin's policy, changed by `edit`, put back by the returned function. */
async function withPolicy(api, edit) {
  const cur = await (await api.get('/api/admin/policy')).json();
  const before = structuredClone(cur.policy ?? cur);
  const next = structuredClone(before);
  edit(next);
  const res = await api.put('/api/admin/policy', { data: next });
  expect(res.ok()).toBe(true);
  return async () => { await api.put('/api/admin/policy', { data: before }); };
}

test('a setting changes only after OK, shows on its page, and Undo puts it back', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    const tag = runTag();
    await mockScript('c-set', [
      { text: 'Changing it.', tools: [{ name: 'change_setting', input: { key: 'timeFormat', value: '12h' } }] },
      { text: 'Done: {{tool_results}}' },
    ]);
    await setUp(page, api, test, CONFIG);
    await turnOnActions(page, ['Change my settings']);
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('settings-storage') ?? '{}').state?.timeFormat ?? '24h');
    expect(before).toBe('24h');
    await page.getByRole('link', { name: 'Mail' }).first().click();
    const frame = await panel(page, tag);
    await ask(frame, '[[mock:c-set]] use 12-hour time');
    await acceptPrivacy(page, { frame });

    const c = card(frame, 'change_setting');
    await expect(c).toHaveAttribute('data-action-state', 'waiting', { timeout: 60_000 });
    // "Time format: 24-hour → 12-hour", in the page's own words.
    await expect(c).toContainText('Time format');
    await expect(c).toContainText('→');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('settings-storage') ?? '{}').state?.timeFormat)).not.toBe('12h');
    await answerCard(frame, 'change_setting');
    await waitDone(frame);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('settings-storage') ?? '{}').state?.timeFormat)).toBe('12h');

    // The settings page shows the new value (a second tab of the same session).
    // It syncs within seconds; reload until the other tab has it.
    const settings = await page.context().newPage();
    await settings.goto(BASE);
    await showsTimeFormat(settings, '12-hour');

    const again = frame;
    await card(again, 'change_setting').getByRole('button', { name: 'Undo' }).click();
    await expect(card(again, 'change_setting')).toHaveAttribute('data-action-state', 'undone', { timeout: 30_000 });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('settings-storage') ?? '{}').state?.timeFormat)).toBe('24h');
    await showsTimeFormat(settings, '24-hour');
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('a setting off the allow-list and one the admin locked are refused', async ({ page }) => {
  // One admin session for both: admin sign-in is rate limited.
  const admin = await adminApi();
  const api = await install(admin, ID, installPlugin);
  const restore = await withPolicy(admin, (p) => {
    p.restrictions = { ...(p.restrictions ?? {}), timeFormat: { locked: true, value: '24h' } };
  });
  try {
    const tag = runTag();
    await mockScript('c-denied', [
      { text: 'Trying.', tools: [{ name: 'change_setting', input: { key: 'externalContentPolicy', value: 'allow' } }] },
      { text: 'Result: {{tool_results}}' },
    ]);
    await mockScript('c-locked', [
      { text: 'Trying.', tools: [{ name: 'change_setting', input: { key: 'timeFormat', value: '12h' } }] },
      { text: 'Result: {{tool_results}}' },
    ]);
    await setUp(page, api, test, CONFIG);
    await turnOnActions(page, ['Change my settings']);
    const frame = await panel(page, tag);

    await ask(frame, '[[mock:c-denied]] load remote images always');
    await acceptPrivacy(page, { frame });
    await waitDone(frame);
    await expect(frame.getByText("The assistant can't change this setting.").last()).toBeVisible();
    await expect(card(frame, 'change_setting').getByRole('button', { name: 'Do it' })).toHaveCount(0);

    await ask(frame, '[[mock:c-locked]] use 12-hour time');
    await waitDone(frame);
    await expect(frame.getByText('This setting is set by your organisation.').last()).toBeVisible();
    await expect(card(frame, 'change_setting').getByRole('button', { name: 'Do it' })).toHaveCount(0);

    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('settings-storage') ?? '{}').state ?? {});
    expect(state.externalContentPolicy ?? 'ask').not.toBe('allow');
    expect(state.timeFormat ?? '24h').toBe('24h');
  } finally {
    await restore();
    await uninstallPlugin(api, ID);
  }
});
