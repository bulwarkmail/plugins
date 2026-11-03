import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { installPlugin, uninstallPlugin } from '../../e2e/helpers.mjs';
import { ID, acceptPrivacy, ask, mockScript, openMessage, readerPanel, waitDone } from './common.mjs';
import { importMessages, PEER, USER } from './jmap.mjs';
import {
  answerCard, answerOf, card, ensureFolder, eventually, findMail, inviteFrom, folders, runTag, setUp, setVacation, sieveText, turnOnActions, vacation,
} from './actions.mjs';

// The assistant's "more actions" in the real app (package C of the 2.2
// work): an invitation answered from the panel reaches the organiser, a
// filter it makes shows in Settings > Filters, a batch archive asks first,
// moves the messages and comes back with Undo, and the out-of-office is set
// only after the user's OK.

/** A message to open in the reader, so the panel has something to sit next to. */
async function seedNote(tag, extra = {}) {
  const subject = `Note ${tag}`;
  await importMessages([{ messageId: `note-${tag}@e2e.bulwark.test`, from: `Carol <carol@example.org>`, to: USER, subject, text: `A note for the test run ${tag}.`, ...extra }]);
  return subject;
}

async function panelFor(page, subject, target) {
  try {
    await openMessage(page, subject, target?.());
  } catch {
    // The list can redraw under the click; search once more.
    await openMessage(page, subject, target?.());
  }
  return (await readerPanel(page)).frame;
}

