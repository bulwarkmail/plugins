import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import {
  BASE, USER, PASSWORD, adminApi, installPlugin, setPluginConfig, preparePage, signIn, waitForPlugin,
} from '../../e2e/helpers.mjs';
import { makePdf } from '../test/helpers.mjs';

// Against a webmail signed in to a Stalwart server (JMAP_URL, default the
// VM 106 test server) with BULWARK_USER / BULWARK_PASSWORD. The test puts
// two invoices into the user's Inbox over JMAP: a ZUGFeRD PDF and an
// XRechnung XML. ACCOUNTING_ADDRESS gets the forwards.

const PLUGIN = 'e-invoice';
const JMAP_URL = process.env.JMAP_URL || 'https://stalwart-1.internal.bulwarkmail.org';
const ACCOUNTING = process.env.ACCOUNTING_ADDRESS || 'userb@example.org';
const SLOT = `iframe[title="plugin-${PLUGIN}-slot"]`;
const RUN = Date.now().toString(36);
const fixture = (name) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8');

// ─── JMAP, as the test user ───────────────────────────────────

const auth = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
let session = null;

async function connect() {
  if (session) return session;
  const res = await fetch(`${JMAP_URL}/.well-known/jmap`, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`JMAP session: HTTP ${res.status}`);
  session = await res.json();
  session.accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  return session;
}

async function jmap(calls) {
  await connect();
  const res = await fetch(session.apiUrl, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: calls }),
  });
  if (!res.ok) throw new Error(`JMAP: HTTP ${res.status}`);
  return (await res.json()).methodResponses;
}

async function mailboxId(role) {
  const { accountId } = await connect();
  const [[, { list }]] = await jmap([['Mailbox/get', { accountId, properties: ['role'] }, '0']]);
  return list.find((m) => m.role === role).id;
}

