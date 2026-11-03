import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { installPlugin, uninstallPlugin, preparePage, signIn, waitForPlugin } from '../../e2e/helpers.mjs';
import { ID, acceptPrivacy, ask, chatInput, configure, editor, mockReadsChunked, mockRequests, mockScript, openMessage, readerPanel, waitDone } from './common.mjs';
import { PEER, USER, importMessages } from './jmap.mjs';
import { blobText, createFolder, createTextFile, listNodes } from './files.mjs';

// Files (package D of the 2.2 work): a file found in Files is read and
// attached to a draft, a note is created in the folder the model picked,
// overwriting asks first even in automatic mode and the old version comes
// back with Restore in the Files trash. Also the @ menu by keyboard and
// the Files settings at phone width.

const RUN = Date.now().toString(36);
const SUBJECT = `Budget question ${RUN}`;
const NOTES = `Notes ${RUN}`;
const BUDGET = `Budget ${RUN}.md`;
const PLANS = `Plans ${RUN}`;
const PLAN = `Plan ${RUN}.md`;
// One word, as the @ menu takes it.
const LEDGER = `Ledger-${RUN}.md`;
const ids = {};

test.beforeAll(async () => {
  if (!process.env.BULWARK_JMAP_URL) return;
  await importMessages([{
    messageId: `files-${RUN}@e2e.bulwark.test`, from: `Bob <${PEER}>`, to: USER, subject: SUBJECT, date: Date.now() - 3600_000,
    text: 'Hi,\n\ncan you send me the budget?\n\nBob',
  }]);
  ids.notes = await createFolder(NOTES);
  ids.budget = await createTextFile(BUDGET, '# Budget\n\nThe budget is 4200 EUR (codeword HERON).\n', ids.notes);
  ids.plans = await createFolder(PLANS);
  ids.plan = await createTextFile(PLAN, 'Old plan: launch on 12 December.\n', ids.plans);
  await createTextFile(LEDGER, 'Ledger.\n', ids.notes);
});

async function setUp(page, api, { mode = 'manual', viewport = { width: 1600, height: 900 } } = {}) {
  test.skip(!(await mockReadsChunked()), 'the mock AI server is not running');
  await configure(api, { instructions: '', actions: 'auto' });
  await page.setViewportSize(viewport);
  await preparePage(page, { theme: 'light' });
  await signIn(page);
  await waitForPlugin(page, ID);
  // The user's action mode, in the plugin's settings.
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'AI Assistant' }).click();
  const settings = page.frameLocator(`iframe[title="plugin-${ID}-slot"]`).first();
  await settings.getByRole('combobox', { name: 'Actions' }).selectOption(mode);
  await page.waitForTimeout(500);
  return settings;
}

/** Click, trying again when the list redraws under the click (the row is replaced). */
async function clickSoon(page, locator) {
  for (let i = 0; ; i++) {
    try {
      await locator.click({ timeout: 5_000 });
      return;
    } catch (err) {
      if (i >= 5) throw err;
      await page.waitForTimeout(1_000);
    }
  }
}

async function open(page, subject) {
  await page.getByRole('link', { name: 'Mail' }).first().click();
  const row = () => page.getByText(subject, { exact: true }).locator('visible=true').first();
  // The list can redraw under the first click; then the row is clicked once more below.
  await openMessage(page, subject, row()).catch(() => {});
  const shown = page.getByRole('heading', { name: subject });
  // The first click can land while the list still loads.
  if (!(await shown.isVisible({ timeout: 10_000 }).catch(() => false))) await clickSoon(page, row());
  await expect(shown).toBeVisible({ timeout: 30_000 });
}

const toolResults = (request) => (request.body.messages.at(-1).content ?? []).filter((b) => b.type === 'tool_result');
/** An action card of the chat by its text; `Do it` / `Skip` inside. */
const card = (frame, text) => frame.locator('[data-action]').filter({ hasText: text });