test('an invitation answered in the panel reaches the organiser', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    const tag = runTag();
    const title = `Planning ${tag}`;
    // Bob invites Alice from his calendar; the server mails her the invitation.
    const uid = await inviteFrom(PEER, USER, title);
    const mail = await eventually(() => findMail({ subject: title }), (list) => list.length > 0, { timeout: 90_000 });
    expect(mail.length, 'the invitation reached Alice').toBeGreaterThan(0);
    expect(await answerOf(PEER, uid, USER)).toBe('needs-action');
    await mockScript('c-rsvp', [
      { text: 'Answering.', tools: [{ name: 'answer_invitation', input: { status: 'accepted' } }] },
      { text: 'Done: {{tool_results}}' },
    ]);
    await setUp(page, api, test);
    await turnOnActions(page, ['Answer invitations']);
    const frame = await panelFor(page, title, () => page.getByText(mail[0].subject, { exact: true }).first());
    await ask(frame, '[[mock:c-rsvp]] accept this');
    await acceptPrivacy(page, { frame });
    // Always asks first, and says the answer goes to the organiser.
    await answerCard(frame, 'answer_invitation', { text: 'organiser' });
    await waitDone(frame);

    // Bob, the organiser, has Alice's answer in his own calendar.
    const answer = await eventually(() => answerOf(PEER, uid, USER), (status) => status === 'accepted', { timeout: 90_000 });
    expect(answer, 'the organiser got the answer').toBe('accepted');
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('a filter the assistant makes shows in Settings > Filters', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    const tag = runTag();
    const folder = `Newsletters ${tag}`;
    await ensureFolder(folder);
    const subject = await seedNote(tag);
    const name = `Shop news ${tag}`;
    await mockScript('c-filter', [
      { text: 'Making it.', tools: [{ name: 'create_filter', input: {
        name, conditions: [{ field: 'from', op: 'contains', value: `news-${tag}@shop.example` }],
        actions: [{ type: 'move', folder }, { type: 'mark_read' }],
      } }] },
      { text: 'Done: {{tool_results}}' },
    ]);
    await setUp(page, api, test);
    await turnOnActions(page, ['Create filters']);
    const frame = await panelFor(page, subject);
    await ask(frame, '[[mock:c-filter]] file the shop newsletters');
    await acceptPrivacy(page, { frame });
    // The rule in plain words, before anything is written.
    await answerCard(frame, 'create_filter', { text: folder });
    await waitDone(frame);
    expect(await sieveText()).toContain(name);

    // Undo in the panel takes it out of the account's filters again.
    await card(frame, 'create_filter').getByRole('button', { name: 'Undo' }).click();
    await expect(card(frame, 'create_filter')).toHaveAttribute('data-action-state', 'undone', { timeout: 30_000 });
    expect(await sieveText()).not.toContain(name);

    // Made again, it shows in Settings > Filters.
    await ask(frame, '[[mock:c-filter]] file the shop newsletters again');
    await answerCard(frame, 'create_filter', { text: folder });
    await waitDone(frame);
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('a batch archive asks first, moves the messages and comes back with Undo', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    const tag = runTag();
    const word = `receipt${tag}`;
    await importMessages([1, 2, 3].map((n) => ({
      messageId: `batch-${tag}-${n}@e2e.bulwark.test`, from: 'Shop <orders@shop.example>', to: USER,
      subject: `Receipt ${n} ${word}`, text: `Your receipt number ${n}. ${word}`,
    })));
    const subject = await seedNote(tag);
    await mockScript('c-batch', [
      { text: 'Archiving.', tools: [{ name: 'batch_messages', input: { search: { text: word }, action: 'archive' } }] },
      { text: 'Done: {{tool_results}}' },
    ]);
    await setUp(page, api, test);
    await turnOnActions(page, ['Act on many messages at once']);
    const frame = await panelFor(page, subject);
    await ask(frame, '[[mock:c-batch]] archive my receipts');
    await acceptPrivacy(page, { frame });

    const c = card(frame, 'batch_messages');
    await expect(c).toHaveAttribute('data-action-state', 'waiting', { timeout: 60_000 });
    await expect(c).toContainText('Archive 3 messages?');
    await expect(c).toContainText(`Receipt 1 ${word}`);
    // Nothing moved while it waits.
    const box = await folders();
    const inInbox = (m) => Object.keys(m.mailboxIds).some((id) => box[id]?.role === 'inbox');
    expect((await findMail({ text: word })).filter(inInbox)).toHaveLength(3);

    await answerCard(frame, 'batch_messages');
    await waitDone(frame);
    const moved = await eventually(() => findMail({ text: word }), (list) => list.length === 3 && !list.some(inInbox));
    const fresh = await folders();
    expect(moved.every((m) => Object.keys(m.mailboxIds).some((id) => /archive/i.test(fresh[id]?.role ?? '') || /^(Archive|\d{4})/.test(fresh[id]?.name ?? '')))).toBe(true);

    await c.getByRole('button', { name: 'Undo' }).click();
    await expect(c).toHaveAttribute('data-action-state', 'undone', { timeout: 30_000 });
    const back = await eventually(() => findMail({ text: word }), (list) => list.filter(inInbox).length === 3);
    expect(back.filter(inInbox)).toHaveLength(3);
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('the out-of-office is set only after the user says OK', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    const tag = runTag();
    await setVacation({ isEnabled: false });
    const subject = await seedNote(tag);
    const steps = [
      { text: 'Setting it.', tools: [{ name: 'set_vacation', input: { subject: `Away ${tag}`, text: 'I am away until Monday.', from: '2026-12-20', to: '2026-12-27' } }] },
      { text: 'Done: {{tool_results}}' },
    ];
    await mockScript('c-ooo-skip', steps);
    await mockScript('c-ooo', steps);
    await setUp(page, api, test);
    await turnOnActions(page, ['Out-of-office reply']);
    const frame = await panelFor(page, subject);

    await ask(frame, '[[mock:c-ooo-skip]] set my out-of-office');
    await acceptPrivacy(page, { frame });
    await answerCard(frame, 'set_vacation', { text: `Away ${tag}`, ok: false });
    await waitDone(frame);
    // Skipped: nothing of it reached the server.
    expect((await vacation())).toMatchObject({ isEnabled: false });
    expect((await vacation()).subject).not.toBe(`Away ${tag}`);

    await ask(frame, '[[mock:c-ooo]] set my out-of-office');
    await answerCard(frame, 'set_vacation', { text: 'I am away until Monday.' });
    await waitDone(frame);
    const set = await vacation();
    expect(set).toMatchObject({ subject: `Away ${tag}`, textBody: 'I am away until Monday.' });
    // With dates the app runs the reply from the filters script (an include of
    // the "vacation" script with those dates), and the server's flag reads off.
    const from = set.fromDate;
    expect(new Date(from).getTime()).toBeGreaterThan(Date.parse('2026-12-19T00:00:00Z'));
    expect(set.isEnabled || ((await sieveText()).includes('include :personal :optional "vacation"') && (await sieveText()).includes(from))).toBe(true);
  } finally {
    await setVacation({ isEnabled: false }).catch(() => {});
    await uninstallPlugin(api, ID);
  }
});

/**
 * Settings > Out of office: the reply off, its forwarding on (to `to`) or
 * off. The page saves by itself a moment after a change and says so.
 */
async function setForward(page, to) {
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Out of office', exact: true }).first().click();
  const reply = page.getByRole('switch', { name: 'Reply automatically' });
  const forward = page.getByRole('switch', { name: 'Forward messages' });
  await expect(forward).toBeVisible({ timeout: 30_000 });
  let changed = false;
  if ((await reply.getAttribute('aria-checked')) === 'true') { await reply.click(); changed = true; }
  if ((await forward.getAttribute('aria-checked')) !== String(!!to)) { await forward.click(); changed = true; }
  if (to) { await page.getByLabel('Forward to').fill(to); changed = true; }
  if (!changed) return;
  // The page saves a moment later (each change on its own): wait until the
  // server's filters say what was chosen.
  const on = (text) => /"vacationForward":\{"enabled":true/.test(text);
  const done = await eventually(() => sieveText(), (text) => (to ? on(text) && text.includes(`"to":"${to}"`) : !on(text)), { timeout: 60_000 });
  expect(to ? on(done) : !on(done), 'the forward reached the server').toBe(true);
}

test('the out-of-office stays off while it forwards mail', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  let forwarding = false;
  try {
    const tag = runTag();
    await setVacation({ isEnabled: false });
    const subject = await seedNote(tag);
    await mockScript('c-ooo-forward', [
      { text: 'Setting it.', tools: [{ name: 'set_vacation', input: { subject: `Away ${tag}`, text: 'Back on Monday.' } }] },
      { text: 'Result: {{tool_results}}' },
    ]);
    await setUp(page, api, test);
    await turnOnActions(page, ['Out-of-office reply']);
    // The user sets a forward to another of their addresses in the app itself.
    await setForward(page, PEER);
    forwarding = true;

    await page.getByRole('link', { name: 'Mail' }).first().click();
    const frame = await panelFor(page, subject);
    await ask(frame, '[[mock:c-ooo-forward]] set my out-of-office');
    await acceptPrivacy(page, { frame });
    await waitDone(frame);
    await expect(card(frame, 'set_vacation')).toHaveAttribute('data-action-state', 'failed');
    await expect(frame.getByText('Your out-of-office forwards mail. Change it in Settings > Out of office.').last()).toBeVisible();
    await expect(card(frame, 'set_vacation').getByRole('button', { name: 'Do it' })).toHaveCount(0);
    const now = await vacation();
    expect(now.isEnabled).toBe(false);
    expect(now.subject).not.toBe(`Away ${tag}`);
  } finally {
    if (forwarding) await setForward(page, null).catch(() => {});
    await setVacation({ isEnabled: false }).catch(() => {});
    await uninstallPlugin(api, ID);
  }
});
