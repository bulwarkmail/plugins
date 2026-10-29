import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { installPlugin, uninstallPlugin, preparePage, signIn, waitForPlugin, shoot } from '../../e2e/helpers.mjs';
import {
  ID, ask, assistantButton, assistantDialog, chatInput, composerPanel, configure, acceptPrivacy, composeWith, editor, editorText,
  lastProposal, openAssistant, selectLastLine, waitDone, OLLAMA_CONFIG, mockReadsChunked, ollamaUp,
} from './common.mjs';

// The composer: the Assistant button in the composer's bottom bar (Alt+A)
// opens the assistant as a panel next to the message. It works on the
// selection or the whole message; quick actions and typed requests go into
// one chat; Replace and Insert change the text in the real editor, in one
// undo step; the right-click menu on selected text starts an action.
// Answers come from the test-env mocks (deterministic text) and from
// Ollama, which speaks both the OpenAI and the Anthropic API.

const MOCK_REPLY = /Mock reply\. You asked: .*This text comes from the Bulwark test mock\./s;
const DRAFT = 'hi bob, can we meet on tuesday? i has some questions';

const SERVICES = [
  {
    name: 'the Anthropic mock', theme: 'light', available: mockReadsChunked,
    config: {}, provider: 'Anthropic at localhost:18099 (model mock-claude)', answer: MOCK_REPLY,
  },
  {
    name: 'the OpenAI mock', theme: 'dark', available: mockReadsChunked,
    config: { anthropicBaseUrl: '', anthropicKey: '', openaiBaseUrl: 'http://localhost:18099/openai/v1', openaiKey: 'test-openai-key', openaiModel: 'mock-gpt-small', defaultProvider: 'openai' },
    provider: 'OpenAI-compatible at localhost:18099 (model mock-gpt-small)', answer: MOCK_REPLY,
  },
  // The small Ollama model may answer with the text unchanged; the mocks always change it.
  {
    name: 'Ollama, OpenAI-compatible', theme: 'light', available: ollamaUp, marks: false,
    config: { ...OLLAMA_CONFIG, defaultProvider: 'openai' }, provider: 'OpenAI-compatible at localhost:11434', answer: /\S{2,}/,
  },
  {
    name: 'Ollama, Anthropic Messages API', theme: 'dark', available: ollamaUp, marks: false,
    config: { ...OLLAMA_CONFIG, defaultProvider: 'anthropic' }, provider: 'Anthropic at localhost:11434', answer: /\S{2,}/,
  },
];

const slug = (s) => s.replace(/\W+/g, '-').toLowerCase();

async function start(page, api, { config = {}, theme = 'light', viewport = { width: 1600, height: 900 } } = {}) {
  await configure(api, config);
  if (viewport) await page.setViewportSize(viewport);
  await preparePage(page, { theme });
  await signIn(page);
  await waitForPlugin(page, ID);
}

for (const service of SERVICES) {
  test(`rewrite the whole message from the panel, and undo it, with ${service.name}`, async ({ page }) => {
    test.skip(!(await service.available()), `${service.name} is not reachable (see README)`);
    const api = await install(await adminApi(), ID, installPlugin);
    try {
      await start(page, api, service);
      await composeWith(page, DRAFT);
      const before = await editorText(page);

      const { frame } = await openAssistant(page);
      await expect(frame.getByText('Your message')).toBeVisible();
      await expect(frame.getByText(DRAFT)).toBeVisible();
      await shoot(page, ID, `composer-panel-${slug(service.name)}`, service.theme);
      await frame.getByRole('button', { name: 'Actions' }).click();
      await frame.getByRole('menuitem', { name: 'More formal' }).click();
      await acceptPrivacy(page, { frame, expectText: service.provider });
      await expect(frame.getByText('More formal · whole message')).toBeVisible();

      await waitDone(frame);
      const { card, preview } = lastProposal(frame);
      await expect(preview).toContainText(service.answer);
      // The change is marked: the old words struck out, the new ones added.
      if (service.marks !== false) await expect(preview.locator('ins').first()).toBeVisible();
      const suggested = (await preview.locator('span, ins').allInnerTexts()).join('').trim();
      await shoot(page, ID, `composer-proposal-${slug(service.name)}`, service.theme);

      await card.getByRole('button', { name: 'Replace message' }).click();
      await expect(card.getByText('Replaced')).toBeVisible();
      await expect(card.getByText('Ctrl+Z takes it back')).toBeVisible();
      // (The mock's answer quotes the draft, so check the text as a whole.)
      if (service.marks !== false) await expect.poll(() => editorText(page)).not.toBe(before);
      await expect(editor(page)).toContainText(suggested.split('\n')[0].slice(0, 40));
      // The panel now works on the new message.
      await expect(frame.getByText(suggested.split('\n')[0].slice(0, 40)).first()).toBeVisible();

      // One Ctrl+Z takes the whole change back.
      const box = editor(page);
      await box.click();
      await box.press('ControlOrMeta+z');
      await expect.poll(() => editorText(page)).toBe(before);
    } finally {
      await uninstallPlugin(api, ID);
    }
  });
}

