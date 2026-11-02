// Shared steps of the assistant's end-to-end tests.

import { expect } from '@playwright/test';
import { setPluginConfig } from '../../e2e/helpers.mjs';

export const ID = 'ai-assistant';
export const MOCK = 'http://localhost:18099';
const SLOT_FRAME = `iframe[title="plugin-${ID}-slot"]`;

/** Admin config: Anthropic mock by default; pass overrides (null clears a key). */
export async function configure(api, overrides = {}) {
  const values = {
    anthropicBaseUrl: `${MOCK}/anthropic/v1`,
    anthropicKey: 'test-anthropic-key',
    anthropicModel: 'mock-claude',
    openaiBaseUrl: '',
    openaiKey: '',
    openaiModel: '',
    defaultProvider: 'anthropic',
    allowUserKeys: false,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) await setPluginConfig(api, ID, key, value);
}

/**
 * Answer the privacy notice the first time a service is used. In a panel
 * or the dialog it is shown inside the plugin's frame with its own
 * Continue button; in the phone bar it is the host's confirm dialog.
 */
export async function acceptPrivacy(page, { frame, expectText, dialog } = {}) {
  if (frame) {
    await expect(frame.getByText('Send text to the AI service?')).toBeVisible({ timeout: 30_000 });
    if (expectText) await expect(frame.getByRole('status').filter({ hasText: expectText })).toBeVisible();
    if (dialog) await dialog.getByRole('button', { name: 'Continue' }).click();
    else await frame.getByRole('button', { name: 'Continue' }).click();
    return;
  }
  const notice = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'Send text to the AI service?' });
  await expect(notice).toBeVisible();
  if (expectText) await expect(notice).toContainText(expectText);
  await notice.getByRole('button', { name: 'Continue' }).click();
}

/** The composer's editor. */
export const editor = (page) => page.locator('[contenteditable="true"]').first();

/** Open the composer and type a message body; lines are separate paragraphs. */
export async function composeWith(page, text) {
  await page.getByRole('button', { name: 'Compose' }).first().click();
  const box = editor(page);
  await box.click();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await box.press('Enter');
    if (lines[i]) await box.pressSequentially(lines[i], { delay: 5 });
  }
  // onDraftChange (the subject) is debounced.
  await page.waitForTimeout(1500);
}

/** The editor's own text: the lines above the signature, as the user sees them. */
export async function editorText(page) {
  return (await editor(page).innerText()).replace(/\r/g, '');
}

/** The assistant panel next to the composer: the host's panel and the plugin's frame in it. */
export function composerPanel(page) {
  const host = page.locator('[data-composer-sidebar="right"]');
  return { host, frame: page.frameLocator(`[data-composer-sidebar="right"] ${SLOT_FRAME}`) };
}

/**
 * The assistant panel next to an open message. It starts folded: the
 * Assistant button in the message's toolbar opens it (the host's strip
 * button when the toolbar put it behind More).
 */
export async function readerPanel(page) {
  const host = page.locator('[data-plugin-detail-panel]');
  if (!(await host.isVisible().catch(() => false))) {
    const button = page.locator(`[data-plugin-actions="reader-actions"] [aria-label="Assistant"]`).first();
    if (await button.isVisible().catch(() => false)) await button.click();
    else await page.getByRole('button', { name: 'Show plugin panel' }).click();
  }
  const frame = page.frameLocator(`[data-plugin-detail-panel] ${SLOT_FRAME}`);
  await expect(frame.getByRole('textbox', { name: 'Message to the assistant' })).toBeVisible({ timeout: 60_000 });
  return { host, frame };
}

/** The assistant dialog (phones): the host's box (title, footer buttons) and the plugin's frame inside it. */
export function assistantDialog(page) {
  const box = page.getByRole('dialog').filter({ hasText: 'AI assistant' });
  return { box, frame: box.frameLocator(SLOT_FRAME) };
}

/** The chat's input in a panel frame. */
export const chatInput = (frame) => frame.getByRole('textbox', { name: 'Message to the assistant' });

/** Type a request into the chat and send it. */
export async function ask(frame, text) {
  await chatInput(frame).fill(text);
  await chatInput(frame).press('Enter');
}

/** Wait until no answer is running any more. */
export async function waitDone(frame, timeout = 90_000) {
  await expect(frame.locator('[data-turn="assistant"][data-status="running"]')).toHaveCount(0, { timeout });
}

/** The newest proposal card and its marked preview. */
export function lastProposal(frame) {
  const card = frame.locator('[data-proposal]').last();
  return { card, preview: card.getByLabel('Suggested change') };
}

export const OLLAMA = 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';

/** Ollama speaks both APIs; it takes any key. */
export const OLLAMA_CONFIG = {
  openaiBaseUrl: `${OLLAMA}/v1`, openaiKey: 'ollama', openaiModel: OLLAMA_MODEL,
  anthropicBaseUrl: `${OLLAMA}/v1`, anthropicKey: 'ollama', anthropicModel: OLLAMA_MODEL,
};

/**
 * Whether the test-env mock reads chunked request bodies. The webmail's
 * proxy streams every request body, and mocks/server.py before
 * "accept chunked request bodies" answered those with 400.
 */
export async function mockReadsChunked() {
  try {
    const body = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"model":"m","max_tokens":5,"messages":[{"role":"user","content":"x"}]}')); c.close(); },
    });
    const res = await fetch(`${MOCK}/anthropic/v1/messages`, {
      method: 'POST', body, duplex: 'half',
      headers: { 'x-api-key': 'test-anthropic-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ollamaUp() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`);
    const json = await res.json();
    return json.models?.some((m) => m.name === OLLAMA_MODEL) ?? false;
  } catch {
    return false;
  }
}

/** The Assistant button in the composer's bottom bar. */
export const assistantButton = (page) => page.locator(`[data-plugin-action="${ID}:assistant"]`).first();

/**
 * Open the assistant panel with Alt+A, or with `click: true` from its
 * button in the composer's bottom bar (the button test checks that one on
 * its own). Resolves to the panel's frame, with the chat input visible.
 */
export async function openAssistant(page, { click = false } = {}) {
  // The shortcut is the button's: it exists once the plugin has declared it.
  await expect(assistantButton(page)).toBeAttached({ timeout: 60_000 });
  if (click) await assistantButton(page).click();
  else await editor(page).press('Alt+a');
  const panel = composerPanel(page);
  await expect(panel.host).toHaveAttribute('data-composer-sidebar-mode', /docked|overlay/);
  await expect(chatInput(panel.frame)).toBeVisible({ timeout: 60_000 });
  return panel;
}

/** Select the last line of the message (End, then Shift+Home). */
export async function selectLastLine(page) {
  const box = editor(page);
  await box.click();
  await box.press('Control+End');
  await box.press('Shift+Home');
}
