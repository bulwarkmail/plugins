import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { installPlugin, uninstallPlugin, preparePage, setPluginConfig, signIn, waitForPlugin } from '../../e2e/helpers.mjs';
import { ID, MOCK, acceptPrivacy, ask, chatInput, configure, mockReadsChunked, mockRequests, mockScript, waitDone } from './common.mjs';

// OpenAI's newer models only call tools through the Responses API. The
// mock's mock-gpt-reasoning refuses tools in chat completions as they do,
// and its /responses returns a reasoning item with each tool call, which
// can't go back without its encrypted content when nothing is stored.

const toggle = (page) => page.locator('[data-plugin-panel-toggle]');
const SLOT_FRAME = `iframe[title="plugin-${ID}-slot"]`;
const run = Date.now().toString(36);

async function setUp(page, api, openaiApi) {
  test.skip(!(await mockReadsChunked()), 'the mock AI server is not running');
  await configure(api, {
    anthropicBaseUrl: '',
    anthropicKey: '',
    openaiBaseUrl: `${MOCK}/openai/v1`,
    openaiKey: 'test-openai-key',
    openaiModel: 'mock-gpt-reasoning',
    openaiApi,
    defaultProvider: 'openai',
  });
  for (const [key, value] of Object.entries({ allowChatTools: true, allowMemory: true, prompts: '' })) await setPluginConfig(api, ID, key, value);
  await page.setViewportSize({ width: 1600, height: 900 });
  await preparePage(page);
  await signIn(page);
  await waitForPlugin(page, ID);
  // Actions on (ask first), so the chat offers the remember tool.
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'AI Assistant' }).click();
  const settings = page.frameLocator(SLOT_FRAME).first();
  await expect(settings.getByTestId('ai-status')).toBeVisible({ timeout: 30_000 });
  await settings.getByRole('combobox', { name: 'Actions' }).selectOption('manual');
  await expect(settings.getByRole('switch', { name: 'Remember notes' })).toBeChecked();
  await page.getByRole('link', { name: 'Mail' }).first().click();
}

/** Open the reader's panel with no message and return its frame. */
async function openPanel(page) {
  const frame = page.frameLocator(`[data-plugin-detail-panel] ${SLOT_FRAME}`);
  // The panel remembers whether it was open, and may only learn so after the first look.
  await expect(async () => {
    if ((await toggle(page).first().getAttribute('aria-pressed')) !== 'true') await toggle(page).first().click();
    await expect(chatInput(frame)).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 90_000 });
  return frame;
}

test('with the Responses API, a reasoning model calls a tool and gets the result', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api, 'responses');
    const name = `e-responses-${run}`;
    await mockScript(name, [{ text: 'I will.', tools: [{ name: 'remember', input: { note: 'My manager is Jan' } }] }, { text: 'Noted.' }]);

    const frame = await openPanel(page);
    await ask(frame, `[[mock:${name}]] Remember that my manager is Jan`);
    await acceptPrivacy(page, { frame });
    const card = frame.locator('[data-action="remember"]');
    await expect(card).toHaveAttribute('data-action-state', 'waiting', { timeout: 60_000 });
    await card.getByRole('button', { name: 'Do it' }).click();
    await waitDone(frame);
    await expect(card).toHaveAttribute('data-action-state', 'done');
    await expect(frame.getByText('Noted.')).toBeVisible();

    const requests = await mockRequests(name);
    expect(requests.map((r) => [r.path, r.provider, r.step])).toEqual([
      ['/openai/v1/responses', 'openai-responses', 0],
      ['/openai/v1/responses', 'openai-responses', 1],
    ]);
    const [first, second] = requests.map((r) => r.body);
    // Stateless and not stored at OpenAI; the tools in the Responses shape.
    expect(first).toMatchObject({ model: 'mock-gpt-reasoning', store: false, stream: true });
    expect(first.previous_response_id).toBeUndefined();
    expect(first.tools).toContainEqual(expect.objectContaining({ type: 'function', name: 'remember', strict: false }));
    // The model's text and call go back without ids (nothing is stored at
    // OpenAI), followed by the result; its reasoning came without encrypted
    // content, so it can't go back (the mock refuses it as OpenAI does).
    const items = second.input.filter((m) => m.type);
    expect(items.map((m) => [m.type, m.id, m.call_id])).toEqual([
      ['message', undefined, undefined],
      ['function_call', undefined, 'call_mock_0_0'],
      ['function_call_output', undefined, 'call_mock_0_0'],
    ]);
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('with chat completions, a model that needs the Responses API says where to switch', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api, 'chat');
    const frame = await openPanel(page);
    await ask(frame, 'Who is my manager?');
    await acceptPrivacy(page, { frame });
    const alert = frame.getByRole('alert').filter({ hasText: 'needs the Responses API' });
    await expect(alert).toBeVisible({ timeout: 60_000 });
    await expect(alert).toContainText('"OpenAI-compatible: API"');
    await expect(alert).toContainText('use /v1/responses');
    const [last] = (await mockRequests()).filter((r) => r.path === '/openai/v1/chat/completions').slice(-1);
    expect(last.body.tools?.length).toBeGreaterThan(0);
  } finally {
    await uninstallPlugin(api, ID);
  }
});