/** Put a message with these attachments into the Inbox. */
async function deliver(subject, attachments) {
  await connect();
  const boundary = `b-${RUN}`;
  const lines = [
    'From: Musterlieferant GmbH <rechnung@musterlieferant.example>',
    `To: ${USER}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${RUN}-${Math.random().toString(36).slice(2)}@musterlieferant.example>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Guten Tag, anbei unsere Rechnung.',
  ];
  for (const a of attachments) {
    lines.push(`--${boundary}`, `Content-Type: ${a.type}; name="${a.name}"`, `Content-Disposition: attachment; filename="${a.name}"`, 'Content-Transfer-Encoding: base64', '');
    lines.push(...Buffer.from(a.data).toString('base64').match(/.{1,76}/g));
  }
  lines.push(`--${boundary}--`, '');
  const raw = lines.join('\r\n');
  const upload = await fetch(session.uploadUrl.replace('{accountId}', session.accountId), {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'message/rfc822' }, body: raw,
  });
  const { blobId } = await upload.json();
  const inbox = await mailboxId('inbox');
  const [[name, result]] = await jmap([['Email/import', {
    accountId: session.accountId,
    emails: { m: { blobId, mailboxIds: { [inbox]: true }, keywords: {}, receivedAt: new Date().toISOString() } },
  }, '0']]);
  if (name !== 'Email/import' || !result.created?.m) throw new Error(`Import failed: ${JSON.stringify(result)}`);
  return result.created.m.id;
}

/** The newest message with exactly this subject (Stalwart's subject search splits on punctuation). */
async function emailWithSubject(subject) {
  const { accountId } = await connect();
  const [, [, { list }]] = await jmap([
    ['Email/query', { accountId, sort: [{ property: 'receivedAt', isAscending: false }], limit: 30 }, 'q'],
    ['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'to', 'attachments', 'keywords', 'mailboxIds'] }, 'g'],
  ]);
  return list.find((e) => e.subject === subject) || null;
}

// ─── The webmail ──────────────────────────────────────────────

async function openMessage(page, subject) {
  const row = page.getByText(subject, { exact: true }).first();
  try {
    await expect(row).toBeVisible({ timeout: 30_000 });
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(row).toBeVisible({ timeout: 60_000 });
  }
  await row.click({ position: { x: 4, y: 4 } });
}

/** The plugin's frame that shows `text`. */
async function frameWith(page, text) {
  await expect.poll(async () => {
    for (const f of page.frames()) {
      if (await f.getByText(text, { exact: false }).count().catch(() => 0)) return true;
    }
    return false;
  }, { timeout: 60_000 }).toBe(true);
  for (const f of page.frames()) {
    if (await f.getByText(text, { exact: false }).count().catch(() => 0)) return f;
  }
  return null;
}

const pdf = makePdf([{ name: 'factur-x.xml', content: fixture('zugferd-cii.xml') }]);
const SUBJECT_PDF = `Rechnung RE-2026-117 (${RUN})`;
const SUBJECT_XML = `XRechnung RE-2026-117 (${RUN})`;

test.beforeAll(async () => {
  const admin = await adminApi();
  await installPlugin(admin, PLUGIN);
  await setPluginConfig(admin, PLUGIN, 'accountingAddress', ACCOUNTING);
  await deliver(SUBJECT_PDF, [{ name: 'Rechnung-RE-2026-117.pdf', type: 'application/pdf', data: pdf }]);
  await deliver(SUBJECT_XML, [{ name: 'RE-2026-117.xml', type: 'application/xml', data: Buffer.from(fixture('xrechnung-ubl.xml')) }]);
});

test('shows a ZUGFeRD invoice, prints it and forwards it to accounting after one question', async ({ page }) => {
  await preparePage(page);
  // Record what the host prints: its hidden print frame, before it goes.
  await page.addInitScript(() => {
    window.__printed = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.tagName === 'IFRAME' && n.srcdoc) window.__printed.push({ sandbox: n.getAttribute('sandbox'), srcdoc: n.srcdoc });
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await signIn(page);
  await waitForPlugin(page, PLUGIN);
  await openMessage(page, SUBJECT_PDF);

  const banner = await frameWith(page, 'Invoice RE-2026-117 from Musterlieferant GmbH');
  await expect(banner.getByText('ZUGFeRD / Factur-X · EN 16931')).toBeVisible();
  await expect(banner.getByText(/€846\.00, due /)).toBeVisible();
  await page.screenshot({ path: `test-results/e-invoice-banner-${RUN}.png` });

  // The readable invoice.
  await banner.getByRole('button', { name: 'Show invoice' }).click();
  const view = page.frameLocator(SLOT).last();
  await expect(view.getByRole('table', { name: 'Items' })).toBeVisible({ timeout: 30_000 });
  await expect(view.getByRole('row', { name: /Beratung/ })).toBeVisible();
  await expect(view.getByText('The sums add up.', { exact: false })).toBeVisible();
  await expect(view.getByText('DE02 1203 0000 0000 2020 51')).toBeVisible();
  await page.screenshot({ path: `test-results/e-invoice-dialog-${RUN}.png` });

  // Print: the host prints a sanitised copy from a frame that runs no scripts.
  const footer = page.locator('[data-plugin-dialog-buttons]').last();
  await footer.getByRole('button', { name: 'Print', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printed.length)).toBe(1);
  const printed = (await page.evaluate(() => window.__printed))[0];
  expect(printed.sandbox).toBe('allow-same-origin allow-modals');
  expect(printed.srcdoc).toContain('<h1>Invoice RE-2026-117</h1>');
  expect(printed.srcdoc).toContain("default-src 'none'");

  // Forward: Bulwark asks once for the new address.
  await footer.getByRole('button', { name: 'Forward to accounting', exact: true }).click();
  const ask = page.getByRole('dialog').filter({ hasText: `forward mail to ${ACCOUNTING}` });
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask).toContainText(SUBJECT_PDF);
  await page.screenshot({ path: `test-results/e-invoice-approval-${RUN}.png` });
  await ask.getByRole('button', { name: 'Allow and forward' }).click();
  await expect(view.getByText(`Forwarded to ${ACCOUNTING} on`, { exact: false })).toBeVisible({ timeout: 60_000 });

  // The forward is in Sent with the PDF, and the original is marked.
  await expect.poll(() => emailWithSubject(`Fwd: ${SUBJECT_PDF}`), { timeout: 60_000 }).not.toBeNull();
  const sent = await emailWithSubject(`Fwd: ${SUBJECT_PDF}`);
  expect(sent.to.map((a) => a.email)).toEqual([ACCOUNTING]);
  expect(sent.attachments.map((a) => a.name)).toEqual(['Rechnung-RE-2026-117.pdf']);
  await expect.poll(async () => (await emailWithSubject(SUBJECT_PDF))?.keywords || {}).toMatchObject({ $forwarded: true, $einvoice: true });
  await footer.getByRole('button', { name: 'Close', exact: true }).click();

  // An XRechnung XML, forwarded from the bar: no second question for the same address.
  await openMessage(page, SUBJECT_XML);
  const xmlBanner = await frameWith(page, 'XRechnung 3.0 (UBL)');
  await xmlBanner.getByRole('button', { name: 'Forward to accounting' }).click();
  await expect(xmlBanner.getByText(`Forwarded to ${ACCOUNTING} on`, { exact: false })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('dialog').filter({ hasText: 'forward mail to' })).toHaveCount(0);
  await expect.poll(() => emailWithSubject(`Fwd: ${SUBJECT_XML}`), { timeout: 60_000 }).not.toBeNull();

  // Settings > Add-ons lists the address.
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Add-ons', exact: true }).first().click();
  await page.getByText('E-Invoices', { exact: true }).first().click();
  await expect(page.getByText('Forwards mail to')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(ACCOUNTING, { exact: true })).toBeVisible();
  await page.screenshot({ path: `test-results/e-invoice-settings-${RUN}.png` });
});
