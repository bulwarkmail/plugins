import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { installPlugin, uninstallPlugin, preparePage, signIn, waitForPlugin, shoot } from '../../e2e/helpers.mjs';
import { ID, ask, configure, acceptPrivacy, editor, readerPanel, waitDone, OLLAMA_CONFIG, ollamaUp, mockReadsChunked } from './common.mjs';

// The reader: a panel next to the open message with Summarize, To-dos and
// dates, Reply ideas and Translate, a chat about the message, and the
// highlighted passage as the thing to explain or answer; the right-click
// menu on selected text in the message; on phones the bar above the
// message and the summary of a whole conversation. Answers come from the
// mock when it reads the proxy's request bodies, else from Ollama.

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function service() {
  if (await mockReadsChunked()) return { config: {}, answer: /Mock reply/ };
  if (await ollamaUp()) return { config: { ...OLLAMA_CONFIG, defaultProvider: 'anthropic' }, answer: /\S{2,}/ };
  return null;
}

/** The frame of the plugin's slot that has this button (the phone bar, the conversation summary). */
async function slotWith(page, name) {
  const frames = page.locator(`iframe[title="plugin-${ID}-slot"]`);
  await expect(async () => {
    const n = await frames.count();
    let found = false;
    for (let i = 0; i < n; i++) {
      if (await frames.nth(i).contentFrame().getByRole('button', { name }).count()) found = true;
    }
    expect(found).toBe(true);
  }).toPass({ timeout: 30_000 });
  const n = await frames.count();
  for (let i = 0; i < n; i++) {
    const frame = frames.nth(i).contentFrame();
    if (await frame.getByRole('button', { name }).count()) return frame;
  }
  throw new Error(`no slot with ${name}`);
}

async function openMessage(page, subject, target = page.getByText(subject, { exact: true }).first()) {
  // Search for it: other test suites add mail to the same inbox.
  const opener = page.getByRole('button', { name: /Search mail/ });
  if (await opener.isVisible().catch(() => false)) await opener.click();
  const search = page.getByRole('combobox', { name: /Search mail/ });
  await search.click();
  // "Re:" would be read as a search operator.
  await search.fill(subject.replace(/^Re: /, ''));
  await search.press('Enter');
  // Rows re-render while other plugins add badges, so they are never "stable".
  await target.waitFor({ timeout: 60_000 });
  await target.click({ force: true });
}

async function readClipboard(page) {
  await page.locator('body').focus().catch(() => {});
  await page.evaluate(() => window.focus());
  return page.evaluate(() => navigator.clipboard.readText());
}

async function setUp(page, api, { theme = 'light', viewport = { width: 1600, height: 900 } } = {}) {
  const svc = await service();
  test.skip(!svc, 'neither the mock (with chunked bodies) nor Ollama is available');
  await configure(api, svc.config);
  if (viewport) await page.setViewportSize(viewport);
  await preparePage(page, { theme });
  await signIn(page);
  await waitForPlugin(page, ID);
  return svc;
}

/** The open message's body: the iframe of an HTML mail, else the page's own plain-text block. */
function messageBody(page) {
  const iframe = page.locator('iframe[title="Email content"]').first();
  const plain = page.locator('[data-plugin-source="email-body"]').first();
  return { iframe, plain };
}

/** Select text inside the open message's body, in the iframe of an HTML mail or the page's plain-text block. */
async function selectInBody(page, text) {
  const { iframe, plain } = messageBody(page);
  const inFrame = await iframe.count();
  const target = inFrame ? page.frameLocator('iframe[title="Email content"]').first().locator('body') : plain;
  const ok = await target.evaluate((body, needle) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const i = node.textContent.indexOf(needle);
      if (i === -1) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + needle.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    return false;
  }, text);
  expect(ok, `"${text}" is in the message body`).toBe(true);
  return target;
}

for (const theme of ['light', 'dark']) {
  test(`summarise a message in the panel and ask about it (${theme})`, async ({ page }) => {
    const api = await install(await adminApi(), ID, installPlugin);
    try {
      const svc = await setUp(page, api, { theme });
      await openMessage(page, 'Can we meet on Thursday?', page.getByText('send me the slides').first());
      const { frame } = await readerPanel(page);
      await expect(frame.getByText('This message', { exact: true })).toBeVisible();
      // On a desktop the panel is the assistant; the phone bar above the message stays away.
      await expect(page.frameLocator('[data-plugin-slot="email-banner"] iframe').getByText('AI assistant')).toHaveCount(0);
      if (theme === 'light') await shoot(page, ID, 'reader-panel', theme);
      await frame.getByRole('button', { name: 'Actions' }).click();
      await frame.getByRole('menuitem', { name: 'Summarize' }).click();
      await acceptPrivacy(page, { frame });
      await expect(frame.getByText('Summarize', { exact: true })).toBeVisible();
      await waitDone(frame);
      await expect(frame.locator('[data-turn="assistant"]').last()).toContainText(svc.answer);
      await shoot(page, ID, 'reader-summary', theme);

      await ask(frame, 'what does Carol want?');
      await waitDone(frame);
      await expect(frame.locator('[data-turn="user"]')).toHaveCount(2);
      await expect(frame.locator('[data-turn="assistant"][data-status="done"]')).toHaveCount(2);
    } finally {
      await uninstallPlugin(api, ID);
    }
  });
}