test('a file found in Files is read, attached to a reply, and a note is created in its folder', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api, { mode: 'manual' });
    await open(page, SUBJECT);
    // A reply to Bob: the composer has a recipient, and the assistant works on the open draft.
    await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
    await expect(editor(page)).toBeVisible({ timeout: 30_000 });
    await editor(page).click();
    await editor(page).press('Alt+a');
    const frame = page.frameLocator(`[data-composer-sidebar="right"] iframe[title="plugin-${ID}-slot"]`);
    await expect(chatInput(frame)).toBeVisible({ timeout: 60_000 });

    await mockScript(`files-attach-${RUN}`, [
      // Actions take only files and folders this chat found: the file and the folder for the note. (At most four rounds of tools.)
      { tools: [{ name: 'find_file', input: { text: `budget ${RUN}` } }, { name: 'find_file', input: { text: `notes ${RUN}`, kind: 'folder' } }] },
      { tools: [{ name: 'read_file', input: { id: ids.budget } }] },
      { tools: [{ name: 'attach_file', input: { ids: [ids.budget] } }] },
      { tools: [{ name: 'create_file', input: { name: `Minutes ${RUN}`, content: '# Minutes\n\nBudget sent to Bob.', format: 'markdown', folderId: ids.notes } }] },
      { text: 'Attached the budget and wrote the minutes.' },
    ]);
    await ask(frame, `[[mock:files-attach-${RUN}]] Find my budget file, attach it and note it in my notes folder.`);
    await acceptPrivacy(page, { frame, expectText: 'the names, folder paths, sizes and dates of the files it finds' });

    // Attaching always asks, naming the file and who gets it.
    const attach = card(frame, `Attach “${BUDGET}” to your message to`);
    await expect(attach).toBeVisible({ timeout: 60_000 });
    await expect(attach).toContainText(PEER);
    await attach.getByRole('button', { name: 'Do it' }).click();
    const create = card(frame, `Create “Minutes ${RUN}.md” in “${NOTES}”?`);
    await expect(create).toBeVisible({ timeout: 60_000 });
    await create.getByRole('button', { name: 'Do it' }).click();
    await waitDone(frame);
    await expect(frame.getByText('Attached the budget and wrote the minutes.')).toBeVisible();

    const requests = await mockRequests(`files-attach-${RUN}`);
    expect(String(toolResults(requests[1])[0].content)).toContain(`"${BUDGET}" | in /${NOTES}`);
    expect(String(toolResults(requests[2])[0].content)).toContain('codeword HERON');
    // The file sits in the draft, by its blob.
    await expect(page.getByText(BUDGET).first()).toBeVisible();
    // The note is in the folder.
    const nodes = await listNodes();
    const minutes = nodes.find((n) => n.name === `Minutes ${RUN}.md`);
    expect(minutes?.parentId).toBe(ids.notes);
    expect(await blobText(minutes.blobId)).toContain('Budget sent to Bob.');
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('overwriting a file asks first even when actions are automatic, and the old version comes back from the trash', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api, { mode: 'auto' });
    await open(page, SUBJECT);
    const { frame } = await readerPanel(page);
    await mockScript(`files-replace-${RUN}`, [
      { tools: [{ name: 'find_file', input: { text: `plan ${RUN}` } }] },
      { tools: [{ name: 'create_file', input: { replaceId: ids.plan, content: 'New plan: launch on 9 January.\n' } }] },
      { text: 'The plan is updated.' },
    ]);
    await ask(frame, `[[mock:files-replace-${RUN}]] Update my plan file: launch on 9 January.`);
    await acceptPrivacy(page, { frame });
    const replace = card(frame, `Replace “${PLAN}”? The old version goes to the Files trash, where you can restore it.`);
    await expect(replace).toBeVisible({ timeout: 60_000 });
    await expect(replace.getByRole('button', { name: 'Do it' })).toBeVisible();
    // Nothing changed while it waits.
    let nodes = await listNodes();
    expect(await blobText(nodes.find((n) => n.id === ids.plan).blobId)).toContain('Old plan');
    await replace.getByRole('button', { name: 'Do it' }).click();
    await waitDone(frame);

    nodes = await listNodes();
    expect(await blobText(nodes.find((n) => n.id === ids.plan).blobId)).toContain('New plan');
    const trash = nodes.find((n) => n.name === '.Trash' && !n.parentId);
    const batch = nodes.find((n) => n.parentId === trash?.id && n.name.endsWith(`~${ids.plans}`));
    const kept = nodes.find((n) => n.parentId === batch?.id && n.name === PLAN);
    expect(kept).toBeTruthy();
    expect(await blobText(kept.blobId)).toContain('Old plan');

    // Restore in the Files trash puts the old version back next to the new one.
    await page.getByRole('link', { name: 'Files' }).first().click();
    await expect(page.getByRole('heading', { name: 'My files – Files' })).toBeVisible({ timeout: 30_000 });
    const trashView = page.getByRole('heading', { name: 'Trash – Files' });
    for (let i = 0; i < 5 && !(await trashView.isVisible().catch(() => false)); i++) {
      await clickSoon(page, page.getByRole('button', { name: /^Trash( \d+)?$/ }).locator('visible=true').first());
      await trashView.waitFor({ timeout: 5_000 }).catch(() => {});
    }
    await expect(trashView).toBeVisible();
    const tick = page.getByRole('checkbox', { name: `Select ${PLAN}` }).first();
    await clickSoon(page, tick);
    await expect(tick).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Restore' }).first().click();
    await expect.poll(async () => {
      const now = await listNodes();
      const back = now.filter((n) => n.parentId === ids.plans && n.id !== ids.plan && n.name.startsWith(`Plan ${RUN}`));
      return back.length ? blobText(back[0].blobId) : '';
    }, { timeout: 30_000 }).toContain('Old plan');
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('the @ menu finds a file by keyboard, and the chip names it for screen readers', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api, { mode: 'off' });
    await open(page, SUBJECT);
    const { frame } = await readerPanel(page);
    await chatInput(frame).fill('Summarise @');
    await chatInput(frame).pressSequentially(`Ledger-${RUN}`, { delay: 20 });
    const list = frame.getByRole('listbox', { name: 'Mention a message, contact or file' });
    await expect(list).toBeVisible({ timeout: 30_000 });
    const option = list.getByRole('option').filter({ hasText: LEDGER });
    await expect(option).toBeVisible();
    // Arrow keys to the file, Enter picks it.
    for (let i = 0; i < 8; i++) {
      if (await option.getAttribute('aria-selected') === 'true') break;
      await chatInput(frame).press('ArrowDown');
    }
    await chatInput(frame).press('Enter');
    await expect(frame.getByRole('group', { name: `File ${LEDGER} in /${NOTES}` })).toBeVisible();
    await expect(frame.getByRole('button', { name: `Leave ${LEDGER} out` })).toBeAttached();
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('the Files settings work at phone width and by keyboard', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    const settings = await setUp(page, api, { mode: 'manual', viewport: { width: 390, height: 844 } });
    const read = settings.getByRole('switch', { name: 'Find and read files' });
    const write = settings.getByRole('switch', { name: 'Save and create files' });
    await expect(read).toBeVisible();
    await expect(write).toHaveAttribute('aria-checked', 'true');
    const box = await write.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await write.focus();
    await write.press('Space');
    await expect(write).toHaveAttribute('aria-checked', 'false');
    await write.press('Space');
    await expect(write).toHaveAttribute('aria-checked', 'true');
  } finally {
    await uninstallPlugin(api, ID);
  }
});