/** Fails when a plugin button in the composer bar lies on top of Discard or Send. */
async function expectNoOverlap(page) {
  const own = page.locator('[data-plugin-action]').filter({ visible: true });
  for (const mine of await own.all()) {
    const m = await mine.boundingBox();
    if (!m) continue;
    for (const name of ['Discard', 'Send']) {
      for (const other of await page.getByRole('button', { name, exact: true }).all()) {
        if (!(await other.isVisible())) continue;
        const o = await other.boundingBox();
        const overlaps = m.x < o.x + o.width && o.x < m.x + m.width && m.y < o.y + o.height && o.y < m.y + m.height;
        expect(overlaps, `a plugin button covers ${name}`).toBe(false);
      }
    }
  }
}

test('at 1280 px the assistant is in the Options menu, and nothing covers Discard or Send', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await start(page, api, { viewport: { width: 1280, height: 800 } });
    await composeWith(page, 'Hello there');
    await expectNoOverlap(page);
    await expect(assistantButton(page)).toBeHidden();
    await page.getByRole('button', { name: 'Options' }).last().click();
    await page.getByRole('menuitem', { name: /Assistant/ }).click();
    // The reading pane is narrow: the panel lies over the composer.
    const { host, frame } = composerPanel(page);
    await expect(host).toHaveAttribute('data-composer-sidebar-mode', /docked|overlay/);
    await expect(chatInput(frame)).toBeVisible({ timeout: 60_000 });
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('in a wide window the Assistant button is in the composer bar, opens the panel, and Alt+A closes it again', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await start(page, api, { viewport: { width: 1920, height: 1080 } });
    await composeWith(page, 'Hello there');
    await expect(assistantButton(page)).toBeVisible();
    await expect(assistantButton(page)).toContainText('Assistant');
    await expectNoOverlap(page);
    const { host } = await openAssistant(page, { click: true });
    await expect(host).toHaveAttribute('data-composer-sidebar-mode', 'docked');
    // The panel can be dragged wider.
    await expect(page.getByTestId('composer-sidebar-resize-right')).toBeVisible();
    await editor(page).click();
    await editor(page).press('Alt+a');
    await expect(host).toHaveAttribute('data-composer-sidebar-mode', 'folded');
    await editor(page).press('Alt+a');
    await expect(host).toHaveAttribute('data-composer-sidebar-mode', 'docked');
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('translate a selected line and insert it below', async ({ page }) => {
  test.skip(!(await mockReadsChunked()), 'the mock does not read chunked bodies');
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await start(page, api);
    await composeWith(page, 'Dear team,\nGuten Tag, wir sehen uns am Dienstag.');
    await selectLastLine(page);

    const { frame } = await openAssistant(page);
    await expect(frame.getByText('Selected text')).toBeVisible();
    await expect(frame.getByText('Guten Tag, wir sehen uns am Dienstag.')).toBeVisible();
    await frame.getByRole('button', { name: 'Actions' }).click();
      await frame.getByRole('menuitem', { name: 'Translate' }).click();
    await frame.getByLabel('Translate into').selectOption('en');
    await acceptPrivacy(page, { frame });
    await expect(frame.getByText('Translate to English · selected text')).toBeVisible();
    await waitDone(frame);
    const { card } = lastProposal(frame);
    await card.getByRole('button', { name: 'Insert below' }).click();
    await expect(card.getByText('Inserted')).toBeVisible();

    const lines = (await editorText(page)).split('\n').filter((l) => l.trim());
    // The selection is still there, the answer follows it.
    expect(lines[0]).toBe('Dear team,');
    expect(lines[1]).toBe('Guten Tag, wir sehen uns am Dienstag.');
    expect(lines[2]).toMatch(/^Mock reply\. You asked: .*Guten Tag/);
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('the right-click menu on selected text starts an action in the panel and replaces only the selection', async ({ page }) => {
  test.skip(!(await mockReadsChunked()), 'the mock does not read chunked bodies');
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await start(page, api);
    await composeWith(page, 'Keep this line.\nchange this line please');
    await selectLastLine(page);
    // The keyboard opens the context menu at the selection.
    await editor(page).press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Cut' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeVisible();
    await shoot(page, ID, 'composer-context-menu', 'light');
    await menu.getByRole('menuitem', { name: 'Improve writing' }).click();

    const { frame } = composerPanel(page);
    await expect(chatInput(frame)).toBeVisible({ timeout: 60_000 });
    await acceptPrivacy(page, { frame });
    await expect(frame.getByText('Improve · selected text')).toBeVisible();
    await waitDone(frame);
    const { card } = lastProposal(frame);
    await card.getByRole('button', { name: 'Replace' }).click();
    await expect(card.getByText('Replaced')).toBeVisible();
    const lines = (await editorText(page)).split('\n').filter((l) => l.trim());
    expect(lines[0]).toBe('Keep this line.');
    expect(lines[1]).toMatch(/^Mock reply\. You asked: .*change this line please/);
    expect(lines.join('\n')).not.toContain('\nchange this line please');
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('write an empty message from a description, then keep talking', async ({ page }) => {
  test.skip(!(await mockReadsChunked()), 'the mock does not read chunked bodies');
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await start(page, api);
    await composeWith(page, '');
    const { frame } = await openAssistant(page);
    await expect(chatInput(frame)).toHaveAttribute('placeholder', 'Describe what the email should say…');
    await expect(frame.locator('[data-context-chip]')).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Actions' })).toHaveCount(0);
    await shoot(page, ID, 'composer-write', 'light');
    await ask(frame, 'thank Anna for the workshop');
    await acceptPrivacy(page, { frame });
    await waitDone(frame);
    // The mock answers without the tags: the answer can still go into the message.
    await expect(frame.getByText(/Mock reply\. You asked:/)).toBeVisible();
    await frame.getByRole('button', { name: 'Insert at cursor' }).click();
    await expect(editor(page)).toContainText(/Mock reply\. You asked: .*thank Anna for the workshop/);

    // The second request carries the first exchange; the chat goes on.
    await ask(frame, 'make it warmer');
    await waitDone(frame);
    await expect(frame.locator('[data-turn="user"]')).toHaveCount(2);
    await expect(frame.locator('[data-turn="assistant"][data-status="done"]')).toHaveCount(2);
    // The transcript survives folding the panel.
    await editor(page).click();
    await editor(page).press('Alt+a');
    await editor(page).press('Alt+a');
    await expect(composerPanel(page).frame.locator('[data-turn="user"]')).toHaveCount(2, { timeout: 60_000 });
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('Stop ends a running answer and leaves the message alone', async ({ page }) => {
  test.skip(!(await ollamaUp()), 'Ollama is not running (test-env/up.ps1 -WithAI)');
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await start(page, api, { config: { ...OLLAMA_CONFIG, defaultProvider: 'openai' } });
    await composeWith(page, 'Thanks for the workshop, Anna. It was great.');
    const before = await editorText(page);
    const { frame } = await openAssistant(page);
    await ask(frame, 'make it a long letter with five paragraphs');
    await acceptPrivacy(page, { frame });
    await frame.getByRole('button', { name: 'Stop' }).click();
    await expect(frame.getByText('Stopped.')).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Send' })).toBeVisible();
    expect(await editorText(page)).toBe(before);
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('on a phone the assistant opens as a dialog', async ({ page }) => {
  test.skip(!(await mockReadsChunked()), 'the mock does not read chunked bodies');
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await start(page, api, { viewport: { width: 390, height: 844 } });
    await composeWith(page, 'Hello there');
    // The shortcut is the button's: it exists once the plugin has declared it.
    await expect(assistantButton(page)).toBeAttached({ timeout: 60_000 });
    await editor(page).press('Alt+a');
    const { box, frame } = assistantDialog(page);
    await expect(box).toBeVisible();
    await expect(frame.getByText('Works on your whole message, without the signature and the quoted email:')).toBeVisible();
    await box.getByRole('button', { name: 'Rewrite' }).click();
    await acceptPrivacy(page, { frame, dialog: box });
    await expect(box.getByRole('button', { name: 'Replace' })).toBeEnabled({ timeout: 60_000 });
    await shoot(page, ID, 'composer-dialog-phone', 'light');
  } finally {
    await uninstallPlugin(api, ID);
  }
});

const ERRORS = [
  ['a rate limit with its wait time', { anthropicKey: 'rate-limited' }, /too many requests\. You can try again in [1-7] s\./],
  ['a refused key (Anthropic)', { anthropicKey: 'wrong-key' }, /didn't accept the API key/],
  ['a refused key (OpenAI)', { anthropicBaseUrl: '', openaiBaseUrl: 'http://localhost:18099/openai/v1', openaiKey: 'wrong-key', defaultProvider: 'openai' }, /didn't accept the API key/],
];

for (const [name, config, message] of ERRORS) {
  test(`explains ${name}`, async ({ page }) => {
    const api = await install(await adminApi(), ID, installPlugin);
    try {
      await start(page, api, { config });
      await composeWith(page, 'Hello there');
      const { frame } = await openAssistant(page);
      await frame.getByRole('button', { name: 'Actions' }).click();
      await frame.getByRole('menuitem', { name: 'Improve' }).click();
      await acceptPrivacy(page, { frame });
      await expect(frame.getByRole('alert').filter({ hasText: message })).toBeVisible();
      await expect(frame.locator('[data-proposal]')).toHaveCount(0);
      if (name.startsWith('a rate limit')) {
        await expect(frame.getByRole('button', { name: 'Try again' })).toBeDisabled();
        await shoot(page, ID, 'composer-rate-limit', 'light');
        await expect(frame.getByRole('button', { name: 'Try again' })).toBeEnabled({ timeout: 10_000 });
      }
    } finally {
      await uninstallPlugin(api, ID);
    }
  });
}