test('to-dos and dates, and a reply idea that opens a reply', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api);
    await openMessage(page, 'Can we meet on Thursday?', page.getByText('send me the slides').first());
    const { frame } = await readerPanel(page);
    await frame.getByRole('button', { name: 'To-dos and dates' }).click();
    await acceptPrivacy(page, { frame });
    await waitDone(frame);
    await expect(frame.getByRole('button', { name: 'Copy list' }).or(frame.getByText(/Nothing to do/))).toBeVisible();
    if (await frame.getByRole('button', { name: 'Copy list' }).count()) {
      await shoot(page, ID, 'reader-todos', 'light');
      await frame.getByRole('button', { name: 'Copy list' }).click();
      expect((await readClipboard(page)).replace(/\r/g, '')).toMatch(/^(To-dos|Dates):\s*\n- /);
    }

    // The notice was answered once; reply ideas go straight through.
    await frame.getByRole('button', { name: 'Reply ideas' }).click();
    await waitDone(frame);
    const replyButtons = frame.getByRole('button', { name: 'Reply', exact: true });
    await expect(replyButtons.first()).toBeVisible();
    expect(await replyButtons.count()).toBeLessThanOrEqual(3);
    // The idea is the text next to its button.
    const idea = (await replyButtons.first().locator('xpath=following-sibling::*[1]').innerText()).replace(/\r/g, '').trim();
    expect(idea.length).toBeGreaterThan(3);
    await shoot(page, ID, 'reader-replies', 'light');
    await replyButtons.first().click();
    // A reply opens with the idea already in it.
    const firstLine = idea.split('\n')[0].slice(0, 40);
    await expect(editor(page)).toContainText(firstLine, { timeout: 20_000 });
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('a highlighted passage: explain it from the right-click menu, then draft a reply to it', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    const svc = await setUp(page, api);
    await openMessage(page, 'Can we meet on Thursday?', page.getByText('send me the slides').first());
    // The plugin offers its panel while it starts; the host's panel button shows when it has.
    await expect(page.locator('[data-plugin-panel-toggle]').first()).toBeAttached({ timeout: 60_000 });
    const body = await selectInBody(page, 'Thursday at 15:00');
    // A right-click on the selection (a synthetic click would collapse it first, so the event is dispatched as the browser would).
    const menu = page.getByRole('menu');
    await expect(async () => {
      await body.evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 20 })));
      await expect(menu).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeVisible();
    await shoot(page, ID, 'reader-context-menu', 'light');
    await menu.getByRole('menuitem', { name: 'Explain this' }).click();

    const { frame } = await readerPanel(page);
    await acceptPrivacy(page, { frame });
    await expect(frame.getByText('Explain · highlighted text')).toBeVisible();
    await waitDone(frame);
    await expect(frame.locator('[data-turn="assistant"]').last()).toContainText(svc.answer);
    // The panel follows the selection while it is there.
    await expect(frame.getByText('Highlighted passage', { exact: true })).toBeVisible();
    await frame.getByRole('button', { name: 'Actions' }).click();
      await frame.getByRole('menuitem', { name: 'Draft a reply' }).click();
    await waitDone(frame);
    await expect(frame.getByText('Draft a reply · highlighted text')).toBeVisible();
    await expect(frame.locator('[data-turn="assistant"][data-status="done"]')).toHaveCount(2);
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('on a phone the bar above the message has the actions', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api, { viewport: { width: 390, height: 844 } });
    await openMessage(page, 'Can we meet on Thursday?', page.getByText('send me the slides').first());
    const bar = await slotWith(page, 'Summarize');
    await expect(bar.getByText('AI assistant')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Reply ideas' })).toBeVisible();
    await shoot(page, ID, 'reader-bar-phone', 'light');
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('on a phone a conversation gets a summary', async ({ page }) => {
  execFileSync('python', [path.join(HERE, 'seed_thread.py')], { stdio: 'inherit' });
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    const svc = await setUp(page, api, { viewport: { width: 390, height: 844 } });
    // The list shows the conversation as one row, with the first message's text.
    await openMessage(page, 'Team offsite in November', page.getByText('Budget is 2000 EUR').first());
    const slot = await slotWith(page, /Summarize this conversation \(\d+ messages\)/);
    await slot.getByRole('button', { name: /Summarize this conversation/ }).click();
    await acceptPrivacy(page);
    await expect(slot.getByRole('button', { name: 'Copy' })).toBeVisible({ timeout: 90_000 });
    await expect(slot.getByText(/Conversation summary \(\d+ messages\)/)).toBeVisible();
    await expect(slot.locator('body')).toContainText(svc.answer);
    await shoot(page, ID, 'thread-summary-phone', 'light');
  } finally {
    await uninstallPlugin(api, ID);
  }
});
