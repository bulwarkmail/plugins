import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { installPlugin, uninstallPlugin, preparePage, setPluginConfig, signIn, waitForPlugin } from '../../e2e/helpers.mjs';
import { ID, acceptPrivacy, ask, chatInput, configure, mockReadsChunked, mockRequests, mockScript, waitDone } from './common.mjs';

// Chat tools (package E of the 2.2 work): earlier chats after 8 hours
// without use, saved prompts as / commands, and notes the assistant
// remembers. The panel opens with no message, so no mail is needed.

const toggle = (page) => page.locator('[data-plugin-panel-toggle]');
const SLOT_FRAME = `iframe[title="plugin-${ID}-slot"]`;
const HOUR = 60 * 60 * 1000;
const run = Date.now().toString(36);

async function setUp(page, api, { config = {}, viewport = { width: 1600, height: 900 }, panelWidth } = {}) {
  test.skip(!(await mockReadsChunked()), 'the mock AI server is not running');
  await configure(api);
  for (const [key, value] of Object.entries({ allowChatTools: true, allowMemory: true, prompts: '', ...config })) await setPluginConfig(api, ID, key, value);
  if (panelWidth) await page.addInitScript((w) => { try { localStorage.setItem('emailDetailSidebarWidth', String(w)); } catch { /* blocked */ } }, panelWidth);
  await page.setViewportSize(viewport);
  await preparePage(page);
  await signIn(page);
  await waitForPlugin(page, ID);
}

/** Open the reader's panel with no message and return its frame. */
async function openPanel(page) {
  // The panel remembers whether it was open: ask the button, once it is there.
  await expect(toggle(page).first()).toBeVisible({ timeout: 60_000 });
  if ((await toggle(page).first().getAttribute('aria-pressed')) !== 'true') await toggle(page).first().click();
  const frame = page.frameLocator(`[data-plugin-detail-panel] ${SLOT_FRAME}`);
  await expect(chatInput(frame)).toBeVisible({ timeout: 60_000 });
  return frame;
}

/** The text of the system prompt of a logged request. */
const systemOf = (request) => (typeof request.body.system === 'string' ? request.body.system : request.body.system.map((b) => b.text).join('\n'));
const lastUserText = (request) => {
  const users = request.body.messages.filter((m) => m.role === 'user');
  const content = users.at(-1).content;
  return typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('\n');
};

/** The plugin's settings frame in Settings > AI Assistant. */
async function openSettings(page) {
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'AI Assistant' }).click();
  const frame = page.frameLocator(SLOT_FRAME).first();
  await expect(frame.getByTestId('ai-status')).toBeVisible({ timeout: 30_000 });
  return frame;
}
async function backToMail(page) {
  await page.getByRole('link', { name: 'Mail' }).first().click();
  await expect(toggle(page).first()).toBeVisible({ timeout: 60_000 });
}

/** No part of the frame's page is wider than the frame. */
async function noSideScroll(frameLocator) {
  const body = frameLocator.locator('body');
  const [scroll, client] = await body.evaluate((el) => [el.ownerDocument.documentElement.scrollWidth, el.ownerDocument.documentElement.clientWidth]);
  expect(scroll, 'no horizontal scrolling').toBeLessThanOrEqual(client + 1);
}

