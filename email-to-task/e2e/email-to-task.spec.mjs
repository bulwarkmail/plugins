// End to end: the plugin in the running webmail, against Vikunja, the
// Todoist mock, Donetick, Stalwart's CalDAV task list and Stalwart's own tasks.
//
// Each test imports its own messages into alice's inbox over JMAP (so the
// seeded mail other plugins rely on stays untouched), creates tasks through
// the UI, checks them in the service and removes them again.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { BASE, REPO, adminApi, installPlugin, preparePage, setPluginConfig, shoot, signIn, uninstallPlugin, waitForPlugin } from '../../e2e/helpers.mjs';

const ID = 'email-to-task';
/** A seed's secrets file: this checkout's test-env first, then the shared rig's. */
function secrets(name) {
  const found = [
    path.join(REPO, 'test-env', '.secrets', `${name}.json`),
    `C:/Users/info/worktrees/plugins-audit/test-env/.secrets/${name}.json`,
  ].find((p) => fs.existsSync(p));
  if (!found) throw new Error(`test-env/.secrets/${name}.json not found; run test-env/up`);
  return JSON.parse(fs.readFileSync(found, 'utf8'));
}
const vikunjaSecrets = secrets('vikunja');
const caldavSecrets = secrets('caldav');
const donetickSecrets = secrets('donetick');
const STALWART = 'http://localhost:18025';
const VIKUNJA = 'http://localhost:18456';
const TODOIST = 'http://localhost:18099/todoist/api/v1';
const DONETICK = 'http://localhost:18021';
const ALICE = 'Basic ' + Buffer.from('alice@example.org:test-pass-123').toString('base64');
const RUN = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });

// ─── Service helpers ──────────────────────────────────────────

async function jmap(methodCalls, using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']) {
  const res = await fetch(`${STALWART}/jmap/`, {
    method: 'POST',
    headers: { Authorization: ALICE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (!res.ok) throw new Error(`JMAP HTTP ${res.status}`);
  return (await res.json()).methodResponses;
}

async function accountAndInbox() {
  const session = await (await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: ALICE } })).json();
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const [[, boxes]] = await jmap([['Mailbox/get', { accountId, properties: ['role'] }, '0']]);
  return { accountId, inbox: boxes.list.find((b) => b.role === 'inbox').id };
}

/** Put a message into alice's inbox; resolves to its id. */
async function importMail({ subject, body, from = 'Carol <carol@example.org>', date = new Date() }) {
  const { accountId, inbox } = await accountAndInbox();
  const [, name, email] = /^(.*?)\s*<(.+)>$/.exec(from);
  // Email/set rather than an upload: the blob upload quota is shared with
  // every other test run on this account.
  const [[, result]] = await jmap([['Email/set', { accountId, create: { m: {
    mailboxIds: { [inbox]: true },
    keywords: {},
    from: [{ name, email }],
    to: [{ name: 'Alice', email: 'alice@example.org' }],
    subject,
    receivedAt: date.toISOString(),
    sentAt: date.toISOString(),
    messageId: [`${RUN}.${Math.random().toString(36).slice(2)}@e2t.test`],
    bodyValues: { b: { value: body } },
    textBody: [{ partId: 'b', type: 'text/plain' }],
  } } }, '0']]);
  if (!result.created?.m) throw new Error(`import failed: ${JSON.stringify(result)}`);
  return result.created.m.id;
}

async function emailKeywords(id) {
  const { accountId } = await accountAndInbox();
  const [[, r]] = await jmap([['Email/get', { accountId, ids: [id], properties: ['keywords'] }, '0']]);
  return r.list[0]?.keywords ?? {};
}

async function destroyMail(ids) {
  const { accountId } = await accountAndInbox();
  await jmap([['Email/set', { accountId, destroy: ids }, '0']]).catch(() => {});
}