test('an idle chat moves to Earlier chats and a fresh one starts; the list works by keyboard', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api, { panelWidth: 280 });
    const name = `e-hist-${run}`;
    await mockScript(name, [{ text: 'Your manager is Jan.' }]);
    let frame = await openPanel(page);
    await ask(frame, `[[mock:${name}]] Who is my manager?`);
    await acceptPrivacy(page, { frame });
    await waitDone(frame);
    await expect(frame.getByText('Your manager is Jan.')).toBeVisible();

    // Make the stored chat 9 hours old instead of moving the clock.
    await page.waitForTimeout(800);
    const moved = await page.evaluate((hours) => {
      const key = Object.keys(localStorage).find((k) => /^plugin:ai-assistant:@[^:]+:chat:reader$/.test(k));
      if (!key) return false;
      const chat = JSON.parse(localStorage.getItem(key));
      const old = Date.now() - hours * 3600_000;
      chat.at = old;
      chat.turns = chat.turns.map((t) => ({ ...t, at: old }));
      localStorage.setItem(key, JSON.stringify(chat));
      return true;
    }, 9);
    expect(moved, 'the running chat is stored').toBe(true);
    await page.reload();
    await waitForPlugin(page, ID);
    frame = await openPanel(page);
    await expect(frame.getByText('Your manager is Jan.')).toHaveCount(0);
    await expect(frame.locator('[data-turn]')).toHaveCount(0);

    // The header button opens the list; the search field takes the focus.
    const button = frame.getByRole('button', { name: 'Earlier chats' });
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    const list = frame.getByRole('list', { name: 'Earlier chats' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(frame.getByRole('searchbox', { name: 'Search chats' })).toBeFocused();
    await noSideScroll(frame);
    // Down to the chat, Enter opens it to read.
    await page.keyboard.press('ArrowDown');
    // The row's button is named by the question, with the date and size as its description.
    const row = list.locator('[data-history-open]');
    await expect(row).toHaveAccessibleName(/^\[\[mock:[^\]]+\]\] Who is my manager\?$/);
    await expect(row).toHaveAccessibleDescription(/2 messages/);
    await expect(row).toBeFocused();
    await expect(frame.getByRole('button', { name: /^Rename “/ })).toHaveCount(1);
    await expect(frame.getByRole('button', { name: /^Delete “/ })).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(frame.getByRole('heading', { name: /Who is my manager\?/ })).toBeFocused();
    await expect(frame.getByText('Your manager is Jan.')).toBeVisible();
    // Escape back to the list (focus on the chat's row), Continue makes it current again.
    await page.keyboard.press('Escape');
    await expect(row).toBeFocused();
    await page.keyboard.press('Enter');
    await frame.getByRole('button', { name: 'Continue this chat' }).click();
    await expect(frame.locator('[data-assistant-transcript]').getByText('Your manager is Jan.')).toBeVisible();
    await expect(frame.getByRole('list', { name: 'Earlier chats' })).toHaveCount(0);
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('a / command runs a saved prompt, by keyboard', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    const name = `e-slash-${run}`;
    await setUp(page, api, { config: { prompts: `Weekly review: [[mock:${name}]] What happened this week?` }, panelWidth: 200 });
    await mockScript(name, [{ text: 'A quiet week.' }]);
    const frame = await openPanel(page);
    const input = chatInput(frame);
    await input.click();
    await input.pressSequentially('/', { delay: 20 });
    const menu = frame.getByRole('listbox', { name: 'Commands and saved prompts' });
    await expect(menu).toBeVisible();
    await expect(input).toHaveAttribute('aria-controls', /.+/);
    // Escape closes the list and keeps the text.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(input).toHaveValue('/');
    await input.pressSequentially('wee', { delay: 20 });
    await expect(menu.getByRole('option')).toHaveCount(1);
    await expect(menu.getByRole('option')).toContainText('Weekly review');
    await expect(menu.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    await noSideScroll(frame);
    await page.keyboard.press('Tab');
    await expect(input).toHaveValue('/weekly-review');
    await page.keyboard.press('Enter');
    await acceptPrivacy(page, { frame });
    await waitDone(frame);
    await expect(frame.getByText('A quiet week.')).toBeVisible();
    await expect(input).toHaveValue('');
    const [request] = await mockRequests(name);
    expect(request, 'the request reached the mock').toBeTruthy();
    expect(lastUserText(request)).toContain('What happened this week?');
    // The saved prompt is in the Actions menu too.
    await frame.getByRole('button', { name: /Actions/ }).click();
    await expect(frame.getByRole('menuitem', { name: 'Weekly review' })).toBeVisible();
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('a remembered note reaches the next request and is gone after delete', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api);
    const remember = `e-remember-${run}`;
    const after = `e-after-${run}`;
    const gone = `e-gone-${run}`;
    await mockScript(remember, [{ text: 'I will.', tools: [{ name: 'remember', input: { note: 'My manager is Jan' } }] }, { text: 'Noted.' }]);
    await mockScript(after, [{ text: 'Jan.' }]);
    await mockScript(gone, [{ text: 'I don\'t know.' }]);

    // Actions on (ask first), in the plugin's settings.
    let settings = await openSettings(page);
    await settings.getByRole('combobox', { name: 'Actions' }).selectOption('manual');
    await expect(settings.getByRole('switch', { name: 'Remember notes' })).toBeChecked();
    await backToMail(page);

    let frame = await openPanel(page);
    await ask(frame, `[[mock:${remember}]] Remember that my manager is Jan`);
    await acceptPrivacy(page, { frame });
    const card = frame.locator('[data-action="remember"]');
    await expect(card).toHaveAttribute('data-action-state', 'waiting', { timeout: 60_000 });
    await expect(card).toContainText('Remember: “My manager is Jan”?');
    await card.getByRole('button', { name: 'Do it' }).click();
    await waitDone(frame);
    await expect(card).toHaveAttribute('data-action-state', 'done');

    await ask(frame, `[[mock:${after}]] Who is my manager?`);
    await waitDone(frame);
    const [withNote] = await mockRequests(after);
    expect(systemOf(withNote)).toContain('Notes the user asked you to remember');
    expect(systemOf(withNote)).toContain('- My manager is Jan');

    // Delete it in the settings (390 px wide: the list fits).
    settings = await openSettings(page);
    const notes = settings.getByRole('list', { name: 'Notes' });
    await expect(notes.getByRole('listitem')).toHaveText(['My manager is Jan']);
    // On a phone the settings page is a list of pages first.
    await page.setViewportSize({ width: 390, height: 844 });
    const entry = page.getByRole('button', { name: 'AI Assistant' });
    if (await entry.isVisible().catch(() => false)) await entry.click();
    await expect(settings.getByRole('list', { name: 'Notes' })).toBeVisible({ timeout: 30_000 });
    await noSideScroll(settings);
    await page.setViewportSize({ width: 1600, height: 900 });
    if (await entry.isVisible().catch(() => false)) await entry.click();
    await settings.getByRole('button', { name: 'Delete the note “My manager is Jan”' }).click();
    await expect(settings.getByText('No notes yet.', { exact: false })).toBeVisible();
    await backToMail(page);

    frame = await openPanel(page);
    await ask(frame, `[[mock:${gone}]] Who is my manager now?`);
    await waitDone(frame);
    const [without] = await mockRequests(gone);
    expect(systemOf(without)).not.toContain('My manager is Jan');
  } finally {
    await uninstallPlugin(api, ID);
  }
});