async function vikunja(path, init = {}) {
  const res = await fetch(`${VIKUNJA}/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${vikunjaSecrets.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  return res.status === 204 ? null : res.json();
}

async function todoist(path, init = {}) {
  const res = await fetch(`${TODOIST}${path}`, { ...init, headers: { Authorization: 'Bearer test-todoist-token', 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  return res.status === 204 ? null : res.json();
}

/** The VTODOs in alice's CalDAV task list: [{ href, ics }]. */
async function caldavTasks() {
  const res = await fetch(caldavSecrets.taskList, {
    method: 'REPORT',
    headers: { Authorization: ALICE, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>',
  });
  const xml = await res.text();
  return [...xml.matchAll(/<D:response><D:href>([^<]+)<\/D:href>[\s\S]*?calendar-data>([\s\S]*?)<\//g)].map((m) => ({ href: m[1], ics: m[2] }));
}

async function donetick(path, init = {}) {
  const res = await fetch(`${DONETICK}/eapi/v1${path}`, { ...init, headers: { secretkey: donetickSecrets.token, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`Donetick ${path}: HTTP ${res.status}`);
  return res.json();
}

async function bulwarkTasks() {
  const { accountId } = await accountAndInbox();
  const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'];
  const [, [, got]] = await jmap([
    ['CalendarEvent/query', { accountId }, 'q'],
    ['CalendarEvent/get', { accountId, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' }, properties: ['@type', 'title', 'due', 'priority', 'description'] }, 'g'],
  ], using);
  return { list: got.list.filter((e) => e['@type'] === 'Task'), destroy: (ids) => jmap([['CalendarEvent/set', { accountId, destroy: ids }, '0']], using) };
}

// ─── UI helpers ───────────────────────────────────────────────

async function startApp(page, admin, theme = 'light') {
  await preparePage(page, { theme });
  await signIn(page);
  await waitForPlugin(page, ID);
  // alice's theme is synced from the server and other test runs change it;
  // pin the look for the screenshots (dialogs copy the page's theme when they open).
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
  // Admin-enabled plugins with mail permissions ask once.
  const allow = page.getByRole('button', { name: 'Allow', exact: true });
  if (await allow.isVisible({ timeout: 3000 }).catch(() => false)) await allow.click();
}

/** The dialog's iframe (the plugin-dialog slot) as a frame locator. */
function dialogFrame(page) {
  return page.frameLocator('iframe[title*="email-to-task"][title*="plugin-dialog"], div[role="dialog"] iframe').first();
}

async function openMessage(page, subject) {
  const row = page.getByText(subject, { exact: true }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  // The left end: the row's hover buttons sit over the right part of the text.
  await row.click({ position: { x: 4, y: 4 } });
  await expect(page.getByRole('heading', { name: subject }).first()).toBeVisible({ timeout: 30_000 });
}

/** A toast. The host also repeats it in a screen-reader live region, so look in the toast list. */
function toast(page, text) {
  return page.getByRole('region', { name: 'Notifications' }).getByText(text);
}

/** A button in the dialog's footer, which the host draws for the plugin. */
function footerButton(page, name) {
  return page.locator('[data-plugin-dialog-buttons]').getByRole('button', { name, exact: true });
}

/** The plugin's button in the open message's toolbar. */
function readerButton(page) {
  return page.locator('[data-plugin-actions="reader-actions"]').getByRole('button', { name: 'Create task' }).first();
}

/** Connect an account through the host's own dialog. */
async function connectInHost(page, { server, username, secret }) {
  const box = page.getByRole('dialog').filter({ has: page.locator('input[type="password"]') });
  await expect(box).toBeVisible();
  if (server !== undefined) {
    const serverInput = box.locator('input[inputmode="url"]');
    if (await serverInput.count()) await serverInput.fill(server);
  }
  if (username !== undefined) await box.locator('input[autocomplete="username"]').fill(username);
  await box.locator('input[type="password"]').fill(secret);
  await box.locator('button[type="submit"]').click();
  await expect(box).toBeHidden();
}

async function disconnectAll(page) {
  for (const credential of ['vikunja', 'todoist', 'caldav', 'donetick']) {
    await page.request.delete(`${BASE}/api/plugin-secrets?plugin=${ID}&credential=${credential}`).catch(() => {});
  }
}

// ─── Tests ────────────────────────────────────────────────────

let admin;

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  admin = await adminApi();
  // The plugin registry is shared with other test runs; a write that loses a race answers 500.
  for (let attempt = 0; ; attempt++) {
    try {
      await installPlugin(admin, ID);
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
    }
  }
  await setPluginConfig(admin, ID, 'vikunjaUrl', VIKUNJA);
  await setPluginConfig(admin, ID, 'todoistApiUrl', TODOIST);
  await setPluginConfig(admin, ID, 'caldavUrl', `${STALWART}/`);
  await setPluginConfig(admin, ID, 'donetickUrl', DONETICK);
});

test.afterAll(async () => {
  if (admin) {
    await uninstallPlugin(admin, ID);
    await admin.dispose();
  }
});

test('reader: a message becomes a Vikunja task with a link back, and the row gets a badge', async ({ page }) => {
  const subject = `Re: Quarterly report ${RUN}`;
  const emailId = await importMail({ subject, body: 'Hi Alice,\n\ncould you send me the quarterly report by Friday?\n\nThanks, Carol' });
  let taskId = null;
  try {
    await startApp(page, admin);
    await disconnectAll(page);
    await openMessage(page, subject);

    await readerButton(page).click();
    const frame = dialogFrame(page);
    await expect(frame.getByLabel('Title')).toHaveValue(`Quarterly report ${RUN}`);
    await expect(frame.getByText('Found in the message: “by Friday”')).toBeVisible();
    await frame.getByLabel('Add to').selectOption('vikunja');
    await frame.getByRole('button', { name: 'Connect Vikunja' }).click();
    // The administrator's Vikunja address is suggested; the user adds the token.
    await expect(page.getByRole('dialog').locator('input[inputmode="url"]')).toHaveValue(VIKUNJA);
    await connectInHost(page, { secret: vikunjaSecrets.token });

    await frame.getByLabel('Project').selectOption({ label: vikunjaSecrets.project });
    await frame.getByLabel('Priority').selectOption('high');
    // One surface: the buttons sit in the host's footer, none in the frame.
    await expect(frame.getByRole('button', { name: 'Create task' })).toHaveCount(0);
    await shoot(page, ID, 'dialog', 'light');
    await footerButton(page, 'Create task').click();
    await expect(toast(page, 'Task created in Vikunja')).toBeVisible();

    const tasks = await vikunja(`/projects/${vikunjaSecrets.projectId}/tasks?s=${encodeURIComponent(RUN)}`);
    const task = tasks.find((x) => x.title === `Quarterly report ${RUN}`);
    expect(task).toBeTruthy();
    taskId = task.id;
    expect(task.priority).toBe(3);
    expect(task.description).toContain(`/mail/message/${emailId}`);
    expect(task.description).toContain('quarterly report by Friday');
    const due = new Date(task.due_date);
    expect(due.getDay()).toBe(5);

    // The message got the keyword, so the list shows the badge.
    expect(await emailKeywords(emailId)).toMatchObject({ $task: true });
    const row = page.locator('[data-email-id], [role="option"], li, div').filter({ hasText: subject }).filter({ has: page.getByTestId('plugin-row-badges') }).first();
    await expect(row.getByTestId('plugin-row-badges')).toContainText('Task');
    await shoot(page, ID, 'badge', 'light');

    // Asking again for the same message says there is a task already.
    await readerButton(page).click();
    await expect(frame.getByText(`This message already has a task in Vikunja: “Quarterly report ${RUN}”.`)).toBeVisible();
    await footerButton(page, 'Cancel').click();
    await expect(page.getByRole('dialog')).toBeHidden();
  } finally {
    if (taskId) await vikunja(`/tasks/${taskId}`, { method: 'DELETE' });
    await disconnectAll(page).catch(() => {});
    await destroyMail([emailId]);
  }
});

test('reader: a message becomes a Donetick chore with its due date and a link back', async ({ page }) => {
  const subject = `Server invoice ${RUN}`;
  const emailId = await importMail({ subject, body: 'Hello Alice,\n\nplease pay the server invoice by 2026-11-20.\n\nThanks, Carol' });
  let choreId = null;
  try {
    await startApp(page, admin);
    await disconnectAll(page);
    await openMessage(page, subject);

    await readerButton(page).click();
    const frame = dialogFrame(page);
    await expect(frame.getByLabel('Due date')).toHaveValue('2026-11-20');
    await frame.getByLabel('Add to').selectOption('donetick');
    await frame.getByRole('button', { name: 'Connect Donetick' }).click();
    // The administrator's Donetick address is suggested; the user adds the token.
    await expect(page.getByRole('dialog').locator('input[inputmode="url"]')).toHaveValue(DONETICK);
    await connectInHost(page, { secret: donetickSecrets.token });

    // Donetick's API has no projects and no priority, so neither is asked for.
    await expect(frame.getByLabel('Title')).toHaveValue(subject);
    await expect(frame.getByLabel('Priority')).toHaveCount(0);
    await expect(frame.getByLabel('Project')).toHaveCount(0);
    await footerButton(page, 'Create task').click();
    await expect(toast(page, 'Task created in Donetick')).toBeVisible();

    const chore = (await donetick('/chore')).find((c) => c.name === subject);
    expect(chore).toBeTruthy();
    choreId = chore.id;
    expect(chore.description).toContain(`/mail/message/${emailId}`);
    expect(chore.description).toContain('server invoice by 2026-11-20');
    const due = new Date(chore.nextDueDate);
    expect([due.getFullYear(), due.getMonth() + 1, due.getDate(), due.getHours()]).toEqual([2026, 11, 20, 12]);
    expect(await emailKeywords(emailId)).toMatchObject({ $task: true });

    // Asking again links to the chore in Donetick.
    await readerButton(page).click();
    await expect(frame.getByText(`This message already has a task in Donetick: “${subject}”.`)).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Open task' })).toBeVisible();
    await footerButton(page, 'Cancel').click();
    await expect(page.getByRole('dialog')).toBeHidden();
  } finally {
    // By name too: a run that failed early may have made the chore without reading it back.
    const ids = choreId ? [choreId] : (await donetick('/chore').catch(() => [])).filter((c) => c.name === subject).map((c) => c.id);
    for (const id of ids) await donetick(`/chore/${id}`, { method: 'DELETE' }).catch(() => {});
    await disconnectAll(page).catch(() => {});
    await destroyMail([emailId]);
  }
});

test('row menu: a German message becomes a Todoist task with its German deadline', async ({ page }) => {
  const subject = `Angebot prüfen ${RUN}`;
  const emailId = await importMail({ subject, from: 'Jana Becker <jana@example.de>', body: 'Hallo,\n\nbitte prüfen Sie das Angebot bis zum 30.10.2026.\n\nViele Grüße\nJana' });
  let created = [];
  try {
    await startApp(page, admin, 'dark');
    await disconnectAll(page);
    const row = page.getByText(subject, { exact: true }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    // The left end: the row's hover buttons sit over the right part of the text.
    await row.click({ button: 'right', position: { x: 4, y: 4 } });
    await page.getByRole('menuitem', { name: 'Create task' }).click();

    const frame = dialogFrame(page);
    await expect(frame.getByLabel('Due date')).toHaveValue('2026-10-30');
    await frame.getByLabel('Add to').selectOption('todoist');
    await frame.getByRole('button', { name: 'Connect Todoist' }).click();
    await connectInHost(page, { secret: 'test-todoist-token' });
    await expect(frame.getByLabel('Project')).toHaveValue('6Xt00000000inbox');
    await frame.getByLabel('Then').selectOption('read');
    await shoot(page, ID, 'dialog', 'dark');
    // Todoist refuses the first try: the dialog says so in plain words and
    // keeps everything filled in, so the second try goes through.
    const isCreate = (url) => url.pathname.endsWith('/api/plugin-proxy') && /\/tasks$/.test(url.searchParams.get('url') ?? '');
    await page.route(isCreate, (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"invalid argument"}' }), { times: 1 });
    await footerButton(page, 'Create task').click();
    await expect(frame.getByRole('alert').filter({ hasText: 'Todoist' })).toHaveText('Todoist did not accept the task. Check the title and the due date.');
    await shoot(page, ID, 'error', 'dark');
    await page.unroute(isCreate);
    await footerButton(page, 'Create task').click();
    await expect(toast(page, 'Task created in Todoist')).toBeVisible();

    const { results } = await todoist('/tasks');
    created = results.filter((x) => x.content === subject);
    expect(created).toHaveLength(1);
    expect(created[0].due.date).toBe('2026-10-30');
    expect(created[0].description).toContain(`/mail/message/${emailId}`);
    const keywords = await emailKeywords(emailId);
    expect(keywords.$seen).toBe(true);
    expect(keywords.$task).toBeUndefined();
  } finally {
    for (const x of created) await todoist(`/tasks/${x.id}`, { method: 'DELETE' });
    await disconnectAll(page).catch(() => {});
    await destroyMail([emailId]);
  }
});

test('selection toolbar: two messages become two tasks in the CalDAV task list', async ({ page }) => {
  const subjects = [`Slides for Thursday ${RUN}`, `Contract draft ${RUN}`];
  const ids = [
    await importMail({ subject: subjects[0], body: 'Please send me the slides by tomorrow.' }),
    await importMail({ subject: subjects[1], body: 'Comments until 2026-11-02 please.', from: 'Bob <bob@example.org>' }),
  ];
  let hrefs = [];
  try {
    await startApp(page, admin);
    await disconnectAll(page);
    for (const s of subjects) await expect(page.getByText(s, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    // Select both rows (Ctrl+click), then use the selection toolbar.
    await page.getByText(subjects[0], { exact: true }).first().click({ modifiers: ['Control'], position: { x: 4, y: 4 } });
    await page.getByText(subjects[1], { exact: true }).first().click({ modifiers: ['Control'], position: { x: 4, y: 4 } });
    // A narrow list keeps plugin actions behind the toolbar's "More actions".
    const bulk = page.locator('[data-plugin-actions="message-bulk-actions"]').first();
    await expect(bulk).toBeVisible();
    if (await bulk.getAttribute('data-plugin-actions-overflow') !== null) {
      await bulk.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Create tasks' }).click();
    } else {
      await bulk.getByRole('button', { name: 'Create tasks' }).click();
    }

    const frame = dialogFrame(page);
    await frame.getByLabel('Add to').selectOption('caldav');
    await frame.getByRole('button', { name: 'Connect CalDAV' }).click();
    await connectInHost(page, { username: caldavSecrets.user, secret: caldavSecrets.password });
    await expect(frame.getByLabel('Task list')).toHaveValue(caldavSecrets.taskList);
    await expect(frame.getByLabel(`Due date for “${subjects[1]}”`)).toHaveValue('2026-11-02');
    await shoot(page, ID, 'bulk', 'light');
    await footerButton(page, 'Create 2 tasks').click();
    await expect(toast(page, '2 tasks created in CalDAV')).toBeVisible();

    const mine = (await caldavTasks()).filter((x) => x.ics.includes(RUN));
    hrefs = mine.map((x) => x.href);
    expect(mine).toHaveLength(2);
    const contract = mine.find((x) => x.ics.includes('Contract draft'));
    expect(contract.ics).toContain('DUE;VALUE=DATE:20261102');
    expect(contract.ics.replace(/\r\n /g, '')).toContain(`/mail/message/${ids[1]}`);
  } finally {
    for (const href of hrefs) await fetch(new URL(href, STALWART), { method: 'DELETE', headers: { Authorization: ALICE } });
    await disconnectAll(page).catch(() => {});
    await destroyMail(ids);
  }
});

test('keyboard: Alt+Shift+T puts the open message into Bulwark tasks on the mail server', async ({ page }) => {
  const subject = `Pay the ACME invoice ${RUN}`;
  const emailId = await importMail({ subject, body: 'Invoice attached. Payment due 2026-11-15.', from: 'ACME <billing@acme.example>' });
  const other = `Lunch on Friday ${RUN}`;
  const otherId = await importMail({ subject: other, body: 'Shall we have lunch?', date: new Date(Date.now() - 60_000) });
  let mine = [];
  let tasks;
  try {
    await startApp(page, admin);
    await openMessage(page, subject);
    const frame = dialogFrame(page);
    // The shortcut reaches the plugin once it has seen the message open, and
    // only from the page itself, not from inside the message body's frame.
    await expect(async () => {
      await page.getByRole('heading', { name: subject }).first().click();
      await page.keyboard.press('Alt+Shift+T');
      try {
        await expect(frame.getByLabel('Add to')).toBeVisible({ timeout: 3000 });
      } catch (err) {
        // The plugin can miss the message opening while it is still starting
        // up ("Open a message first"): open another one and this one again.
        await openMessage(page, other);
        await openMessage(page, subject);
        throw err;
      }
    }).toPass({ timeout: 45_000 });
    await expect(frame.getByLabel('Add to')).toBeVisible();
    // Stalwart keeps tasks in its calendars, so the target is offered and needs no account.
    await frame.getByLabel('Add to').selectOption('bulwark');
    await expect(frame.getByLabel('Due date')).toHaveValue('2026-11-15');
    await footerButton(page, 'Create task').click();
    await expect(toast(page, 'Task created in Tasks (Bulwark)')).toBeVisible();
    tasks = await bulwarkTasks();
    mine = tasks.list.filter((x) => x.title === subject);
    expect(mine).toHaveLength(1);
    expect(String(mine[0].due)).toMatch(/^2026-11-15/);
  } finally {
    if (tasks && mine.length) await tasks.destroy(mine.map((x) => x.id));
    await destroyMail([emailId, otherId]);
  }
});
